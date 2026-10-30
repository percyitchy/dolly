// Records a display. The native helper owns the frames and the clock: its first frame is t=0, and input,
// mic and webcam are all converted to that clock. Failures before recording starts reject capture:start.
// Failures after that arrive as an error event.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { rename, rm, stat, statfs } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray, type Display, type WebContents } from 'electron'
import { buildZooms } from '../engine/zoom'
import { can } from '../shared/entitlements'
import {
  CHANNELS,
  type CaptureEvent,
  type DisplayInfo,
  type PermissionKind,
  type PermissionState,
  type RecorderCommand,
  type RecorderEvent,
  type RecorderKind,
  type RecordingOptions
} from '../shared/ipc'
import { CURSOR_DEFAULTS, LOOK_DEFAULTS, type Clip, type Ms, type Project, type ZoomSegment } from '../shared/project'
import { handleFromMain, type MainContext, type Register } from './context'
import { clickPoints, displayMapFor, InputLog, mouseSourceFor } from './input'
import { currentPlan } from './license'
import { defaultDollyFolder, ffmpegInput, ffmpegPath, nativeBin, pageUrl } from './paths'
import { allPermissions, isPermissionKind, openPermissionSettings, permissionStatus, requestPermission } from './permissions'
import { checkProjectDir, createProjectDir, CURSOR_FILE, PROJECT_EXT, PROJECT_FILE, sanitizeName, writeJsonAtomic } from './projects'
import { grantRecorderMedia, revokeRecorderMedia, secureWebPreferences } from './window-guard'

const SHORTCUT = 'CommandOrControl+Shift+2'
const STOP_BAR = { width: 150, height: 42, top: 12 }
const SCREEN_FILE = 'screen.mp4'
const MOUSE_FILE = 'mouse.jsonl' // The macOS helper's log. It's read into cursor.jsonl and deleted
const START_TIMEOUT_MS = 30000 // Generous, since the first launch of a helper or renderer can take seconds
const STOP_TIMEOUT_MS = 30000
const RECORDER_TIMEOUT_MS = 10000
const REMUX_TIMEOUT_MS = 120000
const SYNC_ROUNDS = 7
const TRAY_CLICK_MARGIN_MS = 500 // Presses this close before the tray menu opened were aimed at it
const TRAY_MENU_ASSUMED_MS = 1000 // How long the menu is assumed open if it never said so
const MIN_TRIMMED_MS = 1000 // A tray cut that keeps less than this isn't worth making
const WEBCAM_DEFAULT = { shape: 'circle', corner: 'br', sizePct: 22 } as const
const PROBE_TIMEOUT_MS = 10000
const DISK_WATCH_MS = 2000
const DISK_FREE_TIMEOUT_MS = 5000
// 60 Mbit/s tops out at 450 MB a minute, so this is a couple of minutes at worst
export const MIN_FREE_TO_START = 1024 ** 3
// Enough to finish: what the encoder still holds, the mic and webcam remux, project.json
export const MIN_FREE_TO_CONTINUE = 300 * 1024 ** 2
const NO_SPACE = "There isn't enough free disk space to record. Free up at least 1 GB on the disk with your Dolly folder and try again."
const NOTHING_SAVED = "The disk filled up before the recording could be finished, so it can't be played. Free up some space and try again."
const DISK_LOW = 'The recording stopped early because the disk is nearly full. What was recorded is saved.'
const WRITE_FAILED = 'The recording stopped early because the file could not be written, which usually means the disk is full. What was recorded up to the last few seconds is saved.'
const CLICKS_LOST = 'Dolly stopped receiving mouse events, so clicks after that point are missing and have no automatic zooms.'
const RESOLUTION_CHANGED = "The recording stopped because the display's resolution changed. What was recorded before that is saved."
const STOPPED_EARLY = 'The recording stopped early because the screen stopped sending frames, for example when a display was unplugged or the computer went to sleep. What was recorded is saved.'
const REAL_CURSOR = "This version of Windows can't hide the real cursor, so it will show in the video alongside Dolly's. Updating Windows fixes that."
const YELLOW_BORDER = "Windows draws a yellow border around the screen while recording, and this version of Windows can't turn it off."

export type HelperMessage =
  | {
      type: 'ready'
      width: number
      height: number
      fps: number
      scaleFactor: number
      hostMs: number
      mouseTap?: string // macOS: listening, disabled or unavailable
      listenAccess?: boolean // macOS: Input Monitoring, as the helper sees it
      cursorHidden?: boolean // Windows: false on builds that can't leave the real cursor out
      borderHidden?: boolean // Windows: false on builds that can't drop the yellow border
    }
  | { type: 'firstFrame'; hostMs: number }
  | { type: 'pong'; hostMs: number }
  | { type: 'tapLost' }
  | {
      type: 'stopped'
      reason: string
      durationMs: number
      frames: number
      repeats: number
      dropped: number
      tapEvents?: number
      mouseTap?: string
      resolutionChanged?: boolean // Windows: why an interrupted recording ended
    }
  | { type: 'diskFree'; bytes: number }
  | { type: 'error'; message: string; code?: string }

type ReadyMessage = Extract<HelperMessage, { type: 'ready' }>
type StoppedMessage = Extract<HelperMessage, { type: 'stopped' }>

export function parseHelperLine(line: string): HelperMessage | null {
  try {
    const message = JSON.parse(line) as HelperMessage
    return typeof message?.type === 'string' ? message : null
  } catch {
    return null
  }
}

export interface ClockSample {
  sentMs: Ms // Local clock, just before asking
  receivedMs: Ms // Local clock, just after the answer
  remoteMs: Ms
}

// Why a recording is shorter than the user asked for. Stopping it themselves needs no explaining
export function stopWarnings(reason: string, diskLow = false, resolutionChanged = false): string[] {
  if (diskLow) return [DISK_LOW]
  if (reason === 'requested') return []
  if (reason === 'write-failed') return [WRITE_FAILED]
  return [resolutionChanged ? RESOLUTION_CHANGED : STOPPED_EARLY]
}

// What this recording will lack, going by what the helper could set up
export function readyWarnings(ready: Pick<ReadyMessage, 'cursorHidden' | 'borderHidden'>): string[] {
  return [...(ready.cursorHidden === false ? [REAL_CURSOR] : []), ...(ready.borderHidden === false ? [YELLOW_BORDER] : [])]
}

export function clicksWarning(platform: NodeJS.Platform): string {
  const fix = platform === 'darwin' ? ' Allow Input Monitoring for Dolly to fix that.' : ''
  return `Clicks are not being recorded, so this recording has no automatic zooms.${fix}`
}

export function freeBytes(stats: { bavail: number; bsize: number }): number {
  return stats.bavail * stats.bsize
}

type ReadSpace = (path: string) => Promise<{ bavail: number; bsize: number }>
type ReadImportant = (path: string) => Promise<number | null>

// macOS only. What a volume would make available for something that matters, counting what the system can purge
// on demand, such as snapshots and caches. Null means ask statfs instead
export function importantBytes(path: string): Promise<number | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((done) => {
    execFile(nativeBin('dolly-capture'), ['disk-free', '--path', path], { timeout: DISK_FREE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const reply = error ? null : parseHelperLine(stdout.trim())
      done(reply?.type === 'diskFree' ? reply.bytes : null)
    })
  })
}

// statfs leaves out purgeable space, but it's cheap and what it counts is certainly free. So the helper only gets
// asked when statfs says there isn't enough, which keeps a process from starting every few seconds of a recording
async function hasRoom(dir: string, bytes: number, read: ReadSpace, important: ReadImportant): Promise<boolean> {
  if (freeBytes(await read(dir)) >= bytes) return true
  return ((await important(dir)) ?? 0) >= bytes
}

// A disk that can't say how full it is gets the benefit of the doubt, as the helper still copes when it fills
export async function checkFreeSpace(dir: string, read: ReadSpace = statfs, important: ReadImportant = importantBytes): Promise<void> {
  if (!(await hasRoom(dir, MIN_FREE_TO_START, read, important).catch(() => true))) throw new Error(NO_SPACE)
}

// Stops a recording while there's still room to finish it. Returns what ends the watch
export function watchFreeSpace(
  dir: string,
  onLow: () => void,
  read: ReadSpace = statfs,
  everyMs: number = DISK_WATCH_MS,
  important: ReadImportant = importantBytes
): () => void {
  let ended = false
  let busy = false // Asking the helper can outlast the interval
  const end = () => {
    ended = true
    clearInterval(timer)
  }
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    hasRoom(dir, MIN_FREE_TO_CONTINUE, read, important).then(
      (room) => {
        busy = false
        if (room || ended) return
        end()
        onLow()
      },
      () => (busy = false)
    )
  }, everyMs)
  return end
}

// ffmpeg prints this for a fragmented file too, counting only the fragments that are whole
export function parseDuration(text: string): Ms | null {
  const found = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text)
  if (!found) return null
  return Math.round((Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])) * 1000)
}

// The length of a file that couldn't be finished, which ends on a fragment rather than where writing stopped.
// Null when ffmpeg finds no length, as with a Windows file that never got its index
function playableMs(path: string): Promise<Ms | null> {
  return new Promise((done) => {
    let text = ''
    const child = spawn(ffmpegPath(), ['-hide_banner', ...ffmpegInput(path)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (text += chunk))
    const finish = () => {
      clearTimeout(timer)
      done(parseDuration(text))
    }
    child.on('error', finish)
    child.on('close', finish)
  })
}

// What to add to a local time to get the remote clock. The quickest round trip is the most trustworthy,
// and the remote read is assumed to land halfway through it
export function clockOffset(samples: ClockSample[]): number {
  if (samples.length === 0) throw new Error('No clock samples')
  const best = samples.reduce((a, b) => (b.receivedMs - b.sentMs < a.receivedMs - a.sentMs ? b : a))
  return best.remoteMs - (best.sentMs + best.receivedMs) / 2
}

// How long the saved video is. A failed write means the helper's own count is too long, so ask the file. A file
// that can't say won't open either, and the warning for a failed write promises one that does
export async function savedMs(stopped: Pick<StoppedMessage, 'reason' | 'durationMs'>, probe: () => Promise<Ms | null>): Promise<Ms> {
  const durationMs = stopped.reason === 'write-failed' ? await probe() : stopped.durationMs
  if (!durationMs) throw new Error(NOTHING_SAVED)
  return durationMs
}

// Where a stop from the tray ends the video: where the menu opened, so preview and export never show it. The stop
// click comes well after that, and there's nothing to cut if the menu never said when it opened
export function trayEndMs(durationMs: Ms, menuOpenedMs: Ms | null): Ms {
  if (menuOpenedMs === null || menuOpenedMs < MIN_TRIMMED_MS || menuOpenedMs >= durationMs) return durationMs
  return round2(menuOpenedMs)
}

function nowMs(): Ms {
  return Number(process.hrtime.bigint()) / 1e6
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error))
    )
  })
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  promise.catch(() => {}) // Whoever needs the failure awaits it. Nobody else should see an unhandled rejection
  return { promise, resolve, reject }
}

export class CaptureHelper {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly readyD = deferred<ReadyMessage>()
  private readonly firstFrameD = deferred<number>()
  private readonly stoppedD = deferred<StoppedMessage>()
  private readonly tapLostD = deferred<void>()
  private readonly pongs: ((hostMs: number) => void)[] = []
  private buffer = ''
  private lastError: string | null = null

  readonly ready = this.readyD.promise
  readonly firstFrame = this.firstFrameD.promise
  readonly stopped = this.stoppedD.promise
  readonly tapLost = this.tapLostD.promise

  constructor(bin: string, args: string[]) {
    this.child = spawn(bin, args, { stdio: 'pipe', windowsHide: true })
    this.child.stdin.on('error', () => {}) // Writing after the helper left. Its exit reports that
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (text: string) => this.read(text))
    this.child.stderr.resume()
    this.child.on('error', (error) => this.failAll(`Couldn't start the capture helper: ${error.message}`))
    // close, not exit: exit can arrive before the last lines of stdout have been read
    this.child.on('close', () => this.failAll(this.lastError ?? 'The capture helper stopped unexpectedly'))
  }

  private read(text: string): void {
    this.buffer += text
    let end = this.buffer.indexOf('\n')
    while (end >= 0) {
      const message = parseHelperLine(this.buffer.slice(0, end))
      this.buffer = this.buffer.slice(end + 1)
      if (message) this.handle(message)
      end = this.buffer.indexOf('\n')
    }
  }

  private handle(message: HelperMessage): void {
    if (message.type === 'ready') this.readyD.resolve(message)
    else if (message.type === 'firstFrame') this.firstFrameD.resolve(message.hostMs)
    else if (message.type === 'pong') this.pongs.shift()?.(message.hostMs)
    else if (message.type === 'tapLost') this.tapLostD.resolve()
    else if (message.type === 'stopped') this.stoppedD.resolve(message)
    else if (message.type === 'error') this.lastError = message.message
  }

  private failAll(message: string): void {
    const error = new Error(message)
    this.readyD.reject(error)
    this.firstFrameD.reject(error)
    this.stoppedD.reject(error)
    this.tapLostD.reject(error)
  }

  private send(line: string): void {
    if (this.child.stdin.writable) this.child.stdin.write(line + '\n')
  }

  async ping(): Promise<ClockSample> {
    const reply = new Promise<number>((resolve) => this.pongs.push(resolve))
    const sentMs = nowMs()
    this.send('ping')
    const remoteMs = await reply
    return { sentMs, receivedMs: nowMs(), remoteMs }
  }

  stop(): void {
    this.send('stop')
  }

  kill(): void {
    this.child.kill('SIGKILL')
  }
}

// The hidden window that holds getUserMedia. Main picks the file names, the page only ever sends bytes
class RecorderWindow {
  private readonly win: BrowserWindow
  private readonly contents: WebContents
  private readonly files = new Map<RecorderKind, WriteStream>()
  private readonly waiters = new Set<{ test(e: RecorderEvent): boolean; resolve(e: RecorderEvent): void; reject(e: Error): void }>()
  private ended = new Map<RecorderKind, Ms>()
  private closed = false
  readonly started = new Map<RecorderKind, Extract<RecorderEvent, { type: 'started' }>>()
  readonly kinds: RecorderKind[]
  private offsetMs = 0 // Page clock minus main clock
  private nextSync = 1

  constructor(private readonly dir: string, mic: boolean, webcam: boolean) {
    this.kinds = [...(mic ? (['mic'] as const) : []), ...(webcam ? (['webcam'] as const) : [])]
    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: secureWebPreferences('recorder', { backgroundThrottling: false })
    })
    this.contents = this.win.webContents
    grantRecorderMedia(this.contents, { audio: mic, video: webcam })
  }

  isSender(sender: Electron.WebContents): boolean {
    return !this.win.isDestroyed() && sender === this.win.webContents
  }

  handleReport(event: RecorderEvent): void {
    if (event.type === 'started') this.started.set(event.kind, event)
    if (event.type === 'ended') this.ended.set(event.kind, event.at)
    for (const waiter of [...this.waiters]) {
      if (event.type === 'failed') {
        this.waiters.delete(waiter)
        waiter.reject(new Error(event.message))
      } else if (waiter.test(event)) {
        this.waiters.delete(waiter)
        waiter.resolve(event)
      }
    }
  }

  handleChunk(kind: RecorderKind, data: ArrayBuffer): void {
    if (this.closed || !this.kinds.includes(kind)) return // Reopening a finished file would truncate it
    let file = this.files.get(kind)
    if (!file) {
      file = createWriteStream(join(this.dir, `${kind}.webm`))
      file.on('error', () => {}) // A short clip beats losing the screen recording too
      this.files.set(kind, file)
    }
    file.write(Buffer.from(data))
  }

  private command(command: RecorderCommand): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(CHANNELS.recorderCommand, command)
  }

  private waitFor(test: (e: RecorderEvent) => boolean, ms: number, message: string): Promise<RecorderEvent> {
    return withTimeout(
      new Promise<RecorderEvent>((resolve, reject) => this.waiters.add({ test, resolve, reject })),
      ms,
      message
    )
  }

  async open(): Promise<void> {
    const loaded = this.waitFor((e) => e.type === 'loaded', START_TIMEOUT_MS, "The recorder window didn't load")
    void this.win.loadURL(pageUrl('recorder.html'))
    await loaded
  }

  // The first getUserMedia can take a while, so it happens before the helper starts the clock
  async prepare(): Promise<void> {
    const prepared = this.waitFor((e) => e.type === 'prepared', START_TIMEOUT_MS, "The microphone or camera didn't open")
    this.command({ type: 'prepare', mic: this.kinds.includes('mic'), webcam: this.kinds.includes('webcam') })
    await prepared
  }

  async syncClock(): Promise<void> {
    const samples: ClockSample[] = []
    for (let i = 0; i < SYNC_ROUNDS; i++) {
      const id = this.nextSync++
      const reply = this.waitFor((e) => e.type === 'sync' && e.id === id, RECORDER_TIMEOUT_MS, "The recorder window isn't answering")
      const sentMs = nowMs()
      this.command({ type: 'sync', id })
      const event = await reply
      if (event.type === 'sync') samples.push({ sentMs, receivedMs: nowMs(), remoteMs: event.now })
    }
    this.offsetMs = clockOffset(samples)
  }

  // Main-clock time of a page timestamp
  toMain(pageMs: Ms): Ms {
    return pageMs - this.offsetMs
  }

  async begin(): Promise<void> {
    const started = this.kinds.map((kind) =>
      this.waitFor((e) => e.type === 'started' && e.kind === kind, RECORDER_TIMEOUT_MS, `The ${kind} recording didn't start`)
    )
    this.command({ type: 'begin' })
    await Promise.all(started)
  }

  // Waits for the last chunks. A kind that never reports back keeps whatever reached the disk
  async end(): Promise<void> {
    const ended = this.kinds
      .filter((kind) => this.started.has(kind))
      .map((kind) =>
        this.waitFor((e) => e.type === 'ended' && e.kind === kind, RECORDER_TIMEOUT_MS, `The ${kind} recording didn't stop`)
      )
    this.command({ type: 'end' })
    await Promise.allSettled(ended)
    this.closed = true
    await Promise.all([...this.files.values()].map((f) => new Promise<void>((done) => f.end(() => done()))))
    this.files.clear()
  }

  endedAt(kind: RecorderKind): Ms | undefined {
    return this.ended.get(kind)
  }

  destroy(): void {
    revokeRecorderMedia(this.contents)
    if (!this.win.isDestroyed()) this.win.destroy()
  }
}

export interface MediaClipInput {
  kind: 'mic' | 'webcam'
  file: string
  startMs: Ms
  durationMs: Ms
  width?: number
  height?: number
  fps?: number
}

export interface ProjectInput {
  id: string
  name: string
  createdAt: string
  durationMs: Ms
  screen: { file: string; width: number; height: number; fps: number; scaleFactor: number }
  media: MediaClipInput[]
  zooms: ZoomSegment[]
  folder: string
}

export function buildProject(input: ProjectInput): Project {
  const { screen: clip, media } = input
  const clips: Clip[] = [
    { id: randomUUID(), kind: 'screen', startMs: 0, durationMs: input.durationMs, ...clip },
    ...media.map((m) => ({ id: randomUUID(), ...m }))
  ]
  return {
    version: 1,
    id: input.id,
    name: input.name,
    createdAt: input.createdAt,
    durationMs: input.durationMs,
    clips,
    zooms: input.zooms,
    look: { ...LOOK_DEFAULTS, background: { ...LOOK_DEFAULTS.background } },
    cursor: { ...CURSOR_DEFAULTS },
    webcam: media.some((m) => m.kind === 'webcam') ? { ...WEBCAM_DEFAULT } : null,
    captions: [],
    output: { shapes: ['16:9', '1:1'], format: 'mp4', resolution: '1080p', fps: 30, folder: input.folder }
  }
}

export function defaultProjectName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
  return `Recording ${day} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`
}

export function checkOptions(value: unknown): RecordingOptions {
  const o = value as Partial<RecordingOptions> | null
  if (typeof o?.displayId !== 'string' || typeof o.mic !== 'boolean' || typeof o.webcam !== 'boolean' || typeof o.clicks !== 'boolean') {
    throw new Error('Bad recording options')
  }
  return { displayId: o.displayId, mic: o.mic, webcam: o.webcam, clicks: o.clicks, name: typeof o.name === 'string' ? o.name : undefined }
}

// The tap only opens for a recording that wants clicks and has the permission. Otherwise main polls the cursor
export function mouseLogArgs(file: string, clicks: boolean, platform: NodeJS.Platform, access: PermissionState): string[] {
  return platform === 'darwin' && clicks && access === 'granted' ? ['--mouse-log', file] : []
}

// WebM from MediaRecorder has no duration or seek index. A stream copy adds both, so the editor can seek.
// If it fails the original still plays
function remux(path: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.webm`
  return new Promise<void>((resolve) => {
    const child = spawn(ffmpegPath(), ['-y', '-v', 'error', ...ffmpegInput(path), '-c', 'copy', temp], { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), REMUX_TIMEOUT_MS)
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      const moved = ok ? rename(temp, path) : Promise.reject(new Error('remux failed'))
      moved.catch(() => rm(temp, { force: true })).finally(resolve)
    }
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
  })
}

async function hasData(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

// A dot in a template image, so the menu bar tints it. Windows gets a red one, since it has no template images
function trayIcon(): Electron.NativeImage {
  const scale = 2
  const size = 16 * scale
  const [b, g, r] = process.platform === 'darwin' ? [0, 0, 0] : [0x30, 0x3b, 0xff]
  const data = Buffer.alloc(size * size * 4)
  const centre = (size - 1) / 2
  const radius = size * 0.32
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x - centre, y - centre)))
      const at = (y * size + x) * 4
      data[at] = b * a
      data[at + 1] = g * a
      data[at + 2] = r * a
      data[at + 3] = a * 255
    }
  }
  const image = nativeImage.createFromBuffer(data, { width: size, height: size, scaleFactor: scale })
  image.setTemplateImage(process.platform === 'darwin')
  return image
}

function displayInfo(display: Display): DisplayInfo {
  return {
    id: String(display.id),
    // macOS gives the built-in screen's name in the system language, and the app is in English
    name: display.internal ? 'Built-in Display' : display.label || `Display ${display.id}`,
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
    scaleFactor: display.scaleFactor,
    primary: display.id === screen.getPrimaryDisplay().id
  }
}

function physicalOrigin(display: Display): { x: number; y: number } | undefined {
  if (process.platform !== 'win32') return undefined
  return screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
}

// What the helper takes as --display: a display ID on macOS, a point on the monitor on Windows
function helperDisplayArg(display: Display): string {
  const origin = physicalOrigin(display)
  return origin ? `${origin.x},${origin.y}` : String(display.id)
}

// The cursor in the mouse source's units: points on macOS, physical pixels on Windows
function mouseCursorPoint(): { x: number; y: number } {
  const point = screen.getCursorScreenPoint()
  return process.platform === 'win32' ? screen.dipToScreenPoint(point) : point
}

interface Session {
  id: string
  dir: string
  name: string
  createdAt: string
  helper: CaptureHelper
  input: InputLog
  recorder: RecorderWindow | null
  ready: ReadyMessage
  originMs: Ms // t=0 on this process's clock
  stopping: Promise<void> | null
  endDiskWatch: () => void
  diskLow: boolean
}

let context: MainContext | null = null
let session: Session | null = null
let starting = false
let tray: Tray | null = null
let stopBars: BrowserWindow[] = []
let trayOpenedAt: Ms | null = null
let quitting = false
let activeRecorder: RecorderWindow | null = null

function send(event: CaptureEvent): void {
  context?.send(CHANNELS.captureEvent, event)
}

function showMainWindow(): void {
  const win = context?.mainWindow()
  if (win && !win.isDestroyed()) win.show()
}

export function isRecording(): boolean {
  return session !== null || starting
}

// Runs every step even if one throws, and always ends with last
export async function cleanUp(steps: (() => unknown)[], last: () => void): Promise<void> {
  try {
    for (const step of steps) {
      try {
        await step()
      } catch {
        // Whatever went wrong before this matters more than a failed cleanup
      }
    }
  } finally {
    last()
  }
}

function clearRecordingUi(): void {
  globalShortcut.unregister(SHORTCUT)
  for (const bar of stopBars) if (!bar.isDestroyed()) bar.destroy()
  stopBars = []
  tray?.destroy()
  tray = null
  trayOpenedAt = null
}

// The menu bar icon can sit hidden behind a Mac's notch, so the visible way to stop is this bar, on every screen and
// over every window. It stays out of the video: the macOS helper leaves Dolly's own windows out, and content protection
// does the same on Windows
function showStopBar(display: Display): void {
  const { x, y, width } = display.workArea
  const bar = new BrowserWindow({
    x: Math.round(x + (width - STOP_BAR.width) / 2),
    y: y + STOP_BAR.top,
    width: STOP_BAR.width,
    height: STOP_BAR.height,
    // Only a panel can sit over another app's full screen space on macOS
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    acceptFirstMouse: true,
    show: false,
    roundedCorners: true,
    backgroundColor: '#0E1014',
    webPreferences: secureWebPreferences('stopbar')
  })
  bar.setContentProtection(true)
  bar.setAlwaysOnTop(true, 'screen-saver')
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  bar.once('ready-to-show', () => bar.showInactive())
  void bar.loadURL(pageUrl('stopbar.html'))
  stopBars.push(bar)
}

function showRecordingUi(): void {
  screen.getAllDisplays().forEach(showStopBar)
  globalShortcut.register(SHORTCUT, () => void stopRecording())
  const menu = Menu.buildFromTemplate([
    { label: 'Stop Recording', accelerator: SHORTCUT, registerAccelerator: false, click: () => void stopRecording({ fromTray: true }) }
  ])
  menu.on('menu-will-show', () => (trayOpenedAt = nowMs()))
  tray = new Tray(trayIcon())
  tray.setToolTip('Dolly is recording')
  tray.setContextMenu(menu)
  if (process.platform === 'win32') tray.on('click', () => tray?.popUpContextMenu())
}

async function startRecording(options: RecordingOptions): Promise<void> {
  const display = screen.getAllDisplays().find((d) => String(d.id) === options.displayId)
  if (!display) throw new Error("That display isn't connected anymore.")
  const permission = await permissionStatus('screen')
  if (permission !== 'granted' && permission !== 'not-needed') throw new Error('Dolly needs Screen Recording permission.')

  const webcam = options.webcam && can(currentPlan(), 'webcam')
  const createdAt = new Date()
  const dir = await createProjectDir(defaultDollyFolder(), sanitizeName(options.name, defaultProjectName(createdAt)))

  let recorder: RecorderWindow | null = null
  let helper: CaptureHelper | null = null
  let input: InputLog | null = null
  const warnings: string[] = []

  try {
    await checkFreeSpace(dir)
    if (options.mic || webcam) {
      recorder = new RecorderWindow(dir, options.mic, webcam)
      activeRecorder = recorder
      await recorder.open()
      await recorder.prepare()
      await recorder.syncClock()
    }

    // The recording shouldn't open on Dolly's own window
    context?.mainWindow()?.hide()

    const mouseFile = join(dir, MOUSE_FILE)
    const mouseArgs = mouseLogArgs(mouseFile, options.clicks, process.platform, await permissionStatus('input-monitoring'))
    helper = new CaptureHelper(nativeBin('dolly-capture'), ['record', '--display', helperDisplayArg(display), '--output', join(dir, SCREEN_FILE), ...mouseArgs])
    const ready = await withTimeout(helper.ready, START_TIMEOUT_MS, 'The capture helper took too long to start')
    const samples: ClockSample[] = []
    for (let i = 0; i < SYNC_ROUNDS; i++) samples.push(await withTimeout(helper.ping(), START_TIMEOUT_MS, 'The capture helper stopped answering'))
    const offset = clockOffset(samples)

    const log = new InputLog({
      file: join(dir, CURSOR_FILE),
      map: displayMapFor(display, ready, process.platform, physicalOrigin(display)),
      now: nowMs,
      cursorPoint: mouseCursorPoint,
      source: mouseSourceFor(process.platform, mouseFile, ready, options.clicks)
    })
    input = log
    warnings.push(...readyWarnings(ready))
    if (!(await log.start()) && options.clicks) warnings.push(clicksWarning(process.platform))
    helper.tapLost.then(
      () => {
        log.tapLost()
        warnings.push(CLICKS_LOST)
        send({ type: 'warning', message: CLICKS_LOST })
      },
      () => {}
    )

    const firstHostMs = await withTimeout(helper.firstFrame, START_TIMEOUT_MS, 'No frames arrived from the screen')
    const originMs = firstHostMs - offset
    input.setOrigin(originMs, firstHostMs)
    if (recorder) await recorder.begin()

    const name = basename(dir, PROJECT_EXT)
    const current: Session = {
      id: randomUUID(),
      dir,
      name,
      createdAt: createdAt.toISOString(),
      helper,
      input,
      recorder,
      ready,
      originMs,
      stopping: null,
      diskLow: false,
      endDiskWatch: watchFreeSpace(dir, () => {
        current.diskLow = true
        void stopRecording()
      })
    }
    session = current
    showRecordingUi()
    helper.stopped.then(
      () => void stopRecording(),
      (error: Error) => failRecording(current, error)
    )
    send({ type: 'started', projectDir: dir, ...(warnings.length ? { warnings } : {}) })
  } catch (error) {
    await cleanUp(
      [
        () => input?.stop(),
        () => helper?.kill(),
        () => recorder?.destroy(),
        () => (activeRecorder = null),
        () => rm(checkProjectDir(defaultDollyFolder(), dir), { recursive: true, force: true })
      ],
      showMainWindow
    )
    throw error
  }
}

function mediaClips(s: Session): MediaClipInput[] {
  const recorder = s.recorder
  if (!recorder) return []
  const clips: MediaClipInput[] = []
  for (const kind of recorder.kinds) {
    const started = recorder.started.get(kind)
    if (!started) continue
    const endedAt = recorder.endedAt(kind)
    clips.push({
      kind,
      file: `${kind}.webm`,
      startMs: round2(Math.max(0, recorder.toMain(started.at) - s.originMs)),
      durationMs: round2(endedAt === undefined ? 0 : endedAt - started.at),
      ...(kind === 'webcam' ? { width: started.width, height: started.height, fps: started.fps } : {})
    })
  }
  return clips
}

async function finishRecording(s: Session, fromTray: boolean): Promise<void> {
  const menuOpened = fromTray ? trayOpenedAt : null
  const trayOpened = trayOpenedAt ?? nowMs() - TRAY_MENU_ASSUMED_MS
  s.endDiskWatch()
  try {
    s.helper.stop()
    const [stopped] = await Promise.all([
      withTimeout(s.helper.stopped, STOP_TIMEOUT_MS, "The screen recording didn't finish writing"),
      s.recorder?.end()
    ])
    await s.input.stop()
    if (fromTray) await s.input.dropClicksFrom(trayOpened - s.originMs - TRAY_CLICK_MARGIN_MS)

    const { width, height, fps, scaleFactor } = s.ready
    const { reason } = stopped
    const recordedMs = await savedMs(stopped, () => playableMs(join(s.dir, SCREEN_FILE)))
    const durationMs = trayEndMs(recordedMs, menuOpened === null ? null : menuOpened - s.originMs)
    const media: MediaClipInput[] = []
    for (const clip of mediaClips(s)) {
      const path = join(s.dir, clip.file)
      if (!(await hasData(path))) continue
      await remux(path)
      media.push(clip.durationMs > 0 ? clip : { ...clip, durationMs: round2(Math.max(0, recordedMs - clip.startMs)) })
    }

    const zooms = buildZooms(clickPoints(s.input.clicks, durationMs), durationMs, { width, height })
    const project = buildProject({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      durationMs,
      screen: { file: SCREEN_FILE, width, height, fps, scaleFactor },
      media,
      zooms,
      folder: defaultDollyFolder()
    })
    await writeJsonAtomic(join(s.dir, PROJECT_FILE), project)
    const warnings = stopWarnings(reason, s.diskLow, stopped.resolutionChanged)
    send({ type: 'stopped', projectId: s.id, tapEvents: stopped.tapEvents, ...(warnings.length ? { warnings } : {}) })
  } catch (error) {
    s.helper.kill()
    await s.input.stop()
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    s.recorder?.destroy()
    activeRecorder = null
    clearRecordingUi()
    session = null
    showMainWindow()
    if (quitting) app.quit()
  }
}

function stopRecording(options: { fromTray?: boolean } = {}): Promise<void> {
  const s = session
  if (!s) return Promise.resolve()
  s.stopping ??= finishRecording(s, options.fromTray ?? false)
  return s.stopping
}

// The helper died mid-recording, so the file can't be finalized. The folder stays, as the partial data isn't Dolly's to delete
function failRecording(s: Session, error: Error): void {
  if (s.stopping || session !== s) return
  s.stopping = (async () => {
    s.endDiskWatch()
    await s.input.stop()
    s.recorder?.destroy()
    activeRecorder = null
    clearRecordingUi()
    session = null
    showMainWindow()
    send({ type: 'error', message: error.message })
  })()
}

// Windows has no way to ask, so Allow tries the device the way a recording would
async function probeMedia(kind: PermissionKind): Promise<boolean> {
  if (session || starting) throw new Error('Dolly is already recording.')
  starting = true
  const recorder = new RecorderWindow('', kind === 'microphone', kind === 'camera')
  activeRecorder = recorder
  try {
    await recorder.open()
    await recorder.prepare()
    return true
  } catch {
    return false
  } finally {
    recorder.destroy()
    activeRecorder = null
    starting = false
  }
}

export const register: Register = (ctx) => {
  context = ctx

  handleFromMain(ctx, 'capture:displays', () => screen.getAllDisplays().map(displayInfo))
  handleFromMain(ctx, 'capture:permissions', () => allPermissions())
  handleFromMain(ctx, 'capture:openPermissionSettings', (kind: unknown) => {
    if (!isPermissionKind(kind)) throw new Error('Unknown permission')
    return openPermissionSettings(kind)
  })
  handleFromMain(ctx, 'capture:requestPermission', (kind: unknown) => {
    if (!isPermissionKind(kind)) throw new Error('Unknown permission')
    return requestPermission(kind, probeMedia)
  })
  handleFromMain(ctx, 'capture:start', async (options: unknown) => {
    if (session || starting) throw new Error('Dolly is already recording.')
    starting = true
    try {
      await startRecording(checkOptions(options))
    } finally {
      starting = false
    }
  })
  handleFromMain(ctx, 'capture:stop', () => stopRecording())

  const fromStopBar = (sender: WebContents) => stopBars.some((bar) => !bar.isDestroyed() && sender === bar.webContents)
  // From the moment the cursor reaches Stop, the rest is the end of the video being left behind
  ipcMain.on(CHANNELS.stopBarHover, (event) => {
    if (fromStopBar(event.sender)) trayOpenedAt = nowMs()
  })
  ipcMain.on(CHANNELS.stopBarStop, (event) => {
    if (fromStopBar(event.sender)) void stopRecording({ fromTray: true })
  })
  ipcMain.on(CHANNELS.recorderReport, (event, report: RecorderEvent) => {
    if (activeRecorder?.isSender(event.sender)) activeRecorder.handleReport(report)
  })
  ipcMain.on(CHANNELS.recorderChunk, (event, kind: RecorderKind, data: ArrayBuffer) => {
    if (activeRecorder?.isSender(event.sender)) activeRecorder.handleChunk(kind, data)
  })

  // Quitting mid-recording saves it first
  app.on('before-quit', (event) => {
    if (!session) return
    event.preventDefault()
    quitting = true
    void stopRecording()
  })
}
