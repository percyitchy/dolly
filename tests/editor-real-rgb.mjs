// The preview's <video> path through the GL renderer, checked pixel by pixel against compose(). The clip's
// colours say which clip pixel each output pixel came from, so a wrong camera, flip or colour matrix shows
// up as a number. Then the same frames are compared with a real export, which takes the YUV path.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { compose } from '../src/shared/compose.ts'
import {
  CODE_FPS, CODE_H, CODE_SECONDS, CODE_W, FFMPEG, HOME, STAMPS, STAMP_CELL, WORK,
  codedClip, decodePng, launch, log, openFirstProject, resetProjects, run, screenshot, seekTo, seg, sleep, writeProject
} from './editor-real-kit.mjs'

const DURATION = CODE_SECONDS * 1000
const CURSOR = { x: 2300, y: 1450 }
const SHAPES = [['16:9', '.fmt.a'], ['1:1', '.fmt.b'], ['9:16', '.fmt.c']]
const NO_PRO = { webcam: false, captions: false }
const track = { at: () => CURSOR, clicks: [] }

function inStamp(x, y) {
  return STAMPS.some((s) => x > s.x - 12 && x < s.x + STAMP_CELL * 8 + 12 && y > s.y - 12 && y < s.y + STAMP_CELL + 12)
}

function checkFrame(png, spec) {
  const scaleX = spec.camera.w / png.width
  const scaleY = spec.camera.h / png.height
  const clipPerCanvas = CODE_W / spec.screen.w
  const inset = 16 * Math.max(scaleX, scaleY) // Clears corners and edge filtering
  let count = 0, sum = 0, worst = 0, flipped = 0
  for (let v = 0.02; v < 1; v += 0.031) {
    for (let u = 0.02; u < 1; u += 0.019) {
      const px = Math.floor(u * png.width)
      const py = Math.floor(v * png.height)
      const cx = spec.camera.x + (px + 0.5) * scaleX
      const cy = spec.camera.y + (py + 0.5) * scaleY
      const { x, y, w, h } = spec.screen
      if (cx < x + inset || cx > x + w - inset || cy < y + inset || cy > y + h - inset) continue
      const clipX = (cx - x) * clipPerCanvas
      const clipY = (cy - y) * clipPerCanvas
      if (inStamp(clipX, clipY)) continue
      if (Math.hypot(clipX - CURSOR.x, clipY - CURSOR.y) < 260) continue
      const [r, g] = png.at(px, py)
      const wantR = (clipX / (CODE_W - 1)) * 255
      const wantG = (clipY / (CODE_H - 1)) * 255
      const err = Math.max(Math.abs(r - wantR), Math.abs(g - wantG))
      if (Math.abs(g - (255 - wantG)) < 6 && Math.abs(wantG - 127) > 40) flipped++
      sum += err
      worst = Math.max(worst, err)
      count++
    }
  }
  return { samples: count, meanErr: +(sum / Math.max(1, count)).toFixed(2), maxErr: +worst.toFixed(1), flipped }
}

// Reads a frame number back from every stamp in view
function readStamps(png, spec) {
  const toOut = (clipX, clipY) => {
    const cx = spec.screen.x + (clipX / CODE_W) * spec.screen.w
    const cy = spec.screen.y + (clipY / CODE_H) * spec.screen.h
    return [Math.round(((cx - spec.camera.x) / spec.camera.w) * png.width), Math.round(((cy - spec.camera.y) / spec.camera.h) * png.height)]
  }
  const seen = []
  for (const s of STAMPS) {
    const corners = [toOut(s.x, s.y), toOut(s.x + STAMP_CELL * 8, s.y + STAMP_CELL)]
    if (corners.flat().some((n, i) => n < 2 || n >= (i % 2 ? png.height : png.width) - 2)) continue
    let n = 0
    for (let bit = 0; bit < 8; bit++) {
      const [x, y] = toOut(s.x + (bit + 0.5) * STAMP_CELL, s.y + STAMP_CELL / 2)
      const [r, g] = png.at(x, y)
      if ((r + g) / 2 > 127) n |= 1 << bit
    }
    seen.push(n)
  }
  return seen
}

// Is the arrow where compose() put it? Something unlike the gradient must sit just past the tip
function cursorDrawn(png, spec) {
  if (!spec.cursor) return false
  const ox = ((spec.cursor.x - spec.camera.x) / spec.camera.w) * png.width
  const oy = ((spec.cursor.y - spec.camera.y) / spec.camera.h) * png.height
  if (ox < 0 || oy < 0 || ox >= png.width - 12 || oy >= png.height - 12) return 'outside the frame'
  let different = 0
  for (let dy = 0; dy < 12; dy++) {
    for (let dx = 0; dx < 8; dx++) {
      const [, , b] = png.at(Math.round(ox + dx), Math.round(oy + dy))
      if (Math.abs(b - 128) > 40) different++
    }
  }
  return different
}

export async function rgb() {
  const screen = await codedClip()
  resetProjects()
  const cursor = [{ t: 0, x: CURSOR.x, y: CURSOR.y, kind: 'move' }, { t: DURATION, x: CURSOR.x, y: CURSOR.y, kind: 'move' }]
  const dir = writeProject('Coded', {
    screen, width: CODE_W, height: CODE_H, fps: CODE_FPS, durationMs: DURATION, cursor,
    zooms: [seg('z1', 1000, 3400, { x: 0.45, y: 0.5 })]
  })
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
  const app = await launch()
  const results = []
  const frames = []
  try {
    const { page } = app
    await openFirstProject(page)
    await page.js(`(() => { const s = document.createElement('style'); s.textContent = '.zoomtag,.unlock,.focus-layer{display:none!important} canvas{filter:none!important}'; document.head.append(s) })()`)

    for (const target of [517, 1417, 2217]) { // Mid-frame, so the stamp has one right answer
      const t = await seekTo(page, target, DURATION)
      await sleep(500)
      for (const [shape, selector] of SHAPES) {
        const box = await page.js(`(() => { const c = document.querySelector('${selector} canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, bw: c.width, bh: c.height } })()`)
        const { bw, bh, ...clip } = box
        const buffer = await screenshot(page, `rgb-${shape.replace(':', 'x')}-${target}.png`, clip)
        const png = decodePng(buffer)
        const spec = compose(project, track, shape, { width: bw, height: bh }, t, NO_PRO)
        const stamps = readStamps(png, spec)
        const expected = Math.min(CODE_FPS * CODE_SECONDS - 1, Math.floor((t / 1000) * CODE_FPS))
        results.push({
          t: Math.round(t), shape, size: `${png.width}x${png.height}`, zoom: +spec.zoom.toFixed(2),
          ...checkFrame(png, spec),
          stampExpected: expected, stampsRead: [...new Set(stamps)], stampCount: stamps.length,
          cursor: cursorDrawn(png, spec)
        })
        frames.push({ t, shape, png })
      }
    }
    for (const r of results) log(JSON.stringify(r))

    // Side by side with a real export of the same project: the YUV path
    await page.js(`document.querySelector('.ship .primary').click()`)
    const start = Date.now()
    while (Date.now() - start < 60000) {
      if (await page.js(`/saved/.test(document.querySelector('.ship').innerText)`)) break
      await sleep(500)
    }
    const folder = join(HOME, 'Movies/Dolly')
    const files = readdirSync(folder).filter((f) => f.endsWith('.mp4'))
    log('exported', files, `${Date.now() - start} ms`)
    for (const { t, shape, png } of frames) {
      const file = files.find((f) => f.includes(shape.replace(':', 'x')))
      if (!file) continue
      const out = join(WORK, `export-${shape.replace(':', 'x')}-${Math.round(t)}.png`)
      const n = Math.floor((t / 1000) * CODE_FPS) // By number: -ss would land on the next frame from mid-frame
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(folder, file), '-vf', `select=eq(n\\,${n}),scale=${png.width}:${png.height}:flags=area`, '-frames:v', '1', out])
      const exported = decodePng(readFileSync(out))
      let sum = 0, count = 0, big = 0
      const errors = []
      for (let y = 0; y < png.height; y += 3) {
        for (let x = 0; x < png.width; x += 3) {
          const a = png.at(x, y)
          const b = exported.at(x, y)
          const err = (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3
          sum += err
          errors.push(err)
          if (err > 24) big++
          count++
        }
      }
      errors.sort((p, q) => p - q)
      log(JSON.stringify({ previewVsExport: shape, t: Math.round(t), meanErr: +(sum / count).toFixed(2), p99: +errors[Math.floor(count * 0.99)].toFixed(1), over24: +((big / count) * 100).toFixed(2) + '%' }))
    }
    log('problems', JSON.stringify(page.problems))
  } finally {
    await app.stop()
  }
}
