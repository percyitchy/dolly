import { describe, expect, it } from 'vitest'
import { buildCursorTrack } from '../src/engine/cursor'
import type { CursorTrack } from '../src/shared/compose'
import type { CursorEvent, CursorStyle } from '../src/shared/project'
import { CURSOR_DEFAULTS } from '../src/shared/project'

const SMOOTH: CursorStyle = { ...CURSOR_DEFAULTS, smooth: true }
const RAW: CursorStyle = { ...CURSOR_DEFAULTS, smooth: false }
const FRAME_MS = 1000 / 60

// The fastest a critically damped spring moves through a step of size D is D * omega / e
const NATURAL_RATE = Math.sqrt(CURSOR_DEFAULTS.stiffness) / Math.E

const STYLES: CursorStyle[] = [
  SMOOTH,
  { ...SMOOTH, stiffness: 40, damping: 12.6 }, // Soft
  { ...SMOOTH, stiffness: 600, damping: 49 }, // Tight
  { ...SMOOTH, stiffness: 300, damping: 10 }, // Bouncy
  { ...SMOOTH, stiffness: 120, damping: 40 } // Overdamped
]

function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const move = (t: number, x: number, y: number): CursorEvent => ({ t, x, y, kind: 'move' })
const down = (t: number, x: number, y: number): CursorEvent => ({ t, x, y, kind: 'down', button: 'left' })
const up = (t: number, x: number, y: number): CursorEvent => ({ t, x, y, kind: 'up', button: 'left' })

// Bell-shaped moves between targets with hand jitter and uneven event timing, resting and clicking on most of them
function humanPath(seed: number, seconds: number, noise = 3): CursorEvent[] {
  const r = random(seed)
  const events: CursorEvent[] = []
  const end = seconds * 1000
  const jitter = () => (r() - 0.5) * noise
  let t = 0
  let x = r() * 1920
  let y = r() * 1080
  while (t < end) {
    const tx = r() * 1920
    const ty = r() * 1080
    const moveMs = 200 + r() * 700
    const from = { x, y, t }
    while (t < from.t + moveMs) {
      t += (1000 / 120) * (0.6 + r() * 0.8)
      const u = Math.min(1, (t - from.t) / moveMs)
      const e = u * u * u * (u * (6 * u - 15) + 10)
      x = from.x + (tx - from.x) * e
      y = from.y + (ty - from.y) * e
      events.push(move(t, x + jitter(), y + jitter()))
    }
    x = tx
    y = ty
    t += 60 + r() * 300
    if (r() < 0.75) {
      events.push(down(t, x, y))
      t += 40 + r() * 100
      events.push(up(t, x, y))
    }
    t += 60 + r() * 500
  }
  return events
}

// Flicks that click mid flight, teleports just before a click, double clicks, gaps and clicks at once
function hostilePath(seed: number): CursorEvent[] {
  const r = random(seed)
  const events: CursorEvent[] = []
  let t = 0
  let x = r() * 1920
  let y = r() * 1080
  const clickHere = () => {
    events.push(down(t, x, y))
    t += 1 + r() * 60
    events.push(up(t, x, y))
  }
  for (let i = 0; i < 40; i++) {
    const kind = Math.floor(r() * 6)
    if (kind === 0) {
      const vx = (r() - 0.5) * 12
      const vy = (r() - 0.5) * 12
      for (let j = 0; j < 40; j++) {
        t += 8
        x += vx
        y += vy
        events.push(move(t, x, y))
      }
      clickHere()
    } else if (kind === 1) {
      x = r() * 7680 - 3840
      y = r() * 2160
      t += r() * 30
      events.push(move(t, x, y))
      t += r() * 30
      clickHere()
    } else if (kind === 2) {
      clickHere()
      t += 30 + r() * 100
      clickHere()
    } else if (kind === 3) {
      t += 2000 + r() * 8000
      events.push(move(t, x + r() * 3, y + r() * 3))
    } else if (kind === 4) {
      clickHere()
      x += (r() - 0.5) * 500
      y += (r() - 0.5) * 500
      t += 1 + r() * 4
      clickHere()
    } else {
      for (let j = 0; j < 30; j++) {
        t += 8
        events.push(move(t, x + (r() - 0.5) * 40, y + (r() - 0.5) * 40))
      }
      clickHere()
    }
  }
  return events
}

function shuffled<T>(items: T[], seed: number): T[] {
  const r = random(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const held = out[i]
    out[i] = out[j]
    out[j] = held
  }
  return out
}

function frames(track: CursorTrack, from: number, to: number, stepMs = FRAME_MS): { x: number; y: number }[] {
  const out = []
  for (let t = from; t <= to; t += stepMs) out.push(track.at(t))
  return out
}

function deltas(points: { x: number; y: number }[]): number[] {
  return points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y))
}

function pathLength(points: { x: number; y: number }[]): number {
  return deltas(points).reduce((sum, d) => sum + d, 0)
}

// Mean size of the third difference, per frame
function jerk(points: { x: number; y: number }[]): number {
  let sum = 0
  for (let i = 3; i < points.length; i++) {
    const jx = points[i].x - 3 * points[i - 1].x + 3 * points[i - 2].x - points[i - 3].x
    const jy = points[i].y - 3 * points[i - 1].y + 3 * points[i - 2].y - points[i - 3].y
    sum += Math.hypot(jx, jy)
  }
  return sum / (points.length - 3)
}

function span(events: CursorEvent[]): { first: number; last: number } {
  const ts = events.map((e) => e.t)
  return { first: Math.min(...ts), last: Math.max(...ts) }
}

function distanceTo(track: CursorTrack, t: number, p: { x: number; y: number }): number {
  const at = track.at(t)
  return Math.hypot(at.x - p.x, at.y - p.y)
}

describe('edge cases', () => {
  it('handles no events', () => {
    for (const style of [SMOOTH, RAW]) {
      const track = buildCursorTrack([], style)
      expect(track.clicks).toEqual([])
      expect(track.at(0)).toEqual({ x: 0, y: 0 })
      expect(track.at(5000)).toEqual({ x: 0, y: 0 })
    }
  })

  it('handles a single event', () => {
    for (const style of [SMOOTH, RAW]) {
      const track = buildCursorTrack([move(500, 40, 60)], style)
      for (const t of [-100, 0, 500, 501, 1e6]) expect(track.at(t)).toEqual({ x: 40, y: 60 })
    }
  })

  it('handles a single click', () => {
    for (const style of [SMOOTH, RAW]) {
      const track = buildCursorTrack([down(500, 40, 60)], style)
      expect(track.clicks).toEqual([{ t: 500, x: 40, y: 60 }])
      for (const t of [0, 500, 1e6]) expect(track.at(t)).toEqual({ x: 40, y: 60 })
    }
  })

  it('sorts events without touching the input', () => {
    const events = humanPath(1, 5)
    const mixed = shuffled(events, 2)
    const before = [...mixed]
    const a = buildCursorTrack(events, SMOOTH)
    const b = buildCursorTrack(mixed, SMOOTH)
    expect(mixed).toEqual(before)
    expect(b.clicks).toEqual(a.clicks)
    for (let t = 0; t < 5000; t += 37) expect(b.at(t)).toEqual(a.at(t))
  })

  it('keeps going through duplicate timestamps', () => {
    const events = [move(0, 0, 0), move(100, 10, 10), move(100, 20, 20), move(100, 30, 30), move(200, 40, 40)]
    for (const style of [SMOOTH, RAW]) {
      const track = buildCursorTrack(events, style)
      for (let t = -10; t < 1000; t += 3) {
        const p = track.at(t)
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
      }
    }
    expect(buildCursorTrack(events, RAW).at(100)).toEqual({ x: 30, y: 30 })
  })

  it('lands on a click that shares its timestamp with other events', () => {
    const events = [move(0, 0, 0), move(500, 300, 300), down(500, 310, 300), move(500, 900, 900), up(600, 310, 300)]
    for (const style of [SMOOTH, RAW]) expect(buildCursorTrack(events, style).at(500)).toEqual({ x: 310, y: 300 })
  })

  it('holds before the first event and after the last', () => {
    const events = humanPath(3, 4)
    const { first, last } = span(events)
    const end = [...events].sort((a, b) => a.t - b.t)[events.length - 1]
    for (const style of [SMOOTH, RAW]) {
      const track = buildCursorTrack(events, style)
      expect(track.at(first - 1000)).toEqual(track.at(first))
      expect(track.at(-Infinity)).toEqual(track.at(first))
      const after = track.at(last + 60_000)
      expect(after).toEqual({ x: end.x, y: end.y })
      expect(track.at(Infinity)).toEqual(after)
    }
  })

  it('stays still through a long gap, then moves', () => {
    const events = [move(0, 100, 100), move(20, 102, 101), move(10_020, 800, 600), move(10_030, 803, 602)]
    for (const style of [SMOOTH, RAW]) {
      const track = buildCursorTrack(events, style)
      for (let t = 2000; t < 8500; t += 100) expect(distanceTo(track, t, { x: 102, y: 101 })).toBeLessThan(1)
      expect(distanceTo(track, 12_000, { x: 803, y: 602 })).toBeLessThan(1)
    }
  })

  it('crosses a huge teleport without a gap in the path', () => {
    const events: CursorEvent[] = [move(0, 100, 100), move(1000, 100, 100), move(1008, 6000, 1400), move(3000, 6000, 1400)]
    const track = buildCursorTrack(events, SMOOTH)
    const distance = Math.hypot(5900, 1300)
    const steps = deltas(frames(track, 0, 3000))
    expect(Math.max(...steps)).toBeLessThan((distance * NATURAL_RATE * 1.05) / 60)
    expect(distanceTo(track, 3000, { x: 6000, y: 1400 })).toBeLessThan(1)
  })

  it('ignores events with no usable numbers', () => {
    const events = [move(0, 10, 10), move(NaN, 500, 500), move(20, Infinity, 3), move(40, 20, 20)]
    for (const style of [SMOOTH, RAW]) {
      const track = buildCursorTrack(events, style)
      expect(Number.isFinite(track.at(30).x)).toBe(true)
      expect(track.at(100_000)).toEqual({ x: 20, y: 20 })
      expect(track.at(NaN)).toEqual({ x: 10, y: 10 })
    }
  })

  it('survives a corrupt timestamp and extreme springs', () => {
    const wild = buildCursorTrack([move(0, 0, 0), down(1e14, 50, 60)], SMOOTH)
    expect(wild.at(1e14)).toEqual({ x: 50, y: 60 })
    const styles: Partial<CursorStyle>[] = [
      { stiffness: 0, damping: 0 },
      { stiffness: -5, damping: -5 },
      { stiffness: NaN, damping: Infinity },
      { stiffness: 1e9, damping: 1 },
      { stiffness: 1, damping: 1e9 }
    ]
    for (const style of styles) {
      const track = buildCursorTrack(hostilePath(9), { ...SMOOTH, ...style })
      for (const c of track.clicks) expect(distanceTo(track, c.t, c)).toBeLessThanOrEqual(4)
      for (let t = 0; t < 20_000; t += 53) expect(Number.isFinite(track.at(t).x)).toBe(true)
    }
  })
})

describe('clicks', () => {
  it('lists left downs only, sorted, with the exact event values', () => {
    const events: CursorEvent[] = [
      down(900, 3.25, 4.5),
      { t: 100, x: 1, y: 1, kind: 'down', button: 'right' },
      { t: 200, x: 2, y: 2, kind: 'down', button: 'middle' },
      { t: 300, x: 3, y: 3, kind: 'down' },
      up(950, 3, 4),
      move(50, 0, 0),
      down(400, 7, 8)
    ]
    for (const style of [SMOOTH, RAW]) {
      expect(buildCursorTrack(events, style).clicks).toEqual([
        { t: 400, x: 7, y: 8 },
        { t: 900, x: 3.25, y: 4.5 }
      ])
    }
  })
})

describe('raw path', () => {
  it('interpolates linearly and hits every event', () => {
    const events = [move(0, 0, 0), move(100, 100, 50), move(200, 100, 250), down(300, 0, 250), up(400, 0, 250)]
    const track = buildCursorTrack(events, RAW)
    expect(track.at(50)).toEqual({ x: 50, y: 25 })
    expect(track.at(150)).toEqual({ x: 100, y: 150 })
    for (const e of events) expect(track.at(e.t)).toEqual({ x: e.x, y: e.y })
  })
})

describe('smoothing', () => {
  it('shortens the path and removes jerk', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const events = humanPath(seed, 30, 12)
      const raw = frames(buildCursorTrack(events, RAW), 0, 30_000)
      const smooth = frames(buildCursorTrack(events, SMOOTH), 0, 30_000)
      expect(pathLength(smooth)).toBeLessThan(pathLength(raw) * 0.97)
      expect(jerk(smooth)).toBeLessThan(jerk(raw) * 0.1)
    }
  })

  it('follows a steady move without lagging behind it', () => {
    const events: CursorEvent[] = []
    for (let t = 0; t <= 2000; t += 8) events.push(move(t, t, 500))
    const track = buildCursorTrack(events, SMOOTH)
    for (let t = 500; t < 1700; t += 50) expect(distanceTo(track, t, { x: t, y: 500 })).toBeLessThan(2)
  })

  it('does not depend on event timing', () => {
    const r = random(5)
    const curve = (t: number) => ({ x: 960 + 700 * Math.sin(t / 700), y: 540 + 400 * Math.cos(t / 450) })
    const even: CursorEvent[] = []
    const uneven: CursorEvent[] = []
    for (let t = 0; t <= 8000; t += 1000 / 120) even.push(move(t, curve(t).x, curve(t).y))
    for (let t = 0; t <= 8000; t += 2 + r() * 24) uneven.push(move(t, curve(t).x, curve(t).y))
    const a = buildCursorTrack(even, SMOOTH)
    const b = buildCursorTrack(uneven, SMOOTH)
    for (let t = 300; t < 7500; t += 41) expect(distanceTo(a, t, b.at(t))).toBeLessThan(1)
  })
})

describe('A4: every click lands', () => {
  it('is on the click at the click time, on any path, at any spring', () => {
    let checked = 0
    for (let seed = 1; seed <= 40; seed++) {
      const paths = [humanPath(seed, 20), hostilePath(seed)]
      for (const events of paths) {
        for (const style of STYLES) {
          const track = buildCursorTrack(events, style)
          for (const c of track.clicks) {
            expect(distanceTo(track, c.t, c)).toBeLessThanOrEqual(4)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000)
  })

  it('lands on two distant clicks a millisecond apart', () => {
    const events = [move(0, 0, 0), down(500, 100, 100), up(500.5, 100, 100), down(501, 1500, 900), up(560, 1500, 900)]
    const track = buildCursorTrack(events, SMOOTH)
    expect(track.at(500)).toEqual({ x: 100, y: 100 })
    expect(track.at(501)).toEqual({ x: 1500, y: 900 })
  })

  it('lands on clicks in the first and last moments', () => {
    const events = [down(0, 200, 300), up(30, 200, 300), move(100, 800, 800), move(400, 500, 500), down(410, 500, 500)]
    const track = buildCursorTrack(events, SMOOTH)
    expect(track.at(0)).toEqual({ x: 200, y: 300 })
    expect(track.at(410)).toEqual({ x: 500, y: 500 })
  })

  it('holds from the down to the up', () => {
    const events = [move(0, 0, 0), move(800, 600, 400), down(1000, 600, 400), move(1050, 601, 401), up(1100, 602, 400)]
    events.push(move(1400, 900, 800))
    const track = buildCursorTrack(events, SMOOTH)
    for (let t = 1000; t <= 1100; t += 2.5) expect(track.at(t)).toEqual({ x: 600, y: 400 })
  })

  it('still follows a drag', () => {
    const events = [down(0, 100, 100)]
    for (let t = 10; t <= 1000; t += 10) events.push(move(t, 100 + t, 100))
    events.push(up(1000, 1100, 100))
    const track = buildCursorTrack(events, SMOOTH)
    expect(track.at(600).x).toBeGreaterThan(600)
    expect(distanceTo(track, 3000, { x: 1100, y: 100 })).toBeLessThan(1)
  })

  it('pulls on right clicks too, without listing them', () => {
    const events: CursorEvent[] = [
      move(0, 0, 0),
      move(300, 900, 700),
      { t: 310, x: 900, y: 700, kind: 'down', button: 'right' },
      { t: 380, x: 900, y: 700, kind: 'up', button: 'right' }
    ]
    const track = buildCursorTrack(events, SMOOTH)
    expect(track.clicks).toEqual([])
    expect(track.at(310)).toEqual({ x: 900, y: 700 })
  })
})

describe('landing', () => {
  // Rests, flies at a constant speed, and clicks the moment it arrives
  function flick(speed: number): { events: CursorEvent[]; click: number; target: { x: number; y: number } } {
    const events: CursorEvent[] = [move(0, 100, 500), move(1000, 100, 500)]
    const travel = 1200
    const flightMs = (travel / speed) * 1000
    for (let t = 8; t < flightMs; t += 8) events.push(move(1000 + t, 100 + (t / flightMs) * travel, 500))
    const click = 1000 + flightMs
    events.push(down(click, 1300, 500), up(click + 80, 1300, 500), move(click + 1000, 1300, 500))
    return { events, click, target: { x: 1300, y: 500 } }
  }

  it('never passes a click it flies straight at, on any spring', () => {
    for (const speed of [800, 2000, 5000]) {
      const { events, click, target } = flick(speed)
      for (const style of STYLES) {
        const track = buildCursorTrack(events, style)
        for (const p of frames(track, 0, click, 2)) expect(p.x).toBeLessThanOrEqual(target.x + 1)
      }
    }
  })

  it('settles onto a click when the raw path got there early, on any spring', () => {
    for (const restMs of [50, 150, 300, 600]) {
      const events: CursorEvent[] = [move(0, 100, 500), move(1000, 100, 500)]
      for (let t = 8; t <= 300; t += 8) events.push(move(1000 + t, 100 + t * 4, 500))
      const end = events[events.length - 1]
      const click = end.t + restMs
      events.push(down(click, end.x, 500), up(click + 80, end.x, 500), move(click + 1000, end.x, 500))
      for (const style of STYLES) {
        const track = buildCursorTrack(events, style)
        for (const p of frames(track, 0, click, 2)) expect(p.x).toBeLessThanOrEqual(end.x + 1)
      }
    }
  })

  it('slows into a click on a bouncy spring instead of stopping dead', () => {
    const events: CursorEvent[] = [move(0, 100, 500), move(1000, 100, 500)]
    for (let t = 8; t <= 304; t += 8) events.push(move(1000 + t, 100 + t * 4, 500))
    const end = events[events.length - 1]
    events.push(down(1700, end.x, 500), up(1780, end.x, 500))
    const bouncy = { ...SMOOTH, stiffness: 100, damping: 8 }
    const steps = deltas(frames(buildCursorTrack(events, bouncy), 1000, 1700))
    const fall = Math.max(...steps.slice(1).map((d, i) => steps[i] - d))
    expect(fall).toBeLessThan(Math.max(...steps) / 3)
  })

  it('does not swerve toward where the cursor goes after the click', () => {
    const events = [move(0, 500, 500), move(1000, 500, 500), down(1000, 500, 500), up(1050, 500, 500), move(1060, 5000, 500)]
    events.push(move(3000, 5000, 500))
    const track = buildCursorTrack(events, SMOOTH)
    for (const p of frames(track, 0, 1050, 2)) expect(Math.abs(p.x - 500)).toBeLessThan(0.5)
  })

  it('adds little speed in the last 80 ms, even on a flick that stops dead', () => {
    for (const speed of [800, 2000, 5000]) {
      const { events, click } = flick(speed)
      const steps = deltas(frames(buildCursorTrack(events, SMOOTH), click - 300, click))
      const pullFrames = Math.ceil(80 / FRAME_MS)
      const cruise = Math.max(...steps.slice(0, steps.length - pullFrames))
      const pull = Math.max(...steps.slice(steps.length - pullFrames))
      expect(pull).toBeLessThan(cruise * 2)
    }
  })

  it('barely has to pull on a human path', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const track = buildCursorTrack(humanPath(seed, 30), SMOOTH)
      for (const c of track.clicks) {
        const before = deltas(frames(track, c.t - 300, c.t - 80))
        const pull = deltas(frames(track, c.t - 80, c.t))
        expect(Math.max(...pull)).toBeLessThan(Math.max(...before) * 1.5 + 2)
      }
    }
  })

  it('has no break in speed where the pull starts', () => {
    for (const speed of [800, 2000, 5000]) {
      const { events, click } = flick(speed)
      const track = buildCursorTrack(events, SMOOTH)
      const start = click - 80
      const [before, after] = deltas([track.at(start - FRAME_MS), track.at(start), track.at(start + FRAME_MS)])
      expect(after).toBeLessThan(before * 1.6)
    }
  })

  // A teleport right before a click is the worst case: the pull has to cover what the spring could not
  it('stays in proportion to the spring on a teleport into a click, at any spring', () => {
    const distance = 1500
    for (const style of STYLES) {
      const natural = (Math.sqrt(style.stiffness) / Math.E) * distance
      for (let delay = 0; delay <= 400; delay += 5) {
        const events = [move(0, 100, 500), move(2000, 100, 500), move(2008, 1600, 500)]
        events.push(down(2008 + delay, 1600, 500), up(2068 + delay, 1600, 500), move(4000, 1600, 500))
        const steps = deltas(frames(buildCursorTrack(events, style), 1000, 4000))
        expect(Math.max(...steps)).toBeLessThan((natural * 3.5) / 60)
      }
    }
  })
})

describe('continuity', () => {
  // A real jump is the same size at any sample rate, and continuous motion shrinks with the step
  function worstStep(track: CursorTrack, from: number, to: number, stepMs: number): number {
    return Math.max(...deltas(frames(track, from, to, stepMs)))
  }

  it('has no jump at any time scale', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const events = humanPath(seed, 20)
      for (const style of STYLES) {
        const track = buildCursorTrack(events, style)
        expect(worstStep(track, 0, 20_000, 1)).toBeLessThan(worstStep(track, 0, 20_000, FRAME_MS) / 6)
      }
    }
  })

  it('arrives at a click rather than appearing on it', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const events = humanPath(seed, 20)
      for (const style of STYLES) {
        const track = buildCursorTrack(events, style)
        for (const c of track.clicks) {
          expect(distanceTo(track, c.t - 3, c)).toBeLessThanOrEqual(4)
          expect(distanceTo(track, c.t - 0.01, c)).toBeLessThanOrEqual(4)
        }
      }
    }
  })

  it('never moves faster than the raw path, give or take the pull, on hostile paths', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const events = hostilePath(seed)
      const { first, last } = span(events)
      const smooth = Math.max(...deltas(frames(buildCursorTrack(events, SMOOTH), first, last)))
      const raw = Math.max(...deltas(frames(buildCursorTrack(events, RAW), first, last)))
      expect(smooth).toBeLessThan(raw * 2)
    }
  })

  it('stays inside the area the raw path covers', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const events = humanPath(seed, 20)
      const xs = events.map((e) => e.x)
      const ys = events.map((e) => e.y)
      const track = buildCursorTrack(events, SMOOTH)
      for (const p of frames(track, 0, 20_000)) {
        expect(p.x).toBeGreaterThan(Math.min(...xs) - 5)
        expect(p.x).toBeLessThan(Math.max(...xs) + 5)
        expect(p.y).toBeGreaterThan(Math.min(...ys) - 5)
        expect(p.y).toBeLessThan(Math.max(...ys) + 5)
      }
    }
  })
})

describe('determinism', () => {
  it('rebuilds to the same values', () => {
    const events = hostilePath(4)
    const a = buildCursorTrack(events, SMOOTH)
    const b = buildCursorTrack(events, SMOOTH)
    expect(b.clicks).toEqual(a.clicks)
    for (let t = -50; t < 60_000; t += 13.7) expect(b.at(t)).toEqual(a.at(t))
  })

  it('gives the same answer in any order', () => {
    const events = humanPath(6, 20)
    const track = buildCursorTrack(events, SMOOTH)
    const times: number[] = []
    for (let t = -20; t < 22_000; t += 3.3) times.push(t)
    const inOrder = times.map((t) => track.at(t))
    const order = shuffled(
      times.map((_, i) => i),
      8
    )
    for (const i of order) expect(track.at(times[i])).toEqual(inOrder[i])
  })

  it('hands back a fresh point each call', () => {
    const track = buildCursorTrack(humanPath(7, 2), SMOOTH)
    const p = track.at(500)
    const copy = { ...p }
    p.x = -1
    expect(track.at(500)).toEqual(copy)
  })
})

describe('performance', () => {
  it('builds a 10-minute recording at 120 events/s in under a second', () => {
    const noise = random(11)
    const events: CursorEvent[] = []
    for (let i = 0; i < 72_000; i++) {
      const t = (i * 1000) / 120
      const x = 960 + 900 * Math.sin(t / 900) + noise() * 4
      const y = 540 + 500 * Math.cos(t / 1300) + noise() * 4
      events.push(i % 240 === 100 ? down(t, x, y) : i % 240 === 110 ? up(t, x, y) : move(t, x, y))
    }
    const start = performance.now()
    const track = buildCursorTrack(events, SMOOTH)
    const built = performance.now() - start
    expect(built).toBeLessThan(1000)

    const r = random(12)
    const scrub = performance.now()
    for (let i = 0; i < 1_000_000; i++) track.at(r() * 600_000)
    expect(performance.now() - scrub).toBeLessThan(1000)
  })
})
