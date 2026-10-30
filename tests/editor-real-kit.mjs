// Shared by the tests/editor-real*.mjs checks: fixtures, the app over DevTools, real input and PNG reading.
// HOME is redirected, so nothing touches the real Dolly folder. See tests/editor-real.mjs.

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const WORK = process.env.DOLLY_EDITOR_DIR ?? join(tmpdir(), 'dolly-editor-real')
const HOME = join(WORK, 'home')
const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const THREADS = '4'
const run = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...parts) => console.log(...parts)

export { HOME, WORK, ROOT, FFMPEG, sleep, log, run }

// Fixtures

export async function perfClip() {
  const file = join(WORK, 'perf-screen.mp4')
  if (existsSync(file)) return file
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=2880x1800:r=60:d=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads', THREADS, '-movflags', '+faststart', file])
  return file
}

// Big enough that a view at rest takes the half-size path and a zoomed one takes the video itself
export const CODE_W = 2560
export const CODE_H = 1600
export const CODE_FPS = 30
export const CODE_SECONDS = 4

// Red runs left to right and green top to bottom, so every pixel says where it came from. Stamps across the
// clip carry the frame number as 8 black or white cells, which says when it came from
export const STAMP_CELL = 40
export const STAMPS = []
for (let j = 0; j < 4; j++) for (let i = 0; i < 5; i++) STAMPS.push({ x: 200 + i * 480, y: 160 + j * 400 })

export async function codedClip() {
  const file = join(WORK, 'coded-screen.mp4')
  if (existsSync(file)) return file
  const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${CODE_W}x${CODE_H}`, '-r', String(CODE_FPS), '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-g', '15', '-threads', THREADS, '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] })
  const base = Buffer.alloc(CODE_W * CODE_H * 3)
  for (let y = 0; y < CODE_H; y++) {
    for (let x = 0; x < CODE_W; x++) {
      const i = (y * CODE_W + x) * 3
      base[i] = Math.round((x / (CODE_W - 1)) * 255)
      base[i + 1] = Math.round((y / (CODE_H - 1)) * 255)
      base[i + 2] = 128
    }
  }
  for (let n = 0; n < CODE_FPS * CODE_SECONDS; n++) {
    const frame = Buffer.from(base)
    for (const stamp of STAMPS) {
      for (let bit = 0; bit < 8; bit++) {
        const on = (n >> bit) & 1 ? 255 : 0
        const left = stamp.x + bit * STAMP_CELL
        for (let y = stamp.y; y < stamp.y + STAMP_CELL; y++) frame.fill(on, (y * CODE_W + left) * 3, (y * CODE_W + left + STAMP_CELL) * 3)
      }
    }
    if (!child.stdin.write(frame)) await new Promise((r) => child.stdin.once('drain', r))
  }
  child.stdin.end()
  await new Promise((done, fail) => child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}`)))))
  return file
}

export async function micClip() {
  const file = join(WORK, 'mic.m4a')
  if (existsSync(file)) return file
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=20', '-af', "volume='0.2+0.5*abs(sin(t*1.7))':eval=frame", '-c:a', 'aac', '-b:a', '96k', file])
  return file
}

export const seg = (id, startMs, endMs, focus, level = 2) => ({ id, startMs, endMs, level, easeInMs: 600, easeOutMs: 600, focus, clickMs: [], origin: 'manual', edited: false })

export async function webcamClip() {
  const file = join(WORK, 'webcam.mp4')
  if (existsSync(file)) return file
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xFF7A00:s=640x640:r=30:d=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', THREADS, '-movflags', '+faststart', file])
  return file
}

export function writeProject(name, { screen, width, height, fps, durationMs, zooms, cursor, mic, webcamFile, webcam = null, captions = [] }) {
  const dir = join(HOME, 'Movies/Dolly', `${name}.dolly`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'screen.mp4'), readFileSync(screen))
  const clips = [{ id: 's', kind: 'screen', file: 'screen.mp4', startMs: 0, durationMs, width, height, fps, scaleFactor: 2 }]
  if (mic) {
    writeFileSync(join(dir, 'mic.m4a'), readFileSync(mic))
    clips.push({ id: 'm', kind: 'mic', file: 'mic.m4a', startMs: 0, durationMs })
  }
  if (webcamFile) {
    writeFileSync(join(dir, 'webcam.mp4'), readFileSync(webcamFile))
    clips.push({ id: 'w', kind: 'webcam', file: 'webcam.mp4', startMs: 0, durationMs, width: 640, height: 640 })
  }
  writeFileSync(join(dir, 'cursor.jsonl'), cursor.map((e) => JSON.stringify(e)).join('\n'))
  writeFileSync(join(dir, 'project.json'), JSON.stringify({
    version: 1, id: name, name, createdAt: '2026-10-28T10:00:00.000Z', durationMs, clips, zooms,
    look: { background: { kind: 'wallpaper', id: 'dusk' }, paddingPct: 6, cornerRadiusPct: 1.2, shadow: 0.5 },
    cursor: { smooth: true, stiffness: 170, damping: 26, scale: 1, clickRipple: true },
    webcam, captions,
    output: { shapes: ['16:9', '1:1'], format: 'mp4', resolution: '1080p', fps: 30, folder: '' }
  }))
  return dir
}

// The app, over DevTools

export async function launch({ inspect = false } = {}) {
  mkdirSync(join(HOME, 'Movies/Dolly'), { recursive: true })
  const env = { ...process.env, HOME, USERPROFILE: HOME }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const args = ['.', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--force-color-profile=srgb', `--user-data-dir=${join(WORK, 'userdata')}`]
  if (inspect) args.push('--inspect=127.0.0.1:0')
  const child = spawn(electron, args, { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let text = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (text += chunk))
  const port = await poll('the DevTools port', 30000, () => Number(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)?.[1]) || null)
  const target = await poll('the main window', 30000, async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return list.find((t) => t.type === 'page' && /\/index\.html/.test(t.url))
  })
  const page = await connect(target.webSocketDebuggerUrl)
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('Page.enable')
  let main = null
  if (inspect) {
    const url = await poll('the main inspector', 10000, () => /Debugger listening on (ws:\/\/\S+)/.exec(text)?.[1] ?? null)
    main = await connect(url)
    await main.send('Runtime.enable')
  }
  return { child, page, main, stop: () => stop(child) }
}

// Clears the throwaway Dolly folder, which lives under HOME above
export function resetProjects() {
  rmSync(join(HOME, 'Movies/Dolly'), { recursive: true, force: true })
}

// Real input events, shaped the way a mouse sends them: no button while hovering, and the left button
// reported as held on every move of a drag
export async function mouse(page, type, x, y, held = false) {
  const down = type === 'mousePressed' || held
  await page.send('Input.dispatchMouseEvent', {
    type, x, y, button: down || type === 'mouseReleased' ? 'left' : 'none', buttons: down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1
  })
}

export async function click(page, x, y) {
  await mouse(page, 'mouseMoved', x, y)
  await mouse(page, 'mousePressed', x, y)
  await mouse(page, 'mouseReleased', x, y)
}

export async function drag(page, from, to, steps = 8) {
  await mouse(page, 'mouseMoved', from.x, from.y)
  await mouse(page, 'mousePressed', from.x, from.y)
  for (let i = 1; i <= steps; i++) {
    await mouse(page, 'mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, true)
    await sleep(16)
  }
  await mouse(page, 'mouseReleased', to.x, to.y)
}

export async function key(page, name, modifiers = 0, code = name) {
  const keys = { ' ': ['Space', 32], Delete: ['Delete', 46], Escape: ['Escape', 27], z: ['KeyZ', 90] }
  const [keyCode, vk] = keys[name] ?? [code, 0]
  const base = { key: name, code: keyCode, windowsVirtualKeyCode: vk, modifiers }
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

// Seeks with a click on the ruler, then reads back the exact time from the playhead
export async function seekTo(page, ms, durationMs) {
  const box = await page.js(`(() => { const r = document.querySelector('.ruler').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width } })()`)
  await click(page, box.x + (ms / durationMs) * box.w, box.y)
  await sleep(350)
  return (parseFloat(await page.js(`document.querySelector('.playhead').style.left`)) / 100) * durationMs
}

async function stop(child) {
  const gone = new Promise((done) => child.once('exit', done))
  child.kill()
  await Promise.race([gone, sleep(2000)])
  if (child.exitCode === null) child.kill('SIGKILL') // With the inspector open, Electron can ignore SIGTERM
}

async function poll(what, timeoutMs, attempt) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await Promise.resolve().then(attempt).catch(() => null)
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = () => fail(new Error(`Couldn't reach ${url}`))
  })
  let id = 0
  const waiting = new Map()
  const problems = []
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data)
    if (m.id) {
      waiting.get(m.id)?.(m)
      waiting.delete(m.id)
    }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) problems.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`)
  }
  const send = (method, params = {}) =>
    new Promise((done) => {
      const n = ++id
      waiting.set(n, done)
      socket.send(JSON.stringify({ id: n, method, params }))
    })
  const js = async (expression, extra = {}) => {
    const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...extra })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  return { send, js, problems }
}

export async function screenshot(page, name, clip) {
  const { result } = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
  const buffer = Buffer.from(result.data, 'base64')
  if (name) writeFileSync(join(WORK, name), buffer)
  return buffer
}

// Enough PNG to read what Chromium writes: 8 bit, RGB or RGBA, not interlaced
export function decodePng(buffer) {
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const channels = { 2: 3, 6: 4 }[buffer[25]]
  if (buffer[24] !== 8 || !channels || buffer[28] !== 0) throw new Error('Unsupported PNG')
  const chunks = []
  for (let at = 8; at < buffer.length; ) {
    const size = buffer.readUInt32BE(at)
    if (buffer.toString('latin1', at + 4, at + 8) === 'IDAT') chunks.push(buffer.subarray(at + 8, at + 8 + size))
    at += size + 12
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0
      let p = 0
      if (filter === 1) p = a
      else if (filter === 2) p = b
      else if (filter === 3) p = (a + b) >> 1
      else if (filter === 4) {
        const e = a + b - c
        const pa = Math.abs(e - a)
        const pb = Math.abs(e - b)
        const pc = Math.abs(e - c)
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + x] = (value + p) & 255
    }
  }
  return { width, height, channels, data: out, at: (x, y) => [0, 1, 2].map((i) => out[(y * width + x) * channels + i]) }
}

export const openFirstProject = async (page) => {
  await poll('the recent list', 15000, () => page.js(`!!document.querySelector('.recent li button')`))
  await page.js(`document.querySelector('.recent li button').click()`)
  await poll('the previews', 15000, () => page.js(`document.querySelectorAll('.fmt canvas').length === 3`))
  await poll('the first frame', 15000, () => page.js(`document.querySelector('.tl-top .tc') !== null`))
  await sleep(800)
}

// Total CPU seconds across the app and all its helpers
async function cpuSeconds(pid) {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,time='])
  const rows = stdout.trim().split('\n').map((l) => l.trim().split(/\s+/))
  const family = new Set([String(pid)])
  for (let changed = true; changed; ) {
    changed = false
    for (const [p, parent] of rows) if (family.has(parent) && !family.has(p)) (family.add(p), (changed = true))
  }
  let total = 0
  for (const [p, , time] of rows) {
    if (!family.has(p)) continue
    const parts = time.split(':').map(Number)
    total += parts.reduce((sum, v) => sum * 60 + v, 0)
  }
  return total
}

// GPU busy percent from the OS. CPU timing can't see this, because GL calls only queue the work
async function gpuPercent() {
  const { stdout } = await run('sh', ['-c', 'ioreg -r -d 1 -c IOAccelerator'])
  return Number(/"Device Utilization %"=(\d+)/.exec(stdout)?.[1] ?? NaN)
}

async function sampleGpu(ms) {
  const samples = []
  const end = Date.now() + ms
  while (Date.now() < end) {
    samples.push(await gpuPercent())
    await sleep(250)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return { avg: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length), p50: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] }
}

// Perf

const INSTRUMENT = `(() => {
  const stats = window.__perf = { frames: [], gaps: [], upload: 0, uploadMs: 0, mips: 0, mipsMs: 0, draws: 0 }
  const RealAudio = window.Audio
  window.Audio = function (src) { return (window.__audio = new RealAudio(src)) }
  const create = document.createElement.bind(document)
  document.createElement = (tag, ...rest) => {
    const el = create(tag, ...rest)
    if (tag === 'video' && !window.__video) window.__video = el
    return el
  }
  const raf = window.requestAnimationFrame.bind(window)
  let last = 0
  window.requestAnimationFrame = (cb) => raf((t) => {
    if (last) stats.gaps.push(t - last)
    last = t
    const s = performance.now()
    cb(t)
    stats.frames.push(performance.now() - s)
  })
  const p = WebGL2RenderingContext.prototype
  const wrap = (name, count, ms) => {
    const original = p[name]
    p[name] = function (...args) {
      const s = performance.now()
      const result = original.apply(this, args)
      stats[count]++
      if (ms) stats[ms] += performance.now() - s
      return result
    }
  }
  wrap('texImage2D', 'upload', 'uploadMs')
  wrap('generateMipmap', 'mips', 'mipsMs')
  wrap('drawArrays', 'draws')
  window.__resetPerf = () => { stats.frames.length = 0; stats.gaps.length = 0; stats.upload = stats.uploadMs = stats.mips = stats.mipsMs = stats.draws = 0; last = 0 }
  return true
})()`

const pctile = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b)
  return +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(2)
}

// Two frames, 12 s apart, the way screen capture leaves a screen that doesn't change
async function stillClip() {
  const file = join(WORK, 'still-vfr.mp4')
  if (existsSync(file)) return file
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=2880x1800:r=60:d=12',
    '-vf', 'select=eq(n\\,0)+eq(n\\,719)', '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads', THREADS, '-movflags', '+faststart', file])
  return file
}

// Real recordings are mostly a still screen with a moving cursor, so that's measured too
export async function perf(still = false) {
  const screen = await (still ? stillClip() : perfClip())
  const mic = await micClip()
  const cursor = []
  const moving = still ? 4000 : 12000 // A still run stops the cursor partway, so nothing at all should draw after
  for (let t = 0; t <= moving; t += 8) cursor.push({ t, x: 1440 + 1100 * Math.sin(t / 900), y: 900 + 700 * Math.sin(t / 700), kind: 'move' })
  resetProjects()
  writeProject('Perf', {
    screen, mic, width: 2880, height: 1800, fps: 60, durationMs: 12000, cursor,
    zooms: still ? [] : [seg('z1', 3000, 7000, { x: 0.3, y: 0.3 })]
  })
  const app = await launch()
  try {
    const { page } = app
    await page.js(INSTRUMENT)
    await openFirstProject(page)
    const size = await page.js(`JSON.stringify({ win: [innerWidth, innerHeight], dpr: devicePixelRatio, canvases: [...document.querySelectorAll('.fmt canvas')].map(c => [c.width, c.height]), hidden: document.hidden })`)
    log('setup', size)

    const baseGpu = await sampleGpu(3000) // Before the app settles, thumbnails and all
    await sleep(6000)
    const idleA = await cpuSeconds(app.child.pid)
    const idleStart = Date.now()
    const idleGpu = await sampleGpu(4000)
    const idleCpu = (await cpuSeconds(app.child.pid)) - idleA
    const idlePct = Math.round((idleCpu / ((Date.now() - idleStart) / 1000)) * 100)

    await page.js(`window.__resetPerf(); window.__shown = 0; (function count() { window.__shown++; window.__video.requestVideoFrameCallback(count) })(); true`)
    const cpuA = await cpuSeconds(app.child.pid)
    const start = Date.now()
    await page.js(`document.querySelector('.play').click()`)
    const drift = []
    const stopDrift = setInterval(async () => {
      const value = await page.js(`Math.abs(window.__audio.currentTime - window.__video.currentTime)`).catch(() => null)
      if (value !== null) drift.push(value * 1000)
    }, 200)
    const firstHalf = await sampleGpu(5500)
    const quietStart = await page.js(`window.__perf.draws`)
    const quietAt = Date.now()
    const secondHalf = await sampleGpu(2500)
    const quietDraws = ((await page.js(`window.__perf.draws`)) - quietStart) / ((Date.now() - quietAt) / 1000)
    const playGpu = { first: firstHalf, last: secondHalf }
    clearInterval(stopDrift)
    const report = await page.js(`JSON.stringify({ ...window.__perf, frames: window.__perf.frames, gaps: window.__perf.gaps })`)
    const cpu = (await cpuSeconds(app.child.pid)) - cpuA
    const wall = (Date.now() - start) / 1000
    await page.js(`document.querySelector('.play').click()`)
    const r = JSON.parse(report)
    const tc = await page.js(`document.querySelector('.tl-top .tc').firstChild.textContent.trim()`)
    log(JSON.stringify({
      rafPerSecond: +(r.gaps.length / wall).toFixed(1),
      gapMs: { p50: pctile(r.gaps, 0.5), p95: pctile(r.gaps, 0.95), p99: pctile(r.gaps, 0.99), max: pctile(r.gaps, 1) },
      over25ms: r.gaps.filter((g) => g > 25).length,
      jsFrameMs: { p50: pctile(r.frames, 0.5), p95: pctile(r.frames, 0.95), max: pctile(r.frames, 1) },
      uploadsPerSecond: +(r.upload / wall).toFixed(1),
      uploadMsEach: +(r.uploadMs / Math.max(1, r.upload)).toFixed(2),
      mipmapsPerSecond: +(r.mips / wall).toFixed(1),
      mipmapMsEach: +(r.mipsMs / Math.max(1, r.mips)).toFixed(2),
      drawCallsPerSecond: +(r.draws / wall).toFixed(1),
      appCpuPercent: Math.round((cpu / wall) * 100),
      idleCpuPercent: idlePct,
      gpu: { opening: baseGpu, idle: idleGpu, playing: playGpu },
      avDriftMs: { p50: pctile(drift, 0.5), last: pctile(drift.slice(-12), 0.5), max: pctile(drift, 1), samples: drift.length },
      videoFramesShownPerSecond: +((await page.js(`window.__shown`)) / wall).toFixed(1),
      drawCallsPerSecondLast3s: +quietDraws.toFixed(1),
      droppedFrames: await page.js(`(() => { const q = window.__video.getVideoPlaybackQuality(); return [q.droppedVideoFrames, q.totalVideoFrames] })()`),
      endedAt: tc,
      problems: page.problems
    }, null, 1))
    await screenshot(page, 'perf.png')
  } finally {
    await app.stop()
  }
}
