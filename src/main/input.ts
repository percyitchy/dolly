// Global mouse input. Turns OS events into CursorEvent lines in screen clip pixels, on the capture clock.
// The events come from a different place on each OS, see MouseSource.

import { createWriteStream, type WriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import type { ClickPoint } from '../shared/compose'
import type { CursorEvent, Ms, Px } from '../shared/project'
import { writeTextAtomic } from './projects'

const POLL_MS = 16

// How a raw input coordinate maps onto the clip. Events are in points on macOS and physical pixels on Windows,
// so origin and size are in whichever unit that platform reports
export interface DisplayMap {
  originX: number
  originY: number
  width: number
  height: number
  clipWidth: Px
  clipHeight: Px
}

export interface DisplayShape {
  bounds: { x: number; y: number; width: number; height: number } // DIP
  scaleFactor: number
}

// physicalOrigin is Windows only, where bounds alone can't give it on mixed DPI layouts
export function displayMapFor(
  display: DisplayShape,
  clip: { width: Px; height: Px },
  platform: NodeJS.Platform,
  physicalOrigin?: { x: number; y: number }
): DisplayMap {
  const { bounds, scaleFactor } = display
  const physical = platform === 'win32'
  return {
    originX: physical ? (physicalOrigin?.x ?? bounds.x * scaleFactor) : bounds.x,
    originY: physical ? (physicalOrigin?.y ?? bounds.y * scaleFactor) : bounds.y,
    width: physical ? Math.round(bounds.width * scaleFactor) : bounds.width,
    height: physical ? Math.round(bounds.height * scaleFactor) : bounds.height,
    clipWidth: clip.width,
    clipHeight: clip.height
  }
}

export function isOnDisplay(x: number, y: number, map: DisplayMap): boolean {
  return x >= map.originX && y >= map.originY && x < map.originX + map.width && y < map.originY + map.height
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function toClip(x: number, y: number, map: DisplayMap): { x: Px; y: Px } {
  return {
    x: round2(clamp(((x - map.originX) / map.width) * map.clipWidth, 0, map.clipWidth - 1)),
    y: round2(clamp(((y - map.originY) / map.height) * map.clipHeight, 0, map.clipHeight - 1))
  }
}

export function buttonName(button: unknown): CursorEvent['button'] {
  if (button === 1) return 'left'
  if (button === 2) return 'right'
  if (button === 3) return 'middle'
  return undefined
}

export interface RawMouse {
  kind: CursorEvent['kind']
  x: number
  y: number
  button?: unknown
}

// null when the event doesn't belong in the log: before t=0, or a move or press off the display. A release off
// the display is clamped when its press was logged, so a drag that leaves it still ends. A release with no
// logged press has nothing to end. held tracks those presses between calls
export function convertEvent(raw: RawMouse, map: DisplayMap, atMs: Ms, originMs: Ms, held: Set<unknown> = new Set()): CursorEvent | null {
  const t = Math.round((atMs - originMs) * 100) / 100
  if (t < 0) return null
  const onDisplay = isOnDisplay(raw.x, raw.y, map)
  const wasHeld = raw.kind === 'up' && held.delete(raw.button)
  if (!onDisplay && !wasHeld) return null
  if (raw.kind === 'down') held.add(raw.button)
  const event: CursorEvent = { t, ...toClip(raw.x, raw.y, map), kind: raw.kind }
  const button = raw.kind === 'move' ? undefined : buttonName(raw.button)
  if (button) event.button = button
  return event
}

// Left presses inside the recording, for the zoom engine. Left only, to match what buildCursorTrack calls a
// click: compose and the timeline find a zoom's clicks in that list, so they have to agree
export function clickPoints(events: CursorEvent[], durationMs: Ms): ClickPoint[] {
  return events
    .filter((e) => e.kind === 'down' && e.button === 'left' && e.t >= 0 && e.t <= durationMs)
    .map((e) => ({ t: e.t, x: e.x, y: e.y }))
}

export function dropClicksFrom(text: string, cutMs: Ms): string {
  const kept = text.split('\n').filter((line) => {
    if (!line.trim()) return false
    try {
      const event = JSON.parse(line) as CursorEvent
      return event.kind === 'move' || event.t < cutMs
    } catch {
      return false
    }
  })
  return kept.length ? kept.join('\n') + '\n' : ''
}

// What dolly-capture writes to its mouse log: h is host ms, k is m, d or u, x and y are points, b is the button.
// A line can be cut short if the helper died mid-write
export function parseTapLog(text: string, map: DisplayMap, hostOriginMs: Ms, held: Set<unknown> = new Set()): CursorEvent[] {
  const kinds: Record<string, CursorEvent['kind']> = { m: 'move', d: 'down', u: 'up' }
  const events: CursorEvent[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const raw = JSON.parse(line) as { h?: unknown; k?: string; x?: unknown; y?: unknown; b?: unknown }
      const kind = kinds[raw.k ?? '']
      if (!kind || typeof raw.h !== 'number' || typeof raw.x !== 'number' || typeof raw.y !== 'number') continue
      const event = convertEvent({ kind, x: raw.x, y: raw.y, button: raw.b }, map, raw.h, hostOriginMs, held)
      if (event) events.push(event)
    } catch {
      continue
    }
  }
  return events
}

function parseLogLines(text: string): CursorEvent[] {
  const events: CursorEvent[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line) as CursorEvent)
    } catch {
      continue
    }
  }
  return events
}

interface HookEvent {
  x: number
  y: number
  button?: unknown
}

export interface MouseHook {
  on(event: 'mousemove' | 'mousedown' | 'mouseup', listener: (e: HookEvent) => void): unknown
  off(event: 'mousemove' | 'mousedown' | 'mouseup', listener: (e: HookEvent) => void): unknown
  start(): void
  stop(): void
}

async function loadHook(): Promise<MouseHook> {
  const mod = (await import('uiohook-napi')) as unknown as { uIOhook?: MouseHook; default?: { uIOhook: MouseHook } }
  const hook = mod.uIOhook ?? mod.default?.uIOhook
  if (!hook) throw new Error('uiohook-napi has no hook export')
  return hook
}

// Where mouse events come from. Windows hooks them in this process. macOS never loads uiohook-napi, because
// stopping it can deadlock there: its hook thread dispatch_syncs to the main queue while stop joins that thread
// from the main thread. So dolly-capture logs the mouse itself and the log is read back when the recording stops
export type MouseSource =
  | { kind: 'hook'; hook?: MouseHook } // hook is for tests
  | { kind: 'tap'; file: string; listening: boolean }
  | { kind: 'poll' } // The user chose no clicks, so nothing global gets opened

export function mouseSourceFor(platform: NodeJS.Platform, file: string, ready: { mouseTap?: string }, clicks = true): MouseSource {
  if (!clicks) return { kind: 'poll' }
  return platform === 'darwin' ? { kind: 'tap', file, listening: ready.mouseTap === 'listening' } : { kind: 'hook' }
}

export interface InputOptions {
  file: string
  map: DisplayMap
  now: () => Ms // Same monotonic clock the origin is given in
  cursorPoint: () => { x: number; y: number } // Current position in the source's units
  source: MouseSource
}

// Writes cursor.jsonl. With no working source it polls the position while recording, so the recording keeps a
// cursor path, since the frames have no cursor of their own. Clicks need a source
export class InputLog {
  private out: WriteStream | null = null
  private hook: MouseHook | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private originMs: Ms | null = null
  private hostOriginMs: Ms | null = null
  private readonly held = new Set<unknown>()
  private lastPoll: { x: number; y: number } | null = null
  private clickEvents: CursorEvent[] = []
  private readonly onMove = (e: HookEvent) => this.take({ kind: 'move', x: e.x, y: e.y })
  private readonly onDown = (e: HookEvent) => this.take({ kind: 'down', x: e.x, y: e.y, button: e.button })
  private readonly onUp = (e: HookEvent) => this.take({ kind: 'up', x: e.x, y: e.y, button: e.button })

  constructor(private readonly options: InputOptions) {}

  // False when clicks can't be seen. The recording carries on either way
  async start(): Promise<boolean> {
    this.out = createWriteStream(this.options.file, { flags: 'a' })
    this.out.on('error', () => (this.out = null)) // A full disk shouldn't end the screen recording
    const { source } = this.options
    if (source.kind === 'poll') return this.fallBack()
    if (source.kind === 'tap') return source.listening || this.fallBack()
    let hook: MouseHook | null = source.hook ?? null
    try {
      hook ??= await loadHook()
      hook.on('mousemove', this.onMove)
      hook.on('mousedown', this.onDown)
      hook.on('mouseup', this.onUp)
      hook.start()
      this.hook = hook
      return true
    } catch {
      this.detach(hook)
      return this.fallBack()
    }
  }

  // t=0 is known once the first frame lands, on both clocks. Logs where the cursor already is, for a mouse that
  // never moves
  setOrigin(originMs: Ms, hostOriginMs: Ms): void {
    this.originMs = originMs
    this.hostOriginMs = hostOriginMs
    const { x, y } = this.options.cursorPoint()
    this.write({ t: 0, ...toClip(x, y, this.options.map), kind: 'move' })
  }

  // The helper's tap went quiet mid-recording. Whatever it logged before that is still read back at the end
  tapLost(): void {
    if (!this.poll && this.out) this.fallBack()
  }

  private fallBack(): false {
    this.poll = setInterval(() => {
      const point = this.options.cursorPoint()
      if (point.x === this.lastPoll?.x && point.y === this.lastPoll?.y) return
      this.lastPoll = point
      this.take({ kind: 'move', ...point })
    }, POLL_MS)
    return false
  }

  private stopHook(): void {
    if (!this.hook) return
    this.detach(this.hook)
    try {
      this.hook.stop()
    } catch {
      // The hook being gone already is the state we want
    }
    this.hook = null
  }

  private take(raw: RawMouse): void {
    if (this.originMs === null) return
    const event = convertEvent(raw, this.options.map, this.options.now(), this.originMs, this.held)
    if (event) this.write(event)
  }

  private write(event: CursorEvent): void {
    this.out?.write(JSON.stringify(event) + '\n')
    if (event.kind === 'down') this.clickEvents.push(event)
  }

  private detach(hook: MouseHook | null): void {
    hook?.off('mousemove', this.onMove)
    hook?.off('mousedown', this.onDown)
    hook?.off('mouseup', this.onUp)
  }

  get clicks(): CursorEvent[] {
    return this.clickEvents
  }

  async stop(): Promise<void> {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.stopHook()
    const out = this.out
    this.out = null
    if (out) await new Promise<void>((done) => out.end(() => done()))
    if (this.options.source.kind === 'tap') await this.readTapLog(this.options.source.file)
  }

  // Merged by time, since polled points can sit among the tap's if it went quiet partway. A cursor path isn't
  // worth failing a recording over, so anything wrong here leaves the log as it was. The tap's own log only goes
  // once what it held is safe in cursor.jsonl, and the zooms don't depend on that write
  private async readTapLog(path: string): Promise<void> {
    try {
      const text = await readFile(path, 'utf8')
      if (this.hostOriginMs === null) return
      const tapped = parseTapLog(text, this.options.map, this.hostOriginMs, this.held)
      if (tapped.length > 0) {
        const logged = parseLogLines(await readFile(this.options.file, 'utf8'))
        const events = [...logged, ...tapped].sort((a, b) => a.t - b.t)
        this.clickEvents = events.filter((e) => e.kind === 'down')
        await writeTextAtomic(this.options.file, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      }
      await rm(path, { force: true })
    } catch {
      return
    }
  }

  // For a stop from the menu bar: those presses were aimed at Dolly, not the recording. The zooms come from
  // clickEvents, so a log that can't be rewritten only keeps a press or two
  async dropClicksFrom(cutMs: Ms): Promise<void> {
    this.clickEvents = this.clickEvents.filter((e) => e.t < cutMs)
    try {
      await writeTextAtomic(this.options.file, dropClicksFrom(await readFile(this.options.file, 'utf8'), cutMs))
    } catch {
      return
    }
  }
}
