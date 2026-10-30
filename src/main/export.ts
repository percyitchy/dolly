// Export: ffmpeg decodes, the hidden window draws, a second ffmpeg encodes. One file at a time, one queue.
// compose() runs here, so the window only ever turns a FrameSpec and a source frame into pixels.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { app, BrowserWindow, dialog, MessageChannelMain, shell, type MessagePortMain } from 'electron'
import { buildCursorTrack } from '../engine/cursor'
import type { ExportBackground, FromWindow, RawPlanes, ToWindow } from '../renderer/export/protocol'
import { compose, restRect, type CursorTrack } from '../shared/compose'
import { can, FEATURE_LABELS, lockedInOutput, type Plan } from '../shared/entitlements'
import { CHANNELS, type ExportEvent, type ExportRequest } from '../shared/ipc'
import { LOOK_DEFAULTS, outputSize, type Clip, type OutputSettings, type Project, type Shape } from '../shared/project'
import { handleFromMain, type Register } from './context'
import { currentPlan } from './license'
import { defaultDollyFolder, ffmpegInput, ffmpegPath, pageUrl } from './paths'
import { assertProject, assertProjectDir, CURSOR_FILE, parseCursorLog, PROJECT_FILE, realProjectFile, sanitizeName } from './projects'
import { secureWebPreferences } from './window-guard'

const GIF_LONG_SIDE = 720
const GIF_FPS = 15
const MAX_WEBCAM_HEIGHT = 720
const IN_FLIGHT_FRAMES = 3 // Frames between the decoder and the encoder. This is what keeps memory flat
const TEMP_PREFIX = '.dolly-export-'
const STDERR_TAIL = 2000

class Cancelled extends Error {
  constructor() {
    super('Export cancelled')
  }
}

export interface ExportOptions {
  projectDir: string
  output: OutputSettings
  plan: Plan
  threads?: number // Caps ffmpeg's threads. Left out, exportThreads() decides
  signal?: AbortSignal
  onEvent(event: ExportEvent): void
}

export interface FileStats {
  file: string
  shape: Shape
  width: number
  height: number
  fps: number
  frames: number
  decode: { width: number; height: number }
  renderMs: number
}

export interface ExportResult {
  files: string[]
  stats: FileStats[]
}

// Paths

function settingsFile(): string {
  return join(app.getPath('userData'), 'export-folders.json')
}

interface FolderSettings {
  last: string | null
  picked: string[] // Every folder the user has chosen in the dialog
}

async function readFolderSettings(): Promise<FolderSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), 'utf8'))
    return {
      last: typeof parsed.last === 'string' ? parsed.last : null,
      picked: Array.isArray(parsed.picked) ? parsed.picked.filter((p: unknown) => typeof p === 'string') : []
    }
  } catch {
    return { last: null, picked: [] }
  }
}

// The request comes from a renderer, so nothing in it is trusted: the project has to sit in the Dolly
// folder, and the output folder has to be the default or one the user picked in the dialog
export async function checkRequest(request: ExportRequest): Promise<ExportRequest> {
  if (typeof request?.projectDir !== 'string' || typeof request.output !== 'object' || !request.output) {
    throw new Error('That export request is not valid')
  }
  const projectDir = await assertProjectDir(request.projectDir).catch(() => {
    throw new Error('That project is outside the Dolly folder')
  })

  const settings = await readFolderSettings()
  const folder = resolve(request.output.folder || settings.last || defaultDollyFolder())
  const allowed = [defaultDollyFolder(), ...settings.picked].map((p) => resolve(p))
  if (!allowed.includes(folder)) throw new Error('Choose the export folder again')
  return { projectDir, output: { ...request.output, folder } }
}

// Inside the project folder after symlinks, or it throws. The folder itself was checked by the caller
function projectFile(dir: string, file: string): Promise<string> {
  return realProjectFile(dirname(dir), dir, file)
}

export function exportStem(name: string, shape: Shape, output: OutputSettings): string {
  const base = `${sanitizeName(name, 'Dolly export')} ${shape.replace(':', 'x')}`
  if (output.format === 'gif') return base
  return `${base} ${output.resolution === '4k' ? '4K' : '1080p'}${output.fps}`
}

// Takes the first free name by creating it, so nothing that exists is ever replaced
async function claimFile(folder: string, stem: string, ext: string): Promise<string> {
  for (let i = 1; ; i++) {
    const path = join(folder, i === 1 ? `${stem}${ext}` : `${stem} ${i}${ext}`)
    try {
      await (await open(path, 'wx')).close()
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

// A crash can't run any cleanup, so the next export clears what it left behind
async function sweepTempFiles(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[])
  await Promise.all(
    names.filter((n) => n.startsWith(TEMP_PREFIX)).map((n) => rm(join(folder, n), { force: true }).catch(() => {}))
  )
}

const liveTemps = new Set<string>()

// Temp files in use right now, so quitting can delete them before the process is gone
export function trackTemps(paths: string[]): () => void {
  paths.forEach((path) => liveTemps.add(path))
  return () => paths.forEach((path) => liveTemps.delete(path))
}

// Retries because a killed ffmpeg can hold the file for a moment on Windows
function removeLiveTemps(): void {
  for (const path of liveTemps) {
    try {
      rmSync(path, { force: true, maxRetries: 5, retryDelay: 20 })
    } catch {
      // The next export's sweep gets it
    }
  }
}

// One running export: its abort signal and the programs that have to die with it

interface Child {
  proc: ChildProcess
  exited: Promise<void>
  stop(): void
}

// Leaves two cores free and stops at 8, because more threads add heat rather than speed here
function exportThreads(): number {
  return Math.max(2, Math.min(8, availableParallelism() - 2))
}

class Job {
  private controller = new AbortController()
  private children = new Set<Child>()
  readonly signal = this.controller.signal

  // Goes before an input or an output. Empty means ffmpeg's own default
  readonly threadArgs: string[]

  constructor(external?: AbortSignal, threads?: number) {
    this.threadArgs = threads ? ['-threads', String(threads)] : []
    if (external?.aborted) this.fail(external.reason)
    external?.addEventListener('abort', () => this.fail(external.reason), { once: true })
    this.signal.addEventListener('abort', () => this.killAll(), { once: true })
  }

  fail(reason: unknown): void {
    if (!this.signal.aborted) this.controller.abort(reason)
  }

  check(): void {
    this.signal.throwIfAborted()
  }

  // Rejects as soon as the job dies, even if the promise never settles
  wait<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((done, reject) => {
      const onAbort = () => reject(this.signal.reason)
      if (this.signal.aborted) return onAbort()
      this.signal.addEventListener('abort', onAbort, { once: true })
      promise.then(done, reject).finally(() => this.signal.removeEventListener('abort', onAbort))
    })
  }

  ffmpeg(args: string[], pipes: { stdin?: boolean; stdout?: boolean } = {}): Child {
    this.check()
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-nostats', '-loglevel', 'error', ...args], {
      stdio: [pipes.stdin ? 'pipe' : 'ignore', pipes.stdout ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true
    })
    proc.stdin?.on('error', () => {}) // A dead encoder shows up through its exit code
    proc.stdout?.on('error', () => {})
    let tail = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL)
    })
    let stopped = false
    const exited = new Promise<void>((done, reject) => {
      proc.once('error', reject)
      proc.once('close', (code, signal) => {
        this.children.delete(child)
        if (code === 0 || stopped) done()
        else reject(new Error(`ffmpeg failed (${code ?? signal}): ${tail.trim()}`))
      })
    })
    exited.catch(() => {}) // Whoever awaits it still sees the failure
    const child: Child = {
      proc,
      exited,
      stop: () => {
        stopped = true
        proc.kill('SIGKILL')
      }
    }
    this.children.add(child)
    return child
  }

  killAll(): void {
    for (const child of this.children) child.stop()
  }
}

class Credits {
  private waiting: (() => void)[] = []

  constructor(private free: number) {}

  take(job: Job): Promise<void> {
    if (this.free > 0) {
      this.free--
      return Promise.resolve()
    }
    return job.wait(new Promise<void>((done) => this.waiting.push(done)))
  }

  give(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.free++
  }
}

// Reading a clip

// Every frame time in the file, in display order, without decoding anything. Fast even on an hour of video
async function readFrameTimes(job: Job, file: string): Promise<Float64Array> {
  const child = job.ffmpeg(['-copyts', ...ffmpegInput(file), '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', 'pipe:1'], {
    stdout: true
  })
  const pts: number[] = []
  let msPerTick = 0
  let rest = ''
  const eat = (line: string) => {
    if (line.startsWith('#tb 0:')) {
      const m = /(\d+)\/(\d+)/.exec(line)
      if (m) msPerTick = (Number(m[1]) * 1000) / Number(m[2])
    } else if (!line.startsWith('#') && line) {
      const value = Number(line.split(',')[2])
      if (Number.isFinite(value)) pts.push(value * msPerTick)
    }
  }
  for await (const chunk of child.proc.stdout as Readable) {
    const lines = (rest + chunk.toString()).split('\n')
    rest = lines.pop() ?? ''
    lines.forEach(eat)
  }
  await child.exited
  if (pts.length === 0) throw new Error('The clip has no video frames')
  return Float64Array.from(pts).sort()
}

interface VideoInfo {
  width: number
  height: number
  matrix: RawPlanes['matrix']
  fullRange: boolean
  pixelFormat: string
}

// ffmpeg-static has no ffprobe. Asking ffmpeg to read a file with no output prints the same stream line
async function readVideoInfo(job: Job, file: string): Promise<VideoInfo> {
  const proc = spawn(ffmpegPath(), ['-hide_banner', ...ffmpegInput(file)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let text = ''
  proc.stderr.on('data', (chunk: Buffer) => (text += chunk.toString()))
  await job.wait(new Promise((done) => proc.once('close', done)))
  const video = /Video: .*?, (\w+)(?:\(([^)]*)\))?, (\d{2,5})x(\d{2,5})/.exec(text)
  if (!video) throw new Error('The clip could not be read')
  const pixelFormat = video[1]
  const tags = video[2] ?? ''
  return {
    width: Number(video[3]),
    height: Number(video[4]),
    matrix: /bt470bg|smpte170m|bt601/.test(tags) ? 'bt601' : 'bt709', // Untagged screen video is treated as HD
    fullRange: pixelFormat.startsWith('yuvj') || /\bpc\b/.test(tags),
    pixelFormat
  }
}

// Reads whole frames off the decoder's pipe. Nothing is read ahead of what's asked for, so ffmpeg just blocks
class FrameStream {
  private ended = false
  private wake: (() => void) | null = null

  constructor(
    private stream: Readable,
    private job: Job
  ) {
    const notify = () => {
      this.wake?.()
      this.wake = null
    }
    const finish = () => {
      this.ended = true
      notify()
    }
    stream.on('readable', notify)
    stream.once('end', finish)
    stream.once('close', finish)
    job.signal.addEventListener('abort', notify, { once: true })
  }

  // Fills target, or skips a frame when target is null. False once the stream runs out
  async next(target: Uint8Array | null, size: number): Promise<boolean> {
    let got = 0
    while (got < size) {
      this.job.check()
      const chunk = this.stream.read() as Buffer | null
      if (chunk === null) {
        if (this.ended) return false
        await new Promise<void>((done) => (this.wake = done))
        continue
      }
      const take = Math.min(chunk.length, size - got)
      if (target) target.set(take === chunk.length ? chunk : chunk.subarray(0, take), got)
      got += take
      if (take < chunk.length) this.stream.unshift(chunk.subarray(take))
    }
    return true
  }
}

// The source frame nearest time t, given the index picked for the previous, earlier t
export function nearestFrame(times: ArrayLike<number>, t: number, from: number): number {
  let i = from
  while (i + 1 < times.length && Math.abs(times[i + 1] - t) < Math.abs(times[i] - t)) i++
  return i
}

function evenFloor(v: number): number {
  return Math.max(2, Math.floor(v / 2) * 2)
}

function evenCeil(v: number): number {
  return Math.max(2, Math.ceil(v / 2) * 2)
}

// Full clip size, or less when no frame of this shot shows it at 1:1
export function decodeSize(
  clip: { width: number; height: number },
  neededWidth: number
): { width: number; height: number } {
  if (neededWidth >= clip.width) return { width: evenFloor(clip.width), height: evenFloor(clip.height) }
  const width = evenCeil(neededWidth)
  return { width, height: evenCeil((width * clip.height) / clip.width) }
}

class Source {
  private buffer: Uint8Array
  private stream: FrameStream
  private decoded = -1
  private picked = 0
  private frameBytes: number

  private constructor(
    private child: Child,
    private times: Float64Array,
    private planes: Omit<RawPlanes, 'data'>,
    job: Job
  ) {
    const { width, height } = planes
    this.frameBytes = width * height + 2 * ((width + 1) >> 1) * ((height + 1) >> 1)
    this.buffer = new Uint8Array(this.frameBytes)
    this.stream = new FrameStream(child.proc.stdout as Readable, job)
  }

  static async open(
    job: Job,
    file: string,
    times: Float64Array,
    info: VideoInfo,
    size: { width: number; height: number }
  ): Promise<Source> {
    const rgb = !/^(yuv|nv)/.test(info.pixelFormat)
    const args = [...job.threadArgs, ...ffmpegInput(file), '-map', '0:v:0', '-an', '-sn', '-fps_mode', 'passthrough']
    if (rgb || info.fullRange || size.width !== info.width || size.height !== info.height) {
      const matrix = rgb ? ':out_color_matrix=bt709' : ''
      args.push('-vf', `scale=${size.width}:${size.height}:flags=bicubic:out_range=tv${matrix}`)
    }
    args.push('-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1')
    const child = job.ffmpeg(args, { stdout: true })
    return new Source(child, times, { format: 'yuv420p', ...size, matrix: rgb ? 'bt709' : info.matrix }, job)
  }

  // Null means the frame sent last time is still the right one
  async frameAt(t: number): Promise<RawPlanes | null> {
    this.picked = nearestFrame(this.times, t, this.picked)
    if (this.decoded >= this.picked) return null
    while (this.decoded < this.picked) {
      const wanted = this.decoded + 1 === this.picked
      if (!(await this.stream.next(wanted ? this.buffer : null, this.frameBytes))) {
        if (this.decoded < 0) throw new Error('The clip could not be decoded')
        this.times = this.times.subarray(0, this.decoded + 1) // Fewer frames than the index said
        this.picked = this.decoded
        return null
      }
      this.decoded++
    }
    return { ...this.planes, data: this.buffer }
  }

  stop(): void {
    this.child.stop()
  }
}

// The hidden window

class RenderSession {
  onRendered: (n: number, pixels: Uint8Array) => void = () => {}
  private onReady: () => void = () => {}
  private nextJob = 1
  private job = 0

  private constructor(
    private win: BrowserWindow,
    private port: MessagePortMain,
    private owner: Job
  ) {
    port.on('message', ({ data }: { data: FromWindow }) => {
      if (data.type === 'error') owner.fail(new Error(data.message))
      else if (data.job !== this.job) return
      else if (data.type === 'ready') this.onReady()
      else this.onRendered(data.n, data.pixels)
    })
    win.webContents.once('render-process-gone', (_e, details) => {
      owner.fail(new Error(`The export window stopped: ${details.reason}`))
    })
  }

  static async open(job: Job): Promise<RenderSession> {
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      paintWhenInitiallyHidden: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: secureWebPreferences('export', { backgroundThrottling: false })
    })
    const { port1, port2 } = new MessageChannelMain()
    const session = new RenderSession(win, port1, job)
    port1.start()
    try {
      await job.wait(win.loadURL(pageUrl('export.html')))
    } catch (error) {
      session.close()
      throw error
    }
    win.webContents.postMessage(CHANNELS.exportPort, null, [port2])
    return session
  }

  async begin(width: number, height: number, background: ExportBackground): Promise<void> {
    this.job = this.nextJob++
    const ready = new Promise<void>((done) => (this.onReady = done))
    this.post({ type: 'begin', job: this.job, width, height, background })
    await this.owner.wait(ready)
  }

  frame(n: number, spec: ReturnType<typeof compose>, screen: RawPlanes | null, webcam: RawPlanes | null): void {
    const message: ToWindow = { type: 'frame', job: this.job, n, spec }
    if (screen) message.screen = screen
    if (webcam) message.webcam = webcam
    this.post(message)
  }

  private post(message: ToWindow): void {
    this.port.postMessage(message)
  }

  close(): void {
    this.port.close()
    if (!this.win.isDestroyed()) this.win.destroy()
  }
}

// Encoding

function rawInput(width: number, height: number, fps: number): string[] {
  return ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${width}x${height}`, '-framerate', String(fps), ...ffmpegInput('pipe:0')]
}

function mp4Args(
  output: string,
  width: number,
  height: number,
  fps: number,
  frames: number,
  mic: MicInput | null,
  threadArgs: string[]
): string[] {
  const args = rawInput(width, height, fps)
  if (mic) args.push(...ffmpegInput(mic.file), '-map', '0:v:0', '-map', '1:a:0')
  args.push('-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p')
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-profile:v', 'high', ...threadArgs)
  args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv')
  if (mic) args.push('-af', micFilter(mic.startMs, (frames * 1000) / fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  args.push('-movflags', '+faststart', '-f', 'mp4', '-y', output)
  return args
}

interface MicInput {
  file: string
  startMs: number
}

// Puts the mic on the capture clock, then pads or trims it to exactly the video's length
function micFilter(startMs: number, durationMs: number): string {
  const steps = ['aresample=48000', 'asetpts=PTS-STARTPTS']
  if (startMs > 0) steps.push(`adelay=${Math.round(startMs * 48)}S:all=1`)
  if (startMs < 0) steps.push(`atrim=start=${-startMs / 1000}`, 'asetpts=PTS-STARTPTS')
  steps.push('apad', `atrim=end=${durationMs / 1000}`)
  return steps.join(',')
}

// A GIF has to see every frame to pick its palette, and doing that in one ffmpeg holds them all in memory.
// So frames go to a lossless file first, then two passes read it back
function losslessArgs(output: string, width: number, height: number, threadArgs: string[]): string[] {
  const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', ...threadArgs]
  return [...rawInput(width, height, GIF_FPS), ...encode, '-f', 'mp4', '-y', output]
}

function paletteArgs(lossless: string, palette: string): string[] {
  const out = ['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-y', palette]
  return [...ffmpegInput(lossless), '-vf', 'palettegen=stats_mode=full', ...out]
}

function gifArgs(lossless: string, palette: string, output: string): string[] {
  const paletteInput = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', '16x16', ...ffmpegInput(palette)]
  const filter = '[0:v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
  return [...ffmpegInput(lossless), ...paletteInput, '-lavfi', filter, '-loop', '0', '-f', 'gif', '-y', output]
}

export function gifSize(shape: Shape): { width: number; height: number } {
  const size = outputSize(shape, '1080p')
  const scale = GIF_LONG_SIDE / Math.max(size.width, size.height)
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
}

// The largest width the clip is ever drawn at in this shape, in output pixels
function peakClipWidth(project: Project, clip: Clip, frame: { width: number; height: number }): number {
  const rest = restRect(frame.width, frame.height, clip.width!, clip.height!, project.look.paddingPct)
  const levels = project.zooms.map((z) => z.level)
  const zoom = Math.max(1, ...levels.map((level) => (level * frame.height) / rest.h))
  return rest.w * zoom
}

function webcamSize(info: VideoInfo): { width: number; height: number } {
  const height = Math.min(info.height, MAX_WEBCAM_HEIGHT)
  return { width: evenCeil((height * info.width) / info.height), height: evenCeil(height) }
}

// The job

interface Loaded {
  project: Project
  track: CursorTrack
  screenClip: Clip
  screenFile: string
  screenTimes: Float64Array
  screenInfo: VideoInfo
  webcam: { file: string; times: Float64Array; info: VideoInfo } | null
  mic: MicInput | null
  background: ExportBackground
  pro: { webcam: boolean; captions: boolean }
}

function shiftTimes(times: Float64Array, startMs: number): Float64Array {
  return times.map((t) => t + startMs)
}

async function loadProject(job: Job, dir: string, plan: Plan): Promise<Loaded> {
  const project = assertProject(JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')))
  const events = parseCursorLog(await readFile(join(dir, CURSOR_FILE), 'utf8').catch(() => ''))

  const pro = { webcam: can(plan, 'webcam'), captions: can(plan, 'captions') }
  const screenClip = project.clips.find((c) => c.kind === 'screen')
  if (!screenClip?.width || !screenClip.height) throw new Error('The project has no screen clip')
  const screenFile = await projectFile(dir, screenClip.file)
  const screenTimes = shiftTimes(await readFrameTimes(job, screenFile), screenClip.startMs)
  const screenInfo = await readVideoInfo(job, screenFile)

  let webcam: Loaded['webcam'] = null
  const webcamClip = project.clips.find((c) => c.kind === 'webcam')
  if (project.webcam && pro.webcam && webcamClip) {
    const file = await projectFile(dir, webcamClip.file)
    const times = shiftTimes(await readFrameTimes(job, file), webcamClip.startMs)
    webcam = { file, times, info: await readVideoInfo(job, file) }
  }

  const micClip = project.clips.find((c) => c.kind === 'mic')
  const mic = micClip ? { file: await projectFile(dir, micClip.file), startMs: micClip.startMs } : null

  const look = project.look.background
  let background: ExportBackground
  if (look.kind === 'image' && can(plan, 'customBackground')) {
    background = { kind: 'image', bytes: new Uint8Array(await readFile(await projectFile(dir, look.file))) }
  } else {
    background = (look.kind === 'wallpaper' ? look : LOOK_DEFAULTS.background) as ExportBackground
  }

  return {
    project,
    track: buildCursorTrack(events, project.cursor),
    screenClip,
    screenFile,
    screenTimes,
    screenInfo,
    webcam,
    mic,
    background,
    pro
  }
}

async function exportShape(
  job: Job,
  session: RenderSession,
  loaded: Loaded,
  output: OutputSettings,
  shape: Shape,
  fileIndex: number,
  fileCount: number,
  onEvent: ExportOptions['onEvent']
): Promise<FileStats> {
  const { project, track, screenClip, pro } = loaded
  const gif = output.format === 'gif'
  const fps = gif ? GIF_FPS : output.fps
  const size = gif ? gifSize(shape) : outputSize(shape, output.resolution)
  const frames = Math.max(1, Math.ceil((project.durationMs * fps) / 1000))
  const id = randomBytes(6).toString('hex')
  const temp = join(output.folder, `${TEMP_PREFIX}${id}.part`)
  const lossless = join(output.folder, `${TEMP_PREFIX}${id}.lossless`)
  const palette = join(output.folder, `${TEMP_PREFIX}${id}.palette`)
  const release = trackTemps([temp, lossless, palette])
  const decode = decodeSize(
    { width: screenClip.width!, height: screenClip.height! },
    peakClipWidth(project, screenClip, size)
  )

  const report = (pct: number) => onEvent({ type: 'progress', shape, fileIndex, fileCount, pct })
  const renderShare = gif ? 90 : 100
  const started = performance.now()
  report(0)

  try {
    await session.begin(size.width, size.height, loaded.background)
    const screen = await Source.open(job, loaded.screenFile, loaded.screenTimes, loaded.screenInfo, decode)
    const webcam = loaded.webcam
      ? await Source.open(job, loaded.webcam.file, loaded.webcam.times, loaded.webcam.info, webcamSize(loaded.webcam.info))
      : null

    const encoder = gif
      ? job.ffmpeg(losslessArgs(lossless, size.width, size.height, job.threadArgs), { stdin: true })
      : job.ffmpeg(mp4Args(temp, size.width, size.height, fps, frames, loaded.mic, job.threadArgs), { stdin: true })

    const credits = new Credits(IN_FLIGHT_FRAMES)
    let written = 0
    let lastPct = -1
    let finish = () => {}
    const allWritten = new Promise<void>((done) => (finish = done))
    session.onRendered = (_n, pixels) => {
      encoder.proc.stdin!.write(pixels, (error) => {
        if (error) return job.fail(new Error('The encoder stopped accepting frames'))
        written++
        const pct = Math.floor((written / frames) * renderShare)
        if (pct !== lastPct) report((lastPct = pct))
        credits.give()
        if (written === frames) finish()
      })
    }

    for (let n = 0; n < frames; n++) {
      await credits.take(job)
      const t = (n * 1000) / fps
      const spec = compose(project, track, shape, size, t, pro)
      const screenFrame = await screen.frameAt(t)
      const webcamFrame = webcam ? await webcam.frameAt(t) : null
      session.frame(n, spec, screenFrame, webcamFrame)
    }
    await job.wait(allWritten)
    screen.stop()
    webcam?.stop()
    encoder.proc.stdin!.end()
    await job.wait(encoder.exited)

    if (gif) {
      await job.wait(job.ffmpeg(paletteArgs(lossless, palette)).exited)
      report(95)
      await job.wait(job.ffmpeg(gifArgs(lossless, palette, temp)).exited)
    }

    job.check()
    if ((await stat(temp)).size === 0) throw new Error('The encoder wrote an empty file')
    const stem = exportStem(project.name, shape, output)
    const file = await claimFile(output.folder, stem, gif ? '.gif' : '.mp4')
    await rename(temp, file).catch(async (error) => {
      await rm(file, { force: true })
      throw error
    })
    report(100)
    return { file, shape, ...size, fps, frames, decode, renderMs: performance.now() - started }
  } finally {
    job.killAll()
    await Promise.all([temp, lossless, palette].map((p) => rm(p, { force: true }).catch(() => {})))
    release()
  }
}

function checkOutput(output: OutputSettings): Shape[] {
  const shapes = [...new Set(output.shapes)]
  const valid =
    shapes.length > 0 &&
    shapes.every((s) => s === '16:9' || s === '1:1' || s === '9:16') &&
    (output.format === 'mp4' || output.format === 'gif') &&
    (output.resolution === '1080p' || output.resolution === '4k') &&
    (output.fps === 30 || output.fps === 60)
  if (!valid) throw new Error('Those export settings are not valid')
  return shapes
}

async function exportProject(options: ExportOptions): Promise<ExportResult> {
  const { projectDir, output, plan, onEvent } = options
  const shapes = checkOutput(output)
  const locked = lockedInOutput(plan, output)
  if (locked.length > 0) {
    throw new Error(`Needs Dolly Pro: ${locked.map((f) => FEATURE_LABELS[f]).join(', ')}`)
  }

  const job = new Job(options.signal, options.threads ?? exportThreads())
  await job.wait(mkdir(output.folder, { recursive: true }))
  await sweepTempFiles(output.folder)
  const loaded = await loadProject(job, projectDir, plan)
  const session = await RenderSession.open(job)
  const stats: FileStats[] = []
  try {
    for (let i = 0; i < shapes.length; i++) {
      stats.push(await exportShape(job, session, loaded, output, shapes[i], i, shapes.length, onEvent))
    }
  } finally {
    session.close()
  }
  return { files: stats.map((s) => s.file), stats }
}

// For tests/export-main.ts. Nothing in the app calls this and no IPC channel leads here,
// so the plan a test passes in can't be reached from a renderer
export function exportForTest(options: ExportOptions): Promise<ExportResult> {
  if (app.isPackaged) throw new Error('Not available in a packaged app')
  return exportProject(options)
}

// The queue

const pending: ExportRequest[] = []
let running: AbortController | null = null

async function pump(emit: (event: ExportEvent) => void): Promise<void> {
  if (running) return
  for (let request = pending.shift(); request; request = pending.shift()) {
    running = new AbortController()
    try {
      const checked = await checkRequest(request)
      const { files } = await exportProject({
        ...checked,
        plan: currentPlan(),
        signal: running.signal,
        onEvent: emit
      })
      exported.push(...files)
      emit({ type: 'done', files })
    } catch (error) {
      if (error instanceof Cancelled) emit({ type: 'cancelled' })
      else emit({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
    running = null
  }
}

function cancelAll(): void {
  pending.length = 0
  running?.abort(new Cancelled())
}

const exported: string[] = []

export const register: Register = (ctx) => {
  handleFromMain(ctx, 'export:start', (request: ExportRequest) => {
    pending.push(request)
    void pump((e) => ctx.send(CHANNELS.exportEvent, e))
  })

  handleFromMain(ctx, 'export:cancel', cancelAll)

  handleFromMain(ctx, 'export:pickFolder', async () => {
    const settings = await readFolderSettings()
    const window = ctx.mainWindow()
    const options = {
      defaultPath: settings.last ?? defaultDollyFolder(),
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options))
    const folder = picked.canceled ? undefined : picked.filePaths[0]
    if (!folder) return null
    const next = { last: folder, picked: [...new Set([...settings.picked, folder])] }
    await writeFile(settingsFile(), JSON.stringify(next))
    return folder
  })

  handleFromMain(ctx, 'export:reveal', (path: string) => {
    if (exported.includes(path)) shell.showItemInFolder(path)
  })

  // cancelAll's own cleanup is async, and the process won't live to finish it
  app.on('will-quit', () => {
    cancelAll()
    removeLiveTemps()
  })
}
