#!/usr/bin/env node
// End-to-end export check, in real Electron with the window hidden. No screen capture is involved.
//   node tests/export-fixture.mjs            everything
//   node tests/export-fixture.mjs --only=a,b just these jobs (see buildJobs)
//   node tests/export-fixture.mjs --long     adds a 120 s recording to show memory stays flat
//   node tests/export-fixture.mjs --no-4k    skips the 4K job, which is the heavy one
// Generated clips are kept in $DOLLY_FIXTURE_DIR (default: <tmp>/dolly-export-fixture) and reused.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, truncate, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const FFPROBE = '/opt/homebrew/bin/ffprobe'
const ELECTRON = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const WORK = process.env.DOLLY_FIXTURE_DIR ?? join(tmpdir(), 'dolly-export-fixture')
const OUT = join(WORK, 'exports')
const REVIEW = join(WORK, 'review')

const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const LONG = args.includes('--long')
const NO_4K = args.includes('--no-4k')
const run = promisify(execFile)

const TEST_THREADS = 4 // Keeps libx264 from heating the machine. The app itself uses every core
const W = 2880
const H = 1800
const FPS = 60
const CLICKS = [
  { t: 3000, x: 720, y: 540 },
  { t: 9000, x: 2160, y: 1080 },
  { t: 15000, x: 2600, y: 1600 } // Near the corner, so the camera has to clamp
]
const MARKER_GAP = 160 // Markers sit this far either side of each click, in clip px
const MARKER_SIZE = 72
const MARKER_DOT = 24 // White, in the middle of each marker. Measured by brightness, so chroma can't bias it
const STAMP_CELL = 36
const MARKED = []
const STAMPS = []
for (let j = 0; j < 5; j++) for (let i = 0; i < 8; i++) STAMPS.push({ x: 90 + i * 380, y: 90 + j * 360 })

// Synthetic screen. Every frame carries its own number as 16 black or white cells, repeated across the clip

function yuv709(r, g, b) {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  return [16 + 219 * y, 128 + 224 * ((B - y) / 1.8556), 128 + 224 * ((R - y) / 1.5748)].map(Math.round)
}

const SEGMENTS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' }

class ScreenPainter {
  constructor(width, height, markers) {
    this.w = width
    this.h = height
    this.period = 120
    this.gridRow = Buffer.alloc(width + this.period, 48)
    for (let x = 0; x < this.gridRow.length; x += this.period) this.gridRow.fill(110, x, x + 4)
    this.lineRow = Buffer.alloc(width, 110)
    this.y = Buffer.alloc(width * height)
    const cw = width / 2
    const ch = height / 2
    this.chroma = Buffer.alloc(cw * ch * 2, 128)
    this.markers = markers.map((m) => ({ ...m, yuv: yuv709(...m.rgb) }))
    for (const m of this.markers) {
      for (let row = m.y >> 1; row < (m.y + m.size) >> 1; row++) {
        this.chroma.fill(m.yuv[1], row * cw + (m.x >> 1), row * cw + ((m.x + m.size) >> 1))
        this.chroma.fill(m.yuv[2], cw * ch + row * cw + (m.x >> 1), cw * ch + row * cw + ((m.x + m.size) >> 1))
      }
      const d = (m.size - MARKER_DOT) / 2
      for (let row = (m.y + d) >> 1; row < (m.y + d + MARKER_DOT) >> 1; row++) {
        this.chroma.fill(128, row * cw + ((m.x + d) >> 1), row * cw + ((m.x + d + MARKER_DOT) >> 1))
        this.chroma.fill(128, cw * ch + row * cw + ((m.x + d) >> 1), cw * ch + row * cw + ((m.x + d + MARKER_DOT) >> 1))
      }
    }
  }

  box(x, y, w, h, value) {
    for (let row = y; row < y + h; row++) this.y.fill(value, row * this.w + x, row * this.w + x + w)
  }

  digit(x, y, value) {
    const on = SEGMENTS[value]
    const [a, b, t] = [28, 26, 6]
    if (on.includes('a')) this.box(x, y, a, t, 235)
    if (on.includes('g')) this.box(x, y + b, a, t, 235)
    if (on.includes('d')) this.box(x, y + 2 * b, a, t, 235)
    if (on.includes('f')) this.box(x, y, t, b, 235)
    if (on.includes('b')) this.box(x + a - t, y, t, b, 235)
    if (on.includes('e')) this.box(x, y + b, t, b + t, 235)
    if (on.includes('c')) this.box(x + a - t, y + b, t, b + t, 235)
  }

  paint(frame, fps, still = false) {
    const n = still ? 0 : frame
    const off = (n * 2) % this.period
    for (let row = 0; row < this.h; row++) {
      const target = row * this.w
      if ((row + off) % this.period < 4) this.lineRow.copy(this.y, target)
      else this.gridRow.copy(this.y, target, this.period - off, this.period - off + this.w)
    }
    for (const s of STAMPS) {
      if (s.x + STAMP_CELL * 4 > this.w || s.y + STAMP_CELL * 4 > this.h) continue
      for (let bit = 0; bit < 16; bit++) {
        const on = (n >> (15 - bit)) & 1
        this.box(s.x + (bit % 4) * STAMP_CELL, s.y + (bit >> 2) * STAMP_CELL, STAMP_CELL, STAMP_CELL, on ? 235 : 16)
      }
    }
    const ms = Math.round((n * 1000) / fps)
    const text = String(ms).padStart(6, '0')
    for (let i = 0; i < 6; i++) this.digit(this.w / 2 - 100 + i * 36, 16, Number(text[i]))
    for (const m of this.markers) {
      const d = (m.size - MARKER_DOT) / 2
      this.box(m.x, m.y, m.size, m.size, m.yuv[0])
      this.box(m.x + d, m.y + d, MARKER_DOT, MARKER_DOT, 235)
    }
  }
}

// A stand-in for a system cursor burned into the video: black fill, white edge, tip on the position
const ARROW = [
  [0, 0],
  [13.5, 7.7],
  [7.5, 9],
  [4.5, 14.5]
]

function insideArrow(x, y, scale) {
  let inside = false
  for (let i = 0, j = ARROW.length - 1; i < ARROW.length; j = i++) {
    const [xi, yi] = ARROW[i].map((v) => v * scale)
    const [xj, yj] = ARROW[j].map((v) => v * scale)
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const ARROW_MASK = []
for (let y = 0; y < 60; y++) {
  for (let x = 0; x < 60; x++) {
    if (insideArrow(x, y, 3.2)) ARROW_MASK.push({ x, y, value: insideArrow(x, y, 2.5) ? 16 : 235 })
  }
}

function burnCursor(painter, events, ms) {
  let at = events[0]
  for (const e of events) {
    if (e.t > ms) break
    at = e
  }
  for (const p of ARROW_MASK) {
    const px = Math.round(at.x) + p.x
    const py = Math.round(at.y) + p.y
    if (px < W && py < H) painter.y[py * W + px] = p.value
  }
}

function clickMarkers(clicks) {
  return clicks.flatMap((c) => [
    { x: c.x - MARKER_GAP - MARKER_SIZE / 2, y: c.y - MARKER_SIZE / 2, size: MARKER_SIZE, rgb: [255, 0, 255] },
    { x: c.x + MARKER_GAP - MARKER_SIZE / 2, y: c.y - MARKER_SIZE / 2, size: MARKER_SIZE, rgb: [0, 255, 0] }
  ])
}
MARKED.push(...clickMarkers(CLICKS), ...clickMarkers([{ t: 1500, x: 1000, y: 800 }]))

async function makeScreen(file, frames, options = {}) {
  if (existsSync(file)) return
  const started = Date.now()
  const painter = new ScreenPainter(W, H, clickMarkers(options.clicks ?? CLICKS))
  const fps = options.fps ?? FPS
  const proc = spawn(
    FFMPEG,
    [
      ...'-y -hide_banner -loglevel error -f rawvideo -pix_fmt yuv420p'.split(' '),
      // Tagged on the way in too, or ffmpeg 7 and later take raw input for BT.601 and convert it
      ...'-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv'.split(' '),
      ...['-video_size', `${W}x${H}`, '-framerate', String(fps), '-i', 'pipe:0'],
      ...(options.setpts ? ['-vf', `setpts=${options.setpts}`, '-fps_mode', 'vfr'] : []),
      ...'-c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -threads 4'.split(' '),
      ...'-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv'.split(' '),
      `${file}.tmp.mp4`
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  )
  const write = (chunk) => new Promise((done, fail) => proc.stdin.write(chunk, (e) => (e ? fail(e) : done())))
  for (let n = 0; n < frames; n++) {
    painter.paint(n, fps, options.still)
    if (options.burn) burnCursor(painter, options.burn, (n * 1000) / fps)
    await write(painter.y)
    await write(painter.chroma)
  }
  proc.stdin.end()
  await new Promise((done, fail) => proc.once('close', (c) => (c === 0 ? done() : fail(new Error(`ffmpeg ${c}`)))))
  await run('mv', [`${file}.tmp.mp4`, file])
  console.log(`  generated ${file} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

function cursorLog(durationMs, clicks) {
  const lines = []
  const way = [{ t: 0, x: 200, y: 200 }, ...clicks, { t: durationMs, x: 1400, y: 900 }]
  for (let i = 0; i + 1 < way.length; i++) {
    const a = way[i]
    const b = way[i + 1]
    for (let t = a.t; t < b.t; t += 16) {
      const k = (t - a.t) / (b.t - a.t)
      // Rest on the click for the last 300 ms before it, as a person would
      const eased = Math.min(1, k * ((b.t - a.t) / Math.max(1, b.t - a.t - 300)))
      lines.push({ t, x: a.x + (b.x - a.x) * eased, y: a.y + (b.y - a.y) * eased, kind: 'move' })
    }
    if (i + 1 < way.length - 1) {
      lines.push({ t: b.t, x: b.x, y: b.y, kind: 'down', button: 'left' })
      lines.push({ t: b.t + 50, x: b.x, y: b.y, kind: 'up', button: 'left' })
    }
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function zoomFor(click, i) {
  return {
    id: `z${i}`,
    startMs: click.t - 600,
    endMs: click.t + 1600,
    level: 2,
    easeInMs: 600,
    easeOutMs: 600,
    focus: { x: click.x / W, y: click.y / H },
    clickMs: [click.t],
    origin: 'auto',
    edited: false
  }
}

function projectJson(name, durationMs, clicks, extra = {}) {
  return {
    version: 1,
    id: name.toLowerCase().replaceAll(' ', '-'),
    name,
    createdAt: '2026-10-30T12:00:00.000Z',
    durationMs,
    clips: [
      { id: 's', kind: 'screen', file: 'screen.mp4', startMs: 0, durationMs, width: W, height: H, fps: FPS, scaleFactor: 2 }
    ],
    zooms: clicks.map(zoomFor),
    look: { background: { kind: 'wallpaper', id: 'dusk' }, paddingPct: 6, cornerRadiusPct: 1.2, shadow: 0.5 },
    cursor: { smooth: true, stiffness: 170, damping: 26, scale: 1, clickRipple: true },
    webcam: null,
    captions: [],
    output: { shapes: ['16:9'], format: 'mp4', resolution: '1080p', fps: 60, folder: '' },
    ...extra
  }
}

async function writeProject(dir, project, clicks) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'project.json'), JSON.stringify(project, null, 2))
  await writeFile(join(dir, 'cursor.jsonl'), cursorLog(project.durationMs, clicks))
}

async function makeFixtures() {
  console.log('Fixtures')
  const main = join(WORK, 'main.dolly')
  await mkdir(main, { recursive: true })
  await makeScreen(join(main, 'screen.mp4'), 20 * FPS)
  const mic = join(main, 'mic.webm')
  if (!existsSync(mic)) {
    const expr = `if(between(t,5,5.2)+between(t,12,12.2),0.6*sin(2*PI*1000*t),0)`
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=20`, '-c:a', 'libopus', '-b:a', '64k', mic])
  }
  await writeProject(
    main,
    projectJson('Launch demo', 20000, CLICKS, {
      clips: [
        ...projectJson('x', 20000, []).clips,
        { id: 'm', kind: 'mic', file: 'mic.webm', startMs: 250, durationMs: 19750 }
      ]
    }),
    CLICKS
  )

  // Variable frame rate with a 1 s idle gap, and a clip that starts 120 ms into the capture clock
  const vfr = join(WORK, 'vfr.dolly')
  await mkdir(vfr, { recursive: true })
  await makeScreen(join(vfr, 'screen.mp4'), 240, {
    clicks: [],
    fps: 50,
    setpts: "'(N*0.02+0.005*sin(N*1.7)+if(gte(N,100),1,0)+0.01)/TB'"
  })
  await writeProject(
    vfr,
    projectJson('Variable', 6000, [], {
      clips: [{ id: 's', kind: 'screen', file: 'screen.mp4', startMs: 120, durationMs: 5900, width: W, height: H, fps: 50, scaleFactor: 2 }]
    }),
    []
  )

  // Short project using all the Pro items
  const extras = join(WORK, 'extras.dolly')
  await mkdir(extras, { recursive: true })
  const clicks = [{ t: 1500, x: 1000, y: 800 }]
  await makeScreen(join(extras, 'screen.mp4'), 4 * FPS, { clicks })
  const webcam = join(extras, 'webcam.mp4')
  if (!existsSync(webcam)) {
    // A flat colour, tagged BT.601 as Chromium tags webcam video, to prove the right matrix gets used
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xC83C28:s=1280x720:r=30:d=4', '-vf', 'scale=out_color_matrix=bt601:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-threads', '4', '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv', webcam])
  }
  const image = join(extras, 'background.png')
  if (!existsSync(image)) {
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'gradients=s=1600x1000:c0=red:c1=yellow:x0=0:y0=0:x1=1600:y1=1000', '-frames:v', '1', image])
  }
  await writeProject(
    extras,
    projectJson('Extras', 4000, clicks, {
      clips: [
        ...projectJson('x', 4000, []).clips,
        { id: 'w', kind: 'webcam', file: 'webcam.mp4', startMs: 0, durationMs: 4000, width: 1280, height: 720, fps: 30 }
      ],
      webcam: { shape: 'circle', corner: 'br', sizePct: 22 },
      captions: [{ id: 'c1', startMs: 0, endMs: 4000, text: 'Captions stay put while the camera moves, and long lines wrap on their own.' }],
      look: { background: { kind: 'image', file: 'background.png' }, paddingPct: 6, cornerRadiusPct: 1.2, shadow: 0.5 }
    }),
    clicks
  )

  // A still screen for the A12 check, with and without a cursor burned into the video
  const stillClicks = [
    { t: 2000, x: 800, y: 600 },
    { t: 4500, x: 2000, y: 1200 }
  ]
  const clean = join(WORK, 'still-clean.dolly')
  const burned = join(WORK, 'still-burned.dolly')
  await mkdir(clean, { recursive: true })
  await mkdir(burned, { recursive: true })
  const log = cursorLog(6000, stillClicks)
  await makeScreen(join(clean, 'screen.mp4'), 6 * FPS, { clicks: [], still: true })
  await makeScreen(join(burned, 'screen.mp4'), 6 * FPS, {
    clicks: [],
    still: true,
    burn: log.trim().split('\n').map((l) => JSON.parse(l))
  })
  await writeProject(clean, projectJson('Still', 6000, stillClicks), stillClicks)
  await writeProject(burned, projectJson('Burned', 6000, stillClicks), stillClicks)

  // The main recording again, with zooms that don't match the export
  for (const [name, change] of [
    ['wrong-focus', (z) => ({ ...z, focus: { x: 0.62, y: 0.45 } })],
    ['wrong-level', (z) => ({ ...z, level: 1.75 })]
  ]) {
    const dir = join(WORK, `${name}.dolly`)
    await mkdir(dir, { recursive: true })
    if (!existsSync(join(dir, 'screen.mp4'))) await run('ln', [join(main, 'screen.mp4'), join(dir, 'screen.mp4')])
    const project = JSON.parse(await readFile(join(main, 'project.json'), 'utf8'))
    await writeProject(dir, { ...project, zooms: project.zooms.map((z, i) => (i === 1 ? change(z) : z)) }, CLICKS)
  }

  // Same again, with a video file that is cut short
  const broken = join(WORK, 'broken.dolly')
  await mkdir(broken, { recursive: true })
  await copyFile(join(extras, 'screen.mp4'), join(broken, 'screen.mp4'))
  await truncate(join(broken, 'screen.mp4'), Math.floor(statSync(join(broken, 'screen.mp4')).size / 3))
  await writeProject(broken, projectJson('Broken', 4000, clicks), clicks)

  if (LONG) {
    const long = join(WORK, 'long.dolly')
    await mkdir(long, { recursive: true })
    await makeScreen(join(long, 'screen.mp4'), 120 * FPS, { clicks: CLICKS })
    await writeProject(long, projectJson('Long', 120000, CLICKS), CLICKS)
  }
  return { main, vfr, extras, broken, clean, burned, long: join(WORK, 'long.dolly') }
}

function output(folder, shapes, resolution, fps, format = 'mp4') {
  return { shapes, format, resolution, fps, folder }
}

function buildJobs(p) {
  const pro = { webcam: true, captions: true }
  const job = (name, projectDir, out, extra = {}) => ({
    name,
    projectDir,
    output: out(join(OUT, name)),
    plan: 'pro',
    threads: TEST_THREADS,
    ...extra
  })
  const jobs = [
    job('shapes-1080p60', p.main, (f) => output(f, ['16:9', '1:1', '9:16'], '1080p', 60), { pro: undefined }),
    job('shapes-4k60', p.main, (f) => output(f, ['16:9', '1:1', '9:16'], '4k', 60), { specStride: 5 }),
    job('gif', p.main, (f) => output(f, ['16:9'], '1080p', 60, 'gif')),
    job('vfr-1080p30', p.vfr, (f) => output(f, ['16:9'], '1080p', 30)),
    job('extras-pro', p.extras, (f) => output(f, ['16:9', '9:16'], '1080p', 60), { pro }),
    job('extras-free', p.extras, (f) => output(f, ['16:9', '1:1'], '1080p', 30), { plan: 'free' }),
    job('name-collision-a', p.vfr, (f) => output(f, ['1:1'], '1080p', 30), { specStride: 1000 }),
    job('name-collision-b', p.vfr, () => output(join(OUT, 'name-collision-a'), ['1:1'], '1080p', 30), { specStride: 1000 }),
    job('refused-4k-free', p.vfr, (f) => output(f, ['16:9'], '4k', 30), { plan: 'free' }),
    job('refused-60-free', p.vfr, (f) => output(f, ['16:9'], '1080p', 60), { plan: 'free' }),
    job('refused-vertical-free', p.vfr, (f) => output(f, ['9:16'], '1080p', 30), { plan: 'free' }),
    job('refused-gif-free', p.vfr, (f) => output(f, ['16:9'], '1080p', 30, 'gif'), { plan: 'free' }),
    job('cancel', p.main, (f) => output(f, ['16:9', '1:1'], '1080p', 60), { cancelAtPct: 15 }),
    job('broken', p.broken, (f) => output(f, ['16:9'], '1080p', 60)),
    job('long-1080p60', p.long, (f) => output(f, ['16:9'], '1080p', 60), { specStride: 60 })
  ]
  const skipped = (j) => (j.name === 'long-1080p60' && !LONG) || (j.name === 'shapes-4k60' && NO_4K)
  return jobs.filter((j) => (only ? only.includes(j.name) : !skipped(j)))
}

// Watches the Electron tree. RSS, in MB, per process kind

function watchMemory(rootPid) {
  const peak = {}
  const samples = []
  let current = null
  const tick = async () => {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,comm=']).catch(() => ({ stdout: '' }))
    const rows = stdout.trim().split('\n').map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l)
      return m && { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) / 1024, cpu: Number(m[4]), comm: m[5] }
    }).filter(Boolean)
    const inTree = new Set([rootPid])
    for (let again = true; again; ) {
      again = false
      for (const r of rows) if (!inTree.has(r.pid) && inTree.has(r.ppid)) (inTree.add(r.pid), (again = true))
    }
    const totals = { main: 0, renderer: 0, gpu: 0, other: 0, ffmpeg: 0 }
    const cpu = { main: 0, renderer: 0, gpu: 0, other: 0, ffmpeg: 0 }
    for (const r of rows.filter((x) => inTree.has(x.pid))) {
      const comm = r.comm.toLowerCase()
      let kind = 'other'
      if (r.pid === rootPid) kind = 'main'
      else if (comm.endsWith('ffmpeg')) kind = 'ffmpeg'
      else if (comm.includes('renderer')) kind = 'renderer'
      else if (comm.includes('gpu')) kind = 'gpu'
      totals[kind] += r.rss
      cpu[kind] += r.cpu
    }
    const total = Object.values(totals).reduce((a, b) => a + b, 0)
    if (current) {
      const p = (peak[current] ??= { total: 0, main: 0, renderer: 0, gpu: 0, other: 0, ffmpeg: 0 })
      p.total = Math.max(p.total, total)
      for (const k of Object.keys(totals)) p[k] = Math.max(p[k], totals[k])
      samples.push({ job: current, at: Date.now(), total, ...totals, cpu })
    }
  }
  const timer = setInterval(() => void tick(), 400)
  return {
    setJob: (name) => (current = name),
    stop: () => clearInterval(timer),
    peak,
    samples
  }
}

async function runElectron(config) {
  const configFile = join(WORK, 'config.json')
  await writeFile(configFile, JSON.stringify(config))
  const child = spawn(ELECTRON, [join(ROOT, 'dist/export-test/main/index.js')], {
    env: { ...process.env, DOLLY_EXPORT_TEST_CONFIG: configFile },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const memory = watchMemory(child.pid)
  let buffered = ''
  let stderr = ''
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); if (process.env.DOLLY_FIXTURE_DEBUG) process.stderr.write(d) })
  child.stdout.on('data', (d) => {
    buffered += d
    const lines = buffered.split('\n')
    buffered = lines.pop()
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        if (e.ev === 'job-start') (memory.setJob(e.name), console.log(`  running ${e.name}`))
        if (e.ev === 'job-end') memory.setJob(null)
      } catch {
        console.log(line)
      }
    }
  })
  const code = await new Promise((done) => child.once('close', done))
  memory.stop()
  if (code !== 0 || !existsSync(config.result)) {
    throw new Error(`Electron exited with ${code}\n${stderr}`)
  }
  return { memory, stderr }
}

// Checks

const report = { pass: 0, fail: 0, failures: [] }

function check(name, ok, detail = '') {
  if (ok) report.pass++
  else {
    report.fail++
    report.failures.push(`${name} ${detail}`)
  }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

async function probe(file) {
  const { stdout } = await run(
    FFPROBE,
    ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file],
    { maxBuffer: 1 << 24 }
  )
  const parsed = JSON.parse(stdout)
  return {
    video: parsed.streams.find((s) => s.codec_type === 'video'),
    audio: parsed.streams.find((s) => s.codec_type === 'audio'),
    format: parsed.format
  }
}

function rate(text) {
  const [a, b] = text.split('/').map(Number)
  return a / (b || 1)
}

async function eachFrame(file, width, height, stride, onFrame) {
  const proc = spawn(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=not(mod(n\\,${stride}))`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  const size = width * height * 3
  const frame = Buffer.alloc(size)
  let got = 0
  let n = 0
  for await (const chunk of proc.stdout) {
    let at = 0
    while (at < chunk.length) {
      const take = Math.min(chunk.length - at, size - got)
      chunk.copy(frame, got, at, at + take)
      got += take
      at += take
      if (got === size) {
        await onFrame(n, frame)
        n += stride
        got = 0
      }
    }
  }
  return n / stride
}

function luma(frame, width, height, x, y, r = 1) {
  let sum = 0
  let count = 0
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = Math.round(x) + dx
      const py = Math.round(y) + dy
      if (px < 0 || py < 0 || px >= width || py >= height) continue
      const i = (py * width + px) * 3
      sum += 0.2126 * frame[i] + 0.7152 * frame[i + 1] + 0.0722 * frame[i + 2]
      count++
    }
  }
  return count ? sum / count : 0
}

function clipToOutput(spec, stats, x, y) {
  const cx = spec.screen.x + (x / W) * spec.screen.w
  const cy = spec.screen.y + (y / H) * spec.screen.h
  return { x: ((cx - spec.camera.x) * stats.width) / spec.camera.w, y: ((cy - spec.camera.y) * stats.height) / spec.camera.h }
}

// The number in every stamp the camera fully shows. A wrong crop or a wrong frame reads as garbage
function readStamps(frame, stats, spec, expected) {
  const values = new Map()
  const scale = ((spec.screen.w / W) * stats.width) / spec.camera.w
  const radius = Math.max(0, Math.floor((STAMP_CELL * scale) / 5))
  for (const s of STAMPS) {
    if (MARKED.some((m) => m.x < s.x + STAMP_CELL * 4 && s.x < m.x + m.size && m.y < s.y + STAMP_CELL * 4 && s.y < m.y + m.size)) continue
    const corner = clipToOutput(spec, stats, s.x, s.y)
    const far = clipToOutput(spec, stats, s.x + STAMP_CELL * 4, s.y + STAMP_CELL * 4)
    if (corner.x < 2 || corner.y < 2 || far.x > stats.width - 2 || far.y > stats.height - 2) continue
    let value = 0
    for (let bit = 0; bit < 16; bit++) {
      const cx = s.x + ((bit % 4) + 0.5) * STAMP_CELL
      const cy = s.y + ((bit >> 2) + 0.5) * STAMP_CELL
      const p = clipToOutput(spec, stats, cx, cy)
      value = (value << 1) | (luma(frame, stats.width, stats.height, p.x, p.y, radius) > 128 ? 1 : 0)
    }
    values.set(value, (values.get(value) ?? 0) + 1)
  }
  // The cursor can cover a stamp, so a frame is right when no other number outvotes the expected one
  const bestCount = Math.max(0, ...values.values())
  const hits = values.get(expected) ?? 0
  const other = [...values].find(([v, c]) => c === bestCount && v !== expected)?.[0] ?? null
  return { ok: hits > 0 && hits === bestCount, value: other ?? expected, stamps: [...values.values()].reduce((a, b) => a + b, 0), agree: hits }
}

function centroid(frame, width, height, test, around, radius) {
  let sx = 0
  let sy = 0
  let count = 0
  const x0 = Math.max(0, Math.floor(around.x - radius))
  const x1 = Math.min(width, Math.ceil(around.x + radius))
  const y0 = Math.max(0, Math.floor(around.y - radius))
  const y1 = Math.min(height, Math.ceil(around.y + radius))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 3
      if (test(frame[i], frame[i + 1], frame[i + 2])) {
        sx += x + 0.5
        sy += y + 0.5
        count++
      }
    }
  }
  return count ? { x: sx / count, y: sy / count, count } : null
}

const isDot = (r, g, b) => r > 200 && g > 200 && b > 200

// A11: at each click the two markers around it land where compose() says, at full 2.0x framing
function checkFraming(frame, stats, spec, click, label, tolerance) {
  // Other clicks' markers can be in view, so each one is only looked for near where it should be
  const wantA = clipToOutput(spec, stats, click.x - MARKER_GAP, click.y)
  const wantB = clipToOutput(spec, stats, click.x + MARKER_GAP, click.y)
  const pxPerClip = ((spec.screen.w / W) * stats.width) / spec.camera.w
  const radius = ((MARKER_SIZE / 2 - 4) * pxPerClip)
  const a = centroid(frame, stats.width, stats.height, isDot, wantA, radius)
  const b = centroid(frame, stats.width, stats.height, isDot, wantB, radius)
  if (!a || !b) return check(`${label} markers visible`, false, `left ${!!a} right ${!!b}`)
  const err = Math.max(Math.hypot(a.x - wantA.x, a.y - wantA.y), Math.hypot(b.x - wantB.x, b.y - wantB.y))
  if (process.env.DOLLY_FIXTURE_DEBUG) {
    console.log(`    left off ${(a.x - wantA.x).toFixed(2)},${(a.y - wantA.y).toFixed(2)} right off ${(b.x - wantB.x).toFixed(2)},${(b.y - wantB.y).toFixed(2)} px per clip px ${pxPerClip.toFixed(3)}`)
  }
  const measured = (b.x - a.x) / (MARKER_GAP * 2)
  const wanted = (2 * stats.height) / H // Spec: screen height on canvas = frame height x level
  const scaleErr = Math.abs(measured / wanted - 1)
  check(
    `${label} framing`,
    err <= tolerance && scaleErr <= 0.01,
    `position off by ${err.toFixed(2)} px, scale ${measured.toFixed(4)} wanted ${wanted.toFixed(4)}`
  )
  const c = clipToOutput(spec, stats, click.x, click.y)
  check(
    `${label} cursor on click`,
    Math.hypot(spec.cursor.x - (spec.screen.x + (click.x / W) * spec.screen.w), spec.cursor.y - (spec.screen.y + (click.y / H) * spec.screen.h)) * (stats.width / spec.camera.w) < 6,
    `tip at ${c.x.toFixed(1)},${c.y.toFixed(1)}`
  )
  const unit = spec.cursor.scale * 3 * (stats.width / spec.camera.w)
  const inside = luma(frame, stats.width, stats.height, c.x + 5 * unit, c.y + 5.5 * unit, Math.floor(unit / 2))
  check(`${label} arrow drawn at the tip`, inside < 45, `luma ${inside.toFixed(0)} inside the arrow`)
}

async function checkFile(stats, specs, expectedFrame, clicks, options = {}) {
  const label = `${stats.shape} ${stats.width}x${stats.height}@${stats.fps}`
  const info = await probe(stats.file)
  const seconds = stats.frames / stats.fps
  const fpsValue = rate(info.video.avg_frame_rate)
  check(`${label} dimensions`, info.video.width === stats.width && info.video.height === stats.height, `${info.video.width}x${info.video.height}`)
  check(`${label} frame count`, Number(info.video.nb_read_frames) === stats.frames, `${info.video.nb_read_frames} of ${stats.frames}`)
  // GIF delays are whole centiseconds, so only the average over the file means anything there
  const measuredFps = options.gif ? stats.frames / Number(info.format.duration) : fpsValue
  check(`${label} fps`, Math.abs(measuredFps - stats.fps) < 0.02, `${measuredFps.toFixed(3)}`)
  check(`${label} duration`, Math.abs(Number(info.format.duration) - seconds) < 0.1, `${Number(info.format.duration).toFixed(3)} s`)
  if (options.gif) {
    check(`${label} codec`, info.video.codec_name === 'gif', info.video.codec_name)
  } else {
    check(`${label} video codec`, info.video.codec_name === 'h264' && info.video.pix_fmt === 'yuv420p', `${info.video.codec_name} ${info.video.pix_fmt} ${info.video.color_space}/${info.video.color_range}`)
    if (options.audio) check(`${label} audio codec`, info.audio?.codec_name === 'aac', info.audio?.codec_name ?? 'none')
    else check(`${label} no audio`, !info.audio)
  }

  const bySpec = new Map(specs.map((s) => [s.n, s]))
  const stride = specs.length > 1 ? specs[1].n - specs[0].n : 1
  let checked = 0
  let wrong = 0
  let firstWrong = ''
  const clickFrames = new Map(clicks.map((c) => [Math.round((c.t * stats.fps) / 1000), c]))
  await eachFrame(stats.file, stats.width, stats.height, stride, (n, frame) => {
    const spec = bySpec.get(n)
    if (!spec) return
    const found = readStamps(frame, stats, spec, expectedFrame(n))
    if (found.stamps > 0) {
      checked++
      if (!found.ok) {
        wrong++
        firstWrong ||= `frame ${n}: read ${found.value}, wanted ${expectedFrame(n)}, ${found.agree}/${found.stamps} stamps agree`
      }
    }
    const click = clickFrames.get(n)
    if (click) checkFraming(frame, stats, spec, click, `${label} click at ${click.t} ms`, options.tolerance ?? 1.5)
  })
  check(`${label} every sampled frame shows the right source frame`, wrong === 0 && checked > 0, `${checked} frames read, ${wrong} wrong ${firstWrong}`)
}

async function grabFrame(file, seconds, name) {
  await mkdir(REVIEW, { recursive: true })
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', join(REVIEW, name)])
}

async function audioOnset(file, afterSeconds) {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1 << 26 }
  )
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4))
  for (let i = Math.floor(afterSeconds * 48000); i < samples.length; i++) if (Math.abs(samples[i]) > 0.2) return i / 48000
  return null
}

// tests/verify-recording.mjs has to pass good data and has to catch bad data, or the real run proves nothing
async function checkVerifyScript(paths, file) {
  const verify = async (dir, ...extra) => {
    const child = spawn(process.execPath, [join(ROOT, 'tests/verify-recording.mjs'), dir, file, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    const code = await new Promise((done) => child.once('close', done))
    return { code, text }
  }
  const fine = await verify(paths.main, '--skip', 'a12')
  check('verify-recording passes A10 and A11 on a good export', fine.code === 0, fine.code === 0 ? '' : fine.text)
  const focus = await verify(join(WORK, 'wrong-focus.dolly'), '--skip', 'a10,a12')
  check('verify-recording catches a wrong camera', focus.code === 1 && /FAIL\s+A11 click at 9.000 s matches/.test(focus.text), `exit ${focus.code}`)
  const level = await verify(join(WORK, 'wrong-level.dolly'), '--skip', 'a10,a12')
  check('verify-recording catches a wrong zoom level', level.code === 1 && /FAIL\s+A11 click at 9.000 s matches/.test(level.text), `exit ${level.code}`)
  const clean = await verify(paths.clean, '--skip', 'a10,a11')
  check('verify-recording passes A12 on a clean clip', clean.code === 0, clean.text.split('\n').find((l) => l.includes('A12')) ?? '')
  const burned = await verify(paths.burned, '--skip', 'a10,a11')
  check('verify-recording catches a cursor burned into the clip', burned.code === 1, burned.text.split('\n').find((l) => l.includes('A12')) ?? '')
}

async function ls(folder) {
  return existsSync(folder) ? (await readdir(folder)).sort() : []
}

async function sha(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

function mem(peak) {
  if (!peak) return 'n/a'
  const f = (v) => Math.round(v)
  return `total ${f(peak.total)} MB (main ${f(peak.main)}, renderer ${f(peak.renderer)}, gpu ${f(peak.gpu)}, ffmpeg ${f(peak.ffmpeg)}, other ${f(peak.other)})`
}

async function main() {
  await mkdir(WORK, { recursive: true })
  const paths = await makeFixtures()
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  console.log('Build')
  await run(join(ROOT, 'node_modules/.bin/electron-vite'), ['build', '-c', 'tests/export.vite.config.ts', '-l', 'warn'], { cwd: ROOT })

  console.log('Electron')
  const jobs = buildJobs(paths)
  const resultFile = join(WORK, 'result.json')
  await rm(resultFile, { force: true })
  const { memory } = await runElectron({ jobs, result: resultFile, checkPaths: true })
  const { results, blocked, rejected, gpu } = JSON.parse(await readFile(resultFile, 'utf8'))
  const byName = new Map(results.map((r) => [r.name, r]))
  console.log(`  GPU: ${gpu.gpuDevice?.[0]?.vendorId ?? '?'} ${gpu.auxAttributes?.glRenderer ?? ''}`)

  console.log('Checks')
  check('nothing but local files was requested', blocked.length === 0, blocked.slice(0, 3).join(' '))
  if (rejected.projectOutsideDollyFolder !== undefined) {
    check('request for a project outside the Dolly folder is refused', !!rejected.projectOutsideDollyFolder, rejected.projectOutsideDollyFolder ?? '')
    check('request for an unchosen folder is refused', !!rejected.folderNotChosen, rejected.folderNotChosen ?? '')
  }

  const mainClicks = CLICKS
  const shapes = byName.get('shapes-1080p60')
  if (shapes) {
    check('1080p job finished', !shapes.error, shapes.error ?? '')
    for (let i = 0; i < shapes.stats.length; i++) {
      await checkFile(shapes.stats[i], shapes.specs[i], (n) => n, mainClicks, { audio: true })
    }
    const names = shapes.stats.map((s) => s.file.split('/').pop())
    check('names follow the pattern', names[0] === 'Launch demo 16x9 1080p60.mp4' && names[2] === 'Launch demo 9x16 1080p60.mp4', names.join(' | '))
    if (shapes.error) throw new Error(shapes.error)
    const onset = await audioOnset(shapes.stats[0].file, 1)
    check('mic sits at its startMs offset', onset !== null && Math.abs(onset - 5.25) < 0.03, `beep at ${onset?.toFixed(3)} s, wanted 5.250 s`)
    await grabFrame(shapes.stats[0].file, 1, 'rest-16x9.png')
    await grabFrame(shapes.stats[0].file, 3, 'click1-16x9.png')
    await grabFrame(shapes.stats[1].file, 1, 'rest-1x1.png')
    await grabFrame(shapes.stats[2].file, 1, 'rest-9x16.png')
    await grabFrame(shapes.stats[2].file, 15, 'click3-9x16.png')
  }

  if (shapes && !only?.length) await checkVerifyScript(paths, shapes.stats[0].file)
  else if (shapes && only.includes('verify')) await checkVerifyScript(paths, shapes.stats[0].file)

  const k4 = byName.get('shapes-4k60')
  if (k4) {
    check('4K job finished', !k4.error, k4.error ?? '')
    for (let i = 0; i < k4.stats.length; i++) {
      await checkFile(k4.stats[i], k4.specs[i], (n) => n, mainClicks.filter((c) => Math.round(c.t * 0.06) % 5 === 0), { audio: true, tolerance: 2.5 })
    }
    if (k4.stats[0]) {
      await grabFrame(k4.stats[0].file, 3, 'click1-4k.png')
      await grabFrame(k4.stats[0].file, 1, 'rest-4k.png')
    }
  }

  const gif = byName.get('gif')
  if (gif) {
    check('GIF job finished', !gif.error, gif.error ?? '')
    if (gif.stats[0]) {
      await checkFile(gif.stats[0], gif.specs[0], (n) => n * 4, mainClicks, { gif: true, tolerance: 2 })
      check('GIF is 720 long', gif.stats[0].width === 720, `${gif.stats[0].width}x${gif.stats[0].height}`)
      check('GIF name', gif.stats[0].file.endsWith('/Launch demo 16x9.gif'), gif.stats[0].file.split('/').pop())
      console.log(`  GIF size ${(statSync(gif.stats[0].file).size / 1e6).toFixed(1)} MB`)
      await grabFrame(gif.stats[0].file, 3, 'click1-gif.png')
    }
  }

  const vfr = byName.get('vfr-1080p30')
  if (vfr) {
    check('VFR job finished', !vfr.error, vfr.error ?? '')
    if (vfr.stats[0]) {
      const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', join(paths.vfr, 'screen.mp4')], { maxBuffer: 1 << 24 })
      const times = stdout.trim().split('\n').map((l) => parseFloat(l) * 1000 + 120).sort((a, b) => a - b)
      const nearest = (n) => {
        const t = (n * 1000) / 30
        let best = 0
        for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i
        return best
      }
      await checkFile(vfr.stats[0], vfr.specs[0], nearest, [])
    }
  }

  const extras = byName.get('extras-pro')
  if (extras) {
    check('Pro items export', !extras.error, extras.error ?? '')
    if (extras.stats[0]) {
      await grabFrame(extras.stats[0].file, 0.5, 'extras-pro-16x9.png')
      await grabFrame(extras.stats[0].file, 1.5, 'extras-pro-16x9-zoom.png')
      await grabFrame(extras.stats[1].file, 0.5, 'extras-pro-9x16.png')
    }
  }
  const free = byName.get('extras-free')
  if (free) {
    check('Free export leaves Pro items out and still finishes', !free.error, free.error ?? '')
    if (free.stats[0]) {
      await grabFrame(free.stats[0].file, 0.5, 'extras-free-16x9.png')
      const wallpaperOnly = async (file) => {
        const size = 1920 * 1080 * 3
        const { stdout } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: size * 2 })
        const at = (x, y) => [...stdout.subarray((y * 1920 + x) * 3, (y * 1920 + x) * 3 + 3)]
        // The middle of the bubble: bottom right corner, 22% of the short side
        const m = 1080 * 0.04
        const s = 1080 * 0.22
        return { corner: at(1880, 1040), bubble: at(Math.round(1920 - m - s / 2), Math.round(1080 - m - s / 2)) }
      }
      const f = await wallpaperOnly(free.stats[0].file)
      const p = await wallpaperOnly(extras.stats[0].file)
      check('Free uses a built-in wallpaper, not the image', f.corner[0] < 200 && f.corner[1] < 150, `pixel ${f.corner}`)
      check('Pro uses the custom image', p.corner[0] > 200 && p.corner[1] > 100, `pixel ${p.corner}`)
      const close = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)
      check('Pro shows the webcam bubble in BT.601 colour', close(p.bubble, [0xc8, 0x3c, 0x28], 8), `pixel ${p.bubble}, wanted 200,60,40`)
      check('Free shows no webcam bubble', !close(f.bubble, [0xc8, 0x3c, 0x28], 40), `pixel ${f.bubble}`)
      // Measured at full zoom, where the marker's colour is wide enough not to bleed into the dot beside it
      const zoomed = clipToOutput(free.specs[0][45], free.stats[0], 1000 - MARKER_GAP - 24, 800)
      const { stdout } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '1.49', '-i', free.stats[0].file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1 << 24 })
      const i = (Math.round(zoomed.y) * 1920 + Math.round(zoomed.x)) * 3
      const marker = [...stdout.subarray(i, i + 3)]
      check('BT.709 screen colour survives the round trip', close(marker, [255, 0, 255], 8), `pixel ${marker}, wanted 255,0,255`)
    }
  }

  const collA = byName.get('name-collision-a')
  const collB = byName.get('name-collision-b')
  if (collA && collB) {
    const first = collA.stats[0]?.file
    const second = collB.stats[0]?.file
    check('second export takes a new name', !!second && second !== first && second.endsWith('Variable 1x1 1080p30 2.mp4'), second?.split('/').pop() ?? '')
    if (first && second) check('first file untouched', (await sha(first)) !== (await sha(second)) || statSync(first).mtimeMs < statSync(second).mtimeMs)
  }

  for (const name of ['refused-4k-free', 'refused-60-free', 'refused-vertical-free', 'refused-gif-free']) {
    const r = byName.get(name)
    if (!r) continue
    check(`${name} refused`, /Needs Dolly Pro/.test(r.error ?? ''), r.error ?? 'no error')
    check(`${name} wrote nothing`, (await ls(join(OUT, name))).length === 0)
  }

  const cancel = byName.get('cancel')
  if (cancel) {
    check('cancel stops the job', cancel.error === 'Export cancelled', cancel.error ?? 'no error')
    const left = await ls(join(OUT, 'cancel'))
    check('cancel leaves no file behind', left.length === 0, left.join(' '))
    check('cancel kills ffmpeg', cancel.leftRunning === 0, `${cancel.leftRunning} still running`)
    const peak = Math.max(...cancel.progress.map((p) => p.pct))
    check('cancel came during the first file', peak < 40, `reached ${peak}%`)
  }

  const broken = byName.get('broken')
  if (broken) {
    check('a broken clip fails the job', !!broken.error, broken.error?.slice(0, 120) ?? 'no error')
    const left = await ls(join(OUT, 'broken'))
    check('a failed job leaves no file behind', left.length === 0, left.join(' '))
    check('a failed job kills ffmpeg', broken.leftRunning === 0, `${broken.leftRunning} still running`)
  }

  const lg = byName.get('long-1080p60')
  if (lg) {
    const s = lg.stats[0]
    check('long export finished', !lg.error && !!s, lg.error ?? '')
    if (s) await checkFile(s, lg.specs[0], (n) => n, [], {})
    const rows = memory.samples.filter((x) => x.job === 'long-1080p60')
    const quarter = (i) => {
      const part = rows.slice(Math.floor((rows.length * i) / 4), Math.floor((rows.length * (i + 1)) / 4))
      return Math.round(Math.max(...part.map((p) => p.total)))
    }
    console.log(`  long job peak by quarter: ${[0, 1, 2, 3].map(quarter).join(', ')} MB`)
    check('memory stays flat on a long recording', quarter(3) < quarter(1) * 1.25, 'last quarter against second quarter')
  }

  console.log('Speed and memory')
  for (const r of results) {
    for (const s of r.stats) {
      const seconds = s.renderMs / 1000
      console.log(`  ${r.name} ${s.shape} ${s.width}x${s.height}@${s.fps}: ${s.frames} frames in ${seconds.toFixed(1)} s = ${(s.frames / seconds).toFixed(1)} fps, decode ${s.decode.width}x${s.decode.height}`)
    }
    if (memory.peak[r.name]) console.log(`    peak RSS ${mem(memory.peak[r.name])}`)
    const rows = memory.samples.filter((x) => x.job === r.name)
    if (rows.length > 3) {
      const avg = (k) => Math.round(rows.reduce((sum, x) => sum + x.cpu[k], 0) / rows.length)
      console.log(`    average CPU % main ${avg('main')}, renderer ${avg('renderer')}, gpu ${avg('gpu')}, ffmpeg ${avg('ffmpeg')}`)
    }
  }

  console.log(`\n${report.pass} passed, ${report.fail} failed`)
  for (const f of report.failures) console.log(`  FAILED: ${f}`)
  console.log(`Review frames in ${REVIEW}`)
  process.exit(report.fail ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
