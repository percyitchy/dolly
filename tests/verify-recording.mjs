#!/usr/bin/env node
// Checks A10, A11 and A12 of SPEC section 11 on a real recording and its export.
//   node tests/verify-recording.mjs <project dir> <exported file> [--seconds 20] [--skip a10,a11,a12] [--json <file>]
//
// A10: ffprobe on the export.
// A11: every click has a zoom, and at each click the export frame is compared with the source frame cropped
//      to the camera compose() predicts. Sliding and scaling that crop shows the match peaks where it should.
// A12: frames are compared where the recorded cursor was. A cursor in the video makes both spots change
//      as it moves away, and the rest of the screen doesn't explain the change.
//
// Exit code: 0 all passed, 1 a check failed, 2 inconclusive (say, a blank screen or a cursor that never moved).
// Needs ffmpeg and ffprobe on PATH or in /opt/homebrew/bin, and Node 22.18 or newer to load the TypeScript.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'

// compose.ts and cursor.ts are the real ones, not copies. Their imports have no file extension
registerHooks({
  resolve(specifier, context, next) {
    const bare = /^\.\.?\//.test(specifier) && !/\.\w+$/.test(specifier)
    return next(bare ? `${specifier}.ts` : specifier, context)
  }
})
process.removeAllListeners('warning')
const { compose } = await import('../src/shared/compose.ts')
const { buildCursorTrack } = await import('../src/engine/cursor.ts')

const run = promisify(execFile)
const tool = (name) => [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(existsSync) ?? name
const FFMPEG = tool('ffmpeg')
const FFPROBE = tool('ffprobe')

const MIN_NCC = 0.85
const MAX_SHIFT_PX = 2 // How far off the best alignment may be, in output px
const SEARCH_PX = 8
const SAMPLE_STEP = 3
const MIN_DETAIL = 3 // Grey-level spread. Below this a region is too flat to compare

const A12_PAIRS = 30
const A12_MIN_PAIRS = 5
const A12_MOVE_PX = 120
const A12_MAX_GAP_MS = 1000
const A12_CHANGE = 6 // Mean grey-level change that counts as something moved in a box
const A12_MAX_HITS = 0.2

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: 'string' },
    skip: { type: 'string', default: '' },
    json: { type: 'string' }
  }
})

if (positionals.length !== 2) {
  console.error('Usage: node tests/verify-recording.mjs <project dir> <exported file> [--seconds 20] [--skip a10,a11,a12] [--json <file>]')
  process.exit(2)
}

const projectDir = resolve(positionals[0])
const exported = resolve(positionals[1])
const skip = new Set(values.skip.split(',').filter(Boolean))
const results = []

function record(id, status, name, detail = '') {
  results.push({ id, status, name, detail })
  console.log(`  ${status.padEnd(12)} ${id} ${name}${detail ? `  ${detail}` : ''}`)
}

function verdict(id, ok, name, detail) {
  record(id, ok ? 'pass' : 'FAIL', name, detail)
}

function rate(text) {
  const [a, b] = text.split('/').map(Number)
  return a / (b || 1)
}

async function probeFile(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file], {
    maxBuffer: 1 << 26
  })
  const parsed = JSON.parse(stdout)
  return {
    video: parsed.streams.find((s) => s.codec_type === 'video'),
    audio: parsed.streams.find((s) => s.codec_type === 'audio'),
    format: parsed.format
  }
}

async function packetTimes(file) {
  const { stdout } = await run(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file],
    { maxBuffer: 1 << 26 }
  )
  return stdout
    .trim()
    .split('\n')
    .map((l) => parseFloat(l))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

// The first frame at or after the time. The caller aims just before the frame it wants
async function grey(file, seconds, width, height) {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-ss', Math.max(0, seconds).toFixed(6), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: width * height + 1024 }
  )
  if (stdout.length !== width * height) throw new Error(`Got ${stdout.length} bytes for a frame at ${seconds} s of ${file}`)
  return stdout
}

function bilinear(frame, width, height, x, y) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) return -1
  const fx = x - x0
  const fy = y - y0
  const i = y0 * width + x0
  const top = frame[i] * (1 - fx) + frame[i + 1] * fx
  const bottom = frame[i + width] * (1 - fx) + frame[i + width + 1] * fx
  return top * (1 - fy) + bottom * fy
}

function ncc(xs, ys, count) {
  let sx = 0
  let sy = 0
  for (let i = 0; i < count; i++) {
    sx += xs[i]
    sy += ys[i]
  }
  const mx = sx / count
  const my = sy / count
  let xy = 0
  let xx = 0
  let yy = 0
  for (let i = 0; i < count; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    xy += a * b
    xx += a * a
    yy += b * b
  }
  return { r: xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0, spread: Math.sqrt(yy / count) }
}

// What the overlays cover, so only the screen itself is compared
function overlayBoxes(spec, width, height) {
  const toOut = (p) => ({
    x: ((p.x - spec.camera.x) * width) / spec.camera.w,
    y: ((p.y - spec.camera.y) * height) / spec.camera.h
  })
  const boxes = []
  const unit = (spec.cursor?.scale ?? 1) * 3 * (width / spec.camera.w)
  if (spec.cursor) {
    const c = toOut(spec.cursor)
    boxes.push({ x0: c.x - unit * 4, y0: c.y - unit * 4, x1: c.x + unit * 20, y1: c.y + unit * 20 })
  }
  if (spec.ripple) {
    const c = toOut(spec.ripple)
    boxes.push({ x0: c.x - unit * 20, y0: c.y - unit * 20, x1: c.x + unit * 20, y1: c.y + unit * 20 })
  }
  if (spec.webcam) {
    const r = spec.webcam.rect
    const m = r.w * 0.2
    boxes.push({ x0: r.x - m, y0: r.y - m, x1: r.x + r.w + m, y1: r.y + r.h + m })
  }
  if (spec.caption) boxes.push({ x0: 0, y0: height * 0.55, x1: width, y1: height })
  return boxes
}

// Compares the export with the source seen through a camera, nudged by (dx, dy) and scaled about the middle
function alignment(target, source, spec, clip, width, height, boxes, dx, dy, zoom) {
  const scaleX = (spec.camera.w / width) * (clip.width / spec.screen.w)
  const scaleY = (spec.camera.h / height) * (clip.height / spec.screen.h)
  const originX = ((spec.camera.x - spec.screen.x) / spec.screen.w) * clip.width
  const originY = ((spec.camera.y - spec.screen.y) / spec.screen.h) * clip.height
  const xs = new Float64Array(Math.ceil((width * height) / (SAMPLE_STEP * SAMPLE_STEP)) + 4)
  const ys = new Float64Array(xs.length)
  let count = 0
  for (let y = SEARCH_PX + 1; y < height - SEARCH_PX - 1; y += SAMPLE_STEP) {
    for (let x = SEARCH_PX + 1; x < width - SEARCH_PX - 1; x += SAMPLE_STEP) {
      if (boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1)) continue
      const u = width / 2 + (x - width / 2) / zoom + dx
      const v = height / 2 + (y - height / 2) / zoom + dy
      const value = bilinear(source, clip.width, clip.height, originX + u * scaleX, originY + v * scaleY)
      if (value < 0) continue
      xs[count] = target[y * width + x]
      ys[count] = value
      count++
    }
  }
  return { ...ncc(xs, ys, count), count }
}

function shapeOf(width, height) {
  if (width > height) return '16:9'
  return width === height ? '1:1' : '9:16'
}

async function checkA10(project, info) {
  console.log('A10 export format')
  const { video, audio, format } = info
  const seconds = Number(values.seconds ?? project.durationMs / 1000)
  const fps = rate(video.avg_frame_rate)
  const frames = Number(video.nb_read_frames)
  verdict('A10', video.width === 1920 && video.height === 1080, 'dimensions', `${video.width}x${video.height}`)
  verdict('A10', Math.abs(fps - 60) < 0.02, '60 fps', fps.toFixed(3))
  verdict('A10', Math.abs(Number(format.duration) - seconds) < 1, `about ${seconds} s`, `${Number(format.duration).toFixed(3)} s, ${frames} frames`)
  verdict('A10', video.codec_name === 'h264' && video.pix_fmt === 'yuv420p', 'H.264 yuv420p', `${video.codec_name} ${video.pix_fmt}`)
  verdict('A10', audio?.codec_name === 'aac', 'AAC audio', audio ? `${audio.codec_name} ${audio.sample_rate} Hz` : 'no audio track')
}

async function checkA11(project, track, clip, sourceTimes, info) {
  console.log('A11 framing at every click')
  const width = info.video.width
  const height = info.video.height
  const fps = rate(info.video.avg_frame_rate)
  const shape = shapeOf(width, height)
  const total = Number(info.video.nb_read_frames)
  const clicks = track.clicks
  if (clicks.length === 0) return record('A11', 'inconclusive', 'the recording has no clicks')

  for (const click of clicks) {
    const label = `click at ${(click.t / 1000).toFixed(3)} s`
    const zoom = project.zooms.find((z) => z.clickMs.includes(click.t))
    verdict('A11', !!zoom, `${label} has a zoom`, zoom ? `${zoom.id}, level ${zoom.level}` : `${project.zooms.length} zooms in the project`)
    if (!zoom) continue

    const n = Math.min(total - 1, Math.round((click.t * fps) / 1000))
    const t = (n * 1000) / fps
    const spec = compose(project, track, shape, { width, height }, t, { webcam: true, captions: true })
    const inView = (spec.screen.x + (click.x / clip.width) * spec.screen.w - spec.camera.x) / spec.camera.w
    const inViewY = (spec.screen.y + (click.y / clip.height) * spec.screen.h - spec.camera.y) / spec.camera.h
    const shown = (spec.screen.h * spec.zoom) / height
    // The first 0.6 s has a shorter ease in, and an edited block can have any level or ease
    const settled = !zoom.edited && click.t - zoom.startMs >= zoom.easeInMs - 1
    verdict(
      'A11',
      inView >= 0 && inView <= 1 && inViewY >= 0 && inViewY <= 1 && (!settled || Math.abs(shown - zoom.level) < 0.02),
      `${label} is framed at ${zoom.level}x in compose()`,
      `screen is ${shown.toFixed(3)} frame heights tall, click at ${(inView * 100).toFixed(0)}%, ${(inViewY * 100).toFixed(0)}% of the view`
    )

    const target = await grey(exported, (n - 0.25) / fps, width, height)
    let nearest = 0
    const sourceSeconds = (t - clip.startMs) / 1000
    for (let i = 1; i < sourceTimes.length; i++) {
      if (Math.abs(sourceTimes[i] - sourceSeconds) < Math.abs(sourceTimes[nearest] - sourceSeconds)) nearest = i
    }
    const source = await grey(join(projectDir, clip.file), sourceTimes[nearest] - 0.0005, clip.width, clip.height)

    const boxes = overlayBoxes(spec, width, height)
    const centre = alignment(target, source, spec, clip, width, height, boxes, 0, 0, 1)
    if (centre.spread < MIN_DETAIL || centre.count < 1000) {
      record('A11', 'inconclusive', `${label} shows too little detail to compare`, `spread ${centre.spread.toFixed(1)}`)
      continue
    }
    let best = { r: -2, dx: 0, dy: 0 }
    for (let dy = -SEARCH_PX; dy <= SEARCH_PX; dy += 2) {
      for (let dx = -SEARCH_PX; dx <= SEARCH_PX; dx += 2) {
        const { r } = alignment(target, source, spec, clip, width, height, boxes, dx, dy, 1)
        if (r > best.r) best = { r, dx, dy }
      }
    }
    let bestZoom = { r: -2, zoom: 1 }
    for (const zoomFactor of [0.92, 0.96, 1, 1.04, 1.08]) {
      const { r } = alignment(target, source, spec, clip, width, height, boxes, 0, 0, zoomFactor)
      if (r > bestZoom.r) bestZoom = { r, zoom: zoomFactor }
    }
    const atRest = compose(project, track, shape, { width, height }, -1, { webcam: false, captions: false })
    const unzoomed = alignment(target, source, atRest, clip, width, height, boxes, 0, 0, 1)
    verdict(
      'A11',
      centre.r >= MIN_NCC && Math.hypot(best.dx, best.dy) <= MAX_SHIFT_PX && bestZoom.zoom === 1 && unzoomed.r < centre.r,
      `${label} matches the predicted crop`,
      `match ${centre.r.toFixed(3)} (no zoom would be ${unzoomed.r.toFixed(3)}), best shift ${best.dx},${best.dy} px, best scale ${bestZoom.zoom}`
    )
  }
}

async function checkA12(project, events, clip, sourceTimes) {
  console.log('A12 no system cursor in the screen clip')
  const file = join(projectDir, clip.file)
  const moves = events.filter((e) => e.kind === 'move' || e.kind === 'down').sort((a, b) => a.t - b.t)
  const pairs = []
  for (let i = 0, j = 0; i < moves.length; i++) {
    while (j < moves.length && (moves[j].t <= moves[i].t || Math.hypot(moves[j].x - moves[i].x, moves[j].y - moves[i].y) < A12_MOVE_PX)) {
      if (moves[j].t - moves[i].t > A12_MAX_GAP_MS) break
      j++
    }
    if (j >= moves.length) break
    const far = Math.hypot(moves[j].x - moves[i].x, moves[j].y - moves[i].y) >= A12_MOVE_PX
    if (far && moves[j].t - moves[i].t <= A12_MAX_GAP_MS) pairs.push([moves[i], moves[j]])
  }
  if (pairs.length < A12_MIN_PAIRS) {
    return record('A12', 'inconclusive', 'the cursor barely moved', `${pairs.length} usable moves, needs ${A12_MIN_PAIRS}`)
  }
  const stride = Math.max(1, Math.floor(pairs.length / A12_PAIRS))
  const chosen = pairs.filter((_, i) => i % stride === 0).slice(0, A12_PAIRS)

  const scale = (clip.scaleFactor ?? 2) / 2
  const boxW = Math.round(44 * scale)
  const boxH = Math.round(64 * scale)
  const change = (a, b, x, y) => {
    const x0 = Math.round(x - 6 * scale)
    const y0 = Math.round(y - 6 * scale)
    if (x0 < 0 || y0 < 0 || x0 + boxW >= clip.width || y0 + boxH >= clip.height) return null
    let sum = 0
    for (let row = y0; row < y0 + boxH; row++) {
      const at = row * clip.width + x0
      for (let col = 0; col < boxW; col++) sum += Math.abs(a[at + col] - b[at + col])
    }
    return sum / (boxW * boxH)
  }
  const sourceFrame = (ms) => {
    const seconds = (ms - clip.startMs) / 1000
    let nearest = 0
    for (let i = 1; i < sourceTimes.length; i++) {
      if (Math.abs(sourceTimes[i] - seconds) < Math.abs(sourceTimes[nearest] - seconds)) nearest = i
    }
    return grey(file, sourceTimes[nearest] - 0.0005, clip.width, clip.height)
  }

  let usable = 0
  let hits = 0
  for (const [from, to] of chosen) {
    const a = await sourceFrame(from.t)
    const b = await sourceFrame(to.t)
    const here = change(a, b, from.x, from.y)
    const there = change(a, b, to.x, to.y)
    if (here === null || there === null) continue
    // Two spots that are the same distance apart, nowhere near the cursor, say how busy the screen is
    const controls = [
      change(a, b, (from.x + clip.width / 2) % clip.width, (from.y + clip.height / 2) % clip.height),
      change(a, b, (to.x + clip.width / 2) % clip.width, (to.y + clip.height / 2) % clip.height)
    ].filter((v) => v !== null)
    const background = controls.length ? Math.max(...controls) : 0
    if (background >= A12_CHANGE) continue // The whole screen changed, so this pair says nothing
    usable++
    if (Math.min(here, there) >= A12_CHANGE) hits++
  }
  if (usable < A12_MIN_PAIRS) {
    return record('A12', 'inconclusive', 'the screen was too busy to tell', `${usable} usable pairs of ${chosen.length}`)
  }
  const share = hits / usable
  verdict('A12', share <= A12_MAX_HITS, 'no cursor shape follows the recorded path', `${hits} of ${usable} moves left a trace where the cursor was`)
}

async function main() {
  const project = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8'))
  const events = (await readFile(join(projectDir, 'cursor.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const clip = project.clips.find((c) => c.kind === 'screen')
  const track = buildCursorTrack(events, project.cursor)
  const needsExport = !skip.has('a10') || !skip.has('a11')
  const info = needsExport ? await probeFile(exported) : null
  const sourceTimes = await packetTimes(join(projectDir, clip.file))
  console.log(`${project.name}: ${(project.durationMs / 1000).toFixed(2)} s, ${track.clicks.length} clicks, ${project.zooms.length} zooms, ${sourceTimes.length} screen frames`)

  if (!skip.has('a10')) await checkA10(project, info)
  if (!skip.has('a11')) await checkA11(project, track, clip, sourceTimes, info)
  if (!skip.has('a12')) await checkA12(project, events, clip, sourceTimes)

  const failed = results.filter((r) => r.status === 'FAIL').length
  const unclear = results.filter((r) => r.status === 'inconclusive').length
  console.log(`\n${results.length - failed - unclear} passed, ${failed} failed, ${unclear} inconclusive`)
  if (values.json) await writeFile(values.json, JSON.stringify({ projectDir, exported, results }, null, 2))
  process.exit(failed ? 1 : unclear ? 2 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
