import { describe, expect, it } from 'vitest'
import { buildZooms } from '../src/engine/zoom'
import {
  aimAt,
  cameraAt,
  compose,
  easeInOutCubic,
  focusAt,
  restRect,
  zoomAmount,
  type ClickPoint,
  type CursorTrack,
  type FrameSpec,
  type Rect
} from '../src/shared/compose'
import {
  CURSOR_DEFAULTS,
  LOOK_DEFAULTS,
  outputSize,
  type OutputSettings,
  type Project,
  type Shape,
  type ZoomSegment
} from '../src/shared/project'

const SHAPES: Shape[] = ['16:9', '1:1', '9:16']
const RESOLUTIONS: OutputSettings['resolution'][] = ['1080p', '4k']
const LEVELS = [1, 1.25, 1.5, 2, 3, 4]
const CLIPS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3024, height: 1964 }
]
const COORDS = [0, 0.02, 0.25, 0.5, 0.75, 0.98, 1]
const FOCI = COORDS.flatMap((x) => COORDS.map((y) => ({ x, y })))
const CORNERS = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 }
]
const EPS = 1e-6
const FRAME_60 = 1000 / 60
const DURATION = 30000

interface Setup {
  shape: Shape
  resolution: OutputSettings['resolution']
  size: { width: number; height: number }
  clip: { width: number; height: number }
}

function setups(clips = CLIPS): Setup[] {
  return SHAPES.flatMap((shape) =>
    RESOLUTIONS.flatMap((resolution) =>
      clips.map((clip) => ({ shape, resolution, clip, size: outputSize(shape, resolution) }))
    )
  )
}

// Frame times from one ms to another, on a frame grid shifted by phaseMs
function sampleFrames(fromMs: number, toMs: number, fps = 60, phaseMs = 0): number[] {
  const out: number[] = []
  for (let i = 0; ; i++) {
    const t = fromMs + phaseMs + (i * 1000) / fps
    if (t > toMs) return out
    out.push(t)
  }
}

function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

function makeTrack(clicks: ClickPoint[]): CursorTrack {
  return { at: () => ({ x: 0, y: 0 }), clicks }
}

function makeProject(zooms: ZoomSegment[], clip: Setup['clip'], durationMs = DURATION): Project {
  return {
    version: 1,
    id: 'p',
    name: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    durationMs,
    clips: [{ id: 's', kind: 'screen', file: 'screen.mp4', startMs: 0, durationMs, ...clip }],
    zooms,
    look: LOOK_DEFAULTS,
    cursor: CURSOR_DEFAULTS,
    webcam: null,
    captions: [],
    output: { shapes: ['16:9'], format: 'mp4', resolution: '1080p', fps: 60, folder: '' }
  }
}

function frameAt(project: Project, track: CursorTrack, s: Setup, t: number): FrameSpec {
  return compose(project, track, s.shape, s.size, t, { webcam: false, captions: false })
}

function withLevel(zooms: ZoomSegment[], level: number): ZoomSegment[] {
  return zooms.map((z) => ({ ...z, level }))
}

function expectInsideCanvas(rect: Rect, width: number, height: number): void {
  expect(rect.x).toBeGreaterThanOrEqual(-EPS)
  expect(rect.y).toBeGreaterThanOrEqual(-EPS)
  expect(rect.x + rect.w).toBeLessThanOrEqual(width + EPS)
  expect(rect.y + rect.h).toBeLessThanOrEqual(height + EPS)
}

// How far a rect sticks out of the canvas. Zero or less means inside
function overflow(rect: Rect, width: number, height: number): number {
  return Math.max(-rect.x, -rect.y, rect.x + rect.w - width, rect.y + rect.h - height)
}

function clickOnCanvas(click: ClickPoint, rest: Rect, clip: Setup['clip']): { x: number; y: number } {
  return { x: rest.x + (click.x / clip.width) * rest.w, y: rest.y + (click.y / clip.height) * rest.h }
}

function expectInsideCamera(p: { x: number; y: number }, camera: Rect): void {
  expect(p.x).toBeGreaterThanOrEqual(camera.x - EPS)
  expect(p.y).toBeGreaterThanOrEqual(camera.y - EPS)
  expect(p.x).toBeLessThanOrEqual(camera.x + camera.w + EPS)
  expect(p.y).toBeLessThanOrEqual(camera.y + camera.h + EPS)
}

// Largest move of any camera edge between two frames, as a share of the frame side
function edgeStep(a: FrameSpec, b: FrameSpec): number {
  const w = a.width
  const h = a.height
  return Math.max(
    Math.abs(a.camera.x - b.camera.x) / w,
    Math.abs(a.camera.x + a.camera.w - b.camera.x - b.camera.w) / w,
    Math.abs(a.camera.y - b.camera.y) / h,
    Math.abs(a.camera.y + a.camera.h - b.camera.y - b.camera.h) / h
  )
}

function zoomStep(a: FrameSpec, b: FrameSpec): number {
  return Math.max(a.zoom / b.zoom, b.zoom / a.zoom)
}

// The steepest slope of cubic ease in-out is 3, so a ramp of rampMs moves k at most this much
function maxKStep(rampMs: number, frameMs = FRAME_60): number {
  return (3 * frameMs) / rampMs
}

// The ratio between two frames of a ramp, as scale is target ^ k
function maxZoomStep(s: Setup, level: number, rampMs: number): number {
  const rest = restRect(s.size.width, s.size.height, s.clip.width, s.clip.height, 6)
  return Math.pow((level * s.size.height) / rest.h, maxKStep(rampMs))
}

// Worst per-frame camera change over a span, on three frame grids
function worstSteps(project: Project, track: CursorTrack, s: Setup, fromMs: number, toMs: number) {
  let edge = 0
  let zoom = 1
  for (const phase of [0, 5.5, 11]) {
    let prev: FrameSpec | null = null
    for (const t of sampleFrames(fromMs, toMs, 60, phase)) {
      const frame = frameAt(project, track, s, t)
      if (prev) {
        edge = Math.max(edge, edgeStep(prev, frame))
        zoom = Math.max(zoom, zoomStep(prev, frame))
      }
      prev = frame
    }
  }
  return { edge, zoom }
}

function clickAt(t: number, focus: { x: number; y: number }, clip: Setup['clip']): ClickPoint {
  return { t, x: focus.x * clip.width, y: focus.y * clip.height }
}

function segment(over: Partial<ZoomSegment>): ZoomSegment {
  return {
    id: 'z',
    startMs: 1000,
    endMs: 3000,
    level: 2,
    easeInMs: 600,
    easeOutMs: 600,
    focus: { x: 0.5, y: 0.5 },
    clickMs: [],
    origin: 'manual',
    edited: false,
    ...over
  }
}

describe('easeInOutCubic', () => {
  it('runs from 0 to 1 with a slope of at most 3', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(0.5)).toBe(0.5)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(-1)).toBe(0)
    expect(easeInOutCubic(2)).toBe(1)
    for (let x = 0; x < 1; x += 0.001) {
      expect(easeInOutCubic(x + 0.001) - easeInOutCubic(x)).toBeLessThanOrEqual(0.003 + EPS)
    }
  })
})

describe('restRect', () => {
  it('pads inside the frame in 16:9', () => {
    const rest = restRect(1920, 1080, 1920, 1080, 6)
    expect(rest.h).toBeCloseTo(1080 - 2 * 64.8)
    expect(rest.w / rest.h).toBeCloseTo(16 / 9)
    expect(rest.x).toBeCloseTo((1920 - rest.w) / 2)
    expect(rest.y).toBeCloseTo(64.8)
  })

  it('fits the screen to the frame width in 1:1 and 9:16', () => {
    for (const shape of ['1:1', '9:16'] as Shape[]) {
      for (const resolution of RESOLUTIONS) {
        const { width, height } = outputSize(shape, resolution)
        const rest = restRect(width, height, 1920, 1080, 6)
        expect(rest.x).toBeCloseTo(0)
        expect(rest.w).toBeCloseTo(width)
        expect(rest.h).toBeCloseTo((width * 9) / 16)
        expect(rest.y).toBeCloseTo((height - rest.h) / 2)
      }
    }
  })

  it('never lets a tall clip spill out of the frame', () => {
    for (const shape of SHAPES) {
      const { width, height } = outputSize(shape, '1080p')
      const rest = restRect(width, height, 1080, 1920, 6)
      expectInsideCanvas(rest, width, height)
    }
  })
})

describe('zoomAmount', () => {
  it('is at rest outside every segment', () => {
    const zooms = [segment({})]
    expect(zoomAmount(zooms, 999)).toEqual({ k: 0, seg: null })
    expect(zoomAmount(zooms, 3001)).toEqual({ k: 0, seg: null })
  })

  it('ramps in and out and holds at 1', () => {
    const zooms = [segment({})]
    expect(zoomAmount(zooms, 1000).k).toBe(0)
    expect(zoomAmount(zooms, 1300).k).toBeCloseTo(0.5)
    expect(zoomAmount(zooms, 1600).k).toBe(1)
    expect(zoomAmount(zooms, 2400).k).toBe(1)
    expect(zoomAmount(zooms, 2700).k).toBeCloseTo(0.5)
    expect(zoomAmount(zooms, 3000).k).toBe(0)
  })

  it('treats a zero ease as already there', () => {
    const zooms = [segment({ startMs: 0, easeInMs: 0, endMs: 1000, easeOutMs: 0 })]
    expect(zoomAmount(zooms, 0).k).toBe(1)
    expect(zoomAmount(zooms, 1000).k).toBe(1)
  })

  it('does not depend on the order of the array', () => {
    const a = segment({ id: 'a', startMs: 1000, endMs: 2000 })
    const b = segment({ id: 'b', startMs: 2000, endMs: 3000 })
    for (const t of sampleFrames(900, 3100)) {
      expect(zoomAmount([b, a], t)).toEqual(zoomAmount([a, b], t))
    }
    expect(zoomAmount([b, a], 2000).k).toBe(1)
  })

  it('stays up when a long segment spans a shorter one', () => {
    const long = segment({ id: 'long', startMs: 1000, endMs: 9000 })
    const inner = segment({ id: 'inner', startMs: 3000, endMs: 4000 })
    const last = segment({ id: 'last', startMs: 8900, endMs: 12000 })
    for (const t of sampleFrames(1600, 11400)) expect(zoomAmount([long, inner, last], t).k).toBe(1)
  })
})

describe('A3: the camera stays inside the canvas', () => {
  it('for every k, level, focus and shape', () => {
    let worst = -Infinity
    let lowestScale = Infinity
    let aspectError = 0
    for (const s of setups()) {
      const rest = restRect(s.size.width, s.size.height, s.clip.width, s.clip.height, 6)
      for (const level of LEVELS) {
        for (const focus of FOCI) {
          for (let i = 0; i <= 40; i++) {
            const { rect, scale } = cameraAt(s.size.width, s.size.height, rest, level, i / 40, focus)
            worst = Math.max(worst, overflow(rect, s.size.width, s.size.height))
            lowestScale = Math.min(lowestScale, scale)
            aspectError = Math.max(aspectError, Math.abs(rect.w / rect.h - s.size.width / s.size.height))
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(EPS)
    expect(lowestScale).toBeGreaterThanOrEqual(1)
    expect(aspectError).toBeLessThan(EPS)
  })

  it('for padding from none to heavy', () => {
    let worst = -Infinity
    for (const s of setups(CLIPS.slice(0, 1))) {
      for (const padding of [0, 1, 6, 12, 25]) {
        const rest = restRect(s.size.width, s.size.height, s.clip.width, s.clip.height, padding)
        for (const focus of CORNERS) {
          for (let i = 0; i <= 20; i++) {
            const { rect } = cameraAt(s.size.width, s.size.height, rest, 4, i / 20, focus)
            worst = Math.max(worst, overflow(rect, s.size.width, s.size.height))
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(EPS)
  })

  it('for a screen that is not centred and narrower than the camera', () => {
    const rest = { x: 1700, y: 0, w: 200, h: 1080 }
    for (let i = 0; i <= 20; i++) {
      const { rect } = cameraAt(1920, 1080, rest, 1, i / 20, { x: 1, y: 1 })
      expect(overflow(rect, 1920, 1080)).toBeLessThanOrEqual(EPS)
    }
  })

  it('at every frame of a generated recording', () => {
    const next = random(11)
    const clicks = Array.from({ length: 24 }, () => ({
      t: next() * DURATION,
      x: next() * 1920,
      y: next() * 1080
    })).sort((a, b) => a.t - b.t)
    const track = makeTrack(clicks)
    const zooms = buildZooms(clicks, DURATION, CLIPS[0])
    expect(zooms.length).toBeGreaterThan(3)
    let worst = -Infinity
    for (const s of setups(CLIPS.slice(0, 1))) {
      for (const level of [1, 2, 4]) {
        const project = makeProject(withLevel(zooms, level), s.clip)
        for (const t of sampleFrames(0, DURATION)) {
          worst = Math.max(worst, overflow(frameAt(project, track, s, t).camera, s.size.width, s.size.height))
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(EPS)
  })
})

describe('during a ramp', () => {
  it('moves the camera centre from the frame centre to the focus in step with k', () => {
    const rest = restRect(1920, 1080, 1920, 1080, 6)
    const focus = { x: 0.6, y: 0.45 }
    const fx = rest.x + focus.x * rest.w
    const fy = rest.y + focus.y * rest.h
    for (const k of [0.25, 0.5, 0.75, 1]) {
      const { rect } = cameraAt(1920, 1080, rest, 2, k, focus)
      expect(rect.x + rect.w / 2).toBeCloseTo(960 + (fx - 960) * k, 6)
      expect(rect.y + rect.h / 2).toBeCloseTo(540 + (fy - 540) * k, 6)
    }
  })

  it('scales geometrically, so the zoom looks even', () => {
    const rest = restRect(1920, 1080, 1920, 1080, 6)
    const full = cameraAt(1920, 1080, rest, 2, 1, { x: 0.5, y: 0.5 }).scale
    const half = cameraAt(1920, 1080, rest, 2, 0.5, { x: 0.5, y: 0.5 }).scale
    expect(half).toBeCloseTo(Math.sqrt(full), 9)
  })
})

describe('full zoom shows the same slice in every shape', () => {
  it('frame height shows 1/level of the screen height', () => {
    for (const s of setups()) {
      const rest = restRect(s.size.width, s.size.height, s.clip.width, s.clip.height, 6)
      for (const level of LEVELS) {
        for (const focus of FOCI) {
          const { rect, scale } = cameraAt(s.size.width, s.size.height, rest, level, 1, focus)
          expect(rect.h / rest.h).toBeCloseTo(1 / level, 9)
          expect(scale * rest.h).toBeCloseTo(s.size.height * level, 6)
        }
      }
    }
  })

  it('stays at full frame when the level is too low to reach the screen', () => {
    const rest = restRect(1080, 1920, 1080, 1920, 0)
    const { rect, scale } = cameraAt(1080, 1920, rest, 0.5, 1, { x: 0.5, y: 0.5 })
    expect(scale).toBe(1)
    expect(rect).toEqual({ x: 0, y: 0, w: 1080, h: 1920 })
  })

  it('stays on the screen at full zoom, so no wallpaper shows', () => {
    for (const s of setups()) {
      const rest = restRect(s.size.width, s.size.height, s.clip.width, s.clip.height, 6)
      for (const level of [2, 3, 4]) {
        for (const focus of FOCI) {
          const { rect } = cameraAt(s.size.width, s.size.height, rest, level, 1, focus)
          expect(rect.x).toBeGreaterThanOrEqual(rest.x - EPS)
          expect(rect.y).toBeGreaterThanOrEqual(rest.y - EPS)
          expect(rect.x + rect.w).toBeLessThanOrEqual(rest.x + rest.w + EPS)
          expect(rect.y + rect.h).toBeLessThanOrEqual(rest.y + rest.h + EPS)
        }
      }
    }
  })

  it('reaches the same slice through compose in all three shapes', () => {
    const click = clickAt(5000, { x: 0.5, y: 0.5 }, CLIPS[0])
    const zooms = buildZooms([click], DURATION, CLIPS[0])
    const seen = setups(CLIPS.slice(0, 1)).map((s) => {
      const frame = frameAt(makeProject(zooms, s.clip), makeTrack([click]), s, 5000)
      return frame.camera.h / frame.screen.h
    })
    for (const share of seen) expect(share).toBeCloseTo(0.5, 9)
  })
})

describe('at rest', () => {
  it('shows the whole canvas', () => {
    for (const s of setups()) {
      const zooms = [segment({ focus: { x: 1, y: 1 }, level: 4 })]
      const frame = frameAt(makeProject(zooms, s.clip), makeTrack([]), s, 100)
      expect(frame.camera).toEqual({ x: 0, y: 0, w: s.size.width, h: s.size.height })
      expect(frame.zoom).toBe(1)
    }
  })

  it('is the same frame for the same input', () => {
    const s = setups()[0]
    const clicks = [clickAt(5000, { x: 0.2, y: 0.3 }, s.clip), clickAt(5400, { x: 0.8, y: 0.9 }, s.clip)]
    const project = makeProject(buildZooms(clicks, DURATION, s.clip), s.clip)
    const track = makeTrack(clicks)
    expect(frameAt(project, track, s, 5200)).toEqual(frameAt(project, track, s, 5200))
  })
})

describe('a single click', () => {
  // Click times that stress clamping, plus fractions that do not survive float arithmetic
  const TIMES = [0, 1, 16.7, 50, 99, 100, 150, 300, 599, 600, 601, 1234.567, 7000.1, 12345.678, 29000]
  const FINAL = [DURATION, DURATION - 1, DURATION - 16.7, DURATION - 99, DURATION - 100, DURATION - 300]

  it('has k exactly 1 at the click', () => {
    const clip = CLIPS[0]
    for (const t of [...TIMES, ...FINAL]) {
      const zooms = buildZooms([clickAt(t, { x: 0.3, y: 0.7 }, clip)], DURATION, clip)
      expect(zoomAmount(zooms, t).k).toBe(1)
    }
  })

  it('has k exactly 1 for arbitrary fractional times', () => {
    const next = random(3)
    const clip = CLIPS[0]
    for (let i = 0; i < 3000; i++) {
      const t = next() * DURATION
      const zooms = buildZooms([clickAt(t, { x: 0.3, y: 0.7 }, clip)], DURATION, clip)
      expect(zoomAmount(zooms, t).k).toBe(1)
    }
  })

  it('stays on the click through the hold', () => {
    const clip = CLIPS[0]
    const zooms = buildZooms([clickAt(5000, { x: 0.3, y: 0.7 }, clip)], DURATION, clip)
    for (const t of sampleFrames(5000, 6000)) expect(zoomAmount(zooms, t).k).toBe(1)
  })

  it('has the click inside the camera in every shape, level and position', () => {
    for (const s of setups()) {
      for (const level of LEVELS) {
        for (const focus of FOCI) {
          for (const t of [0, 300, 5000.25, DURATION]) {
            const click = clickAt(t, focus, s.clip)
            const zooms = withLevel(buildZooms([click], DURATION, s.clip), level)
            const frame = frameAt(makeProject(zooms, s.clip), makeTrack([click]), s, t)
            expectInsideCamera(clickOnCanvas(click, frame.screen, s.clip), frame.camera)
          }
        }
      }
    }
  })

  it('centres the camera on the click away from the edges', () => {
    const s = setups(CLIPS.slice(0, 1))[0]
    const click = clickAt(5000, { x: 0.5, y: 0.5 }, s.clip)
    const frame = frameAt(makeProject(buildZooms([click], DURATION, s.clip), s.clip), makeTrack([click]), s, 5000)
    expect(frame.camera.x + frame.camera.w / 2).toBeCloseTo(frame.screen.x + frame.screen.w / 2)
    expect(frame.camera.y + frame.camera.h / 2).toBeCloseTo(frame.screen.y + frame.screen.h / 2)
  })

  it('does not snap at the first or last frame', () => {
    const clip = CLIPS[0]
    for (const t of [0, 16.7, 99, 100, 300, 600, DURATION - 300, DURATION - 100, DURATION - 99, DURATION]) {
      const zooms = buildZooms([clickAt(t, { x: 1, y: 1 }, clip)], DURATION, clip)
      const ramp = Math.min(...[zooms[0].easeInMs, zooms[0].easeOutMs].filter((ms) => ms > 0))
      expect(ramp).toBeGreaterThanOrEqual(100)
      let worst = 0
      for (const phase of [0, 5.5, 11]) {
        let prev = zoomAmount(zooms, phase).k
        for (const frame of sampleFrames(0, DURATION, 60, phase)) {
          const { k } = zoomAmount(zooms, frame)
          worst = Math.max(worst, Math.abs(k - prev))
          prev = k
        }
      }
      expect(worst).toBeLessThanOrEqual(maxKStep(ramp) + EPS)
    }
  })
})

describe('smooth motion at 60 fps', () => {
  it('bounds k per frame on a full ramp', () => {
    const zooms = [segment({ startMs: 2000, endMs: 5000 })]
    let prev = 0
    for (const t of sampleFrames(0, 6000)) {
      const { k } = zoomAmount(zooms, t)
      expect(Math.abs(k - prev)).toBeLessThanOrEqual(maxKStep(600) + EPS)
      prev = k
    }
  })

  it('bounds the camera on full ramps in every shape, level and corner', () => {
    for (const s of setups()) {
      for (const level of [1, 2, 4]) {
        for (const focus of CORNERS) {
          const click = clickAt(5000, focus, s.clip)
          const zooms = withLevel(buildZooms([click], DURATION, s.clip), level)
          const steps = worstSteps(makeProject(zooms, s.clip), makeTrack([click]), s, 4000, 7500)
          expect(steps.edge).toBeLessThanOrEqual(1.5 * maxKStep(600))
          expect(steps.zoom).toBeLessThanOrEqual(maxZoomStep(s, level, 600) + EPS)
        }
      }
    }
  })

  it('bounds the camera across touching segments', () => {
    const pairs = [
      [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      [{ x: 1, y: 0 }, { x: 0, y: 1 }],
      [{ x: 0.5, y: 0.5 }, { x: 1, y: 0 }]
    ]
    for (const s of setups()) {
      for (const level of [1, 2, 4]) {
        for (const [a, b] of pairs) {
          for (const gap of [1200, 1500, 2199, 2200]) {
            const clicks = [clickAt(5000, a, s.clip), clickAt(5000 + gap, b, s.clip)]
            const zooms = withLevel(buildZooms(clicks, DURATION, s.clip), level)
            const steps = worstSteps(makeProject(zooms, s.clip), makeTrack(clicks), s, 5000, 5000 + gap)
            // A pan covers at most one frame side, on a ramp as long as the ease in
            expect(steps.edge).toBeLessThanOrEqual(maxKStep(600) + EPS)
            expect(steps.zoom).toBeLessThanOrEqual(1 + EPS)
          }
        }
      }
    }
  })

  it('bounds the camera when touching segments have different levels', () => {
    for (const s of setups()) {
      for (const [from, to] of [[2, 4], [4, 1], [1.25, 3]]) {
        const clicks = [clickAt(5000, { x: 0, y: 0 }, s.clip), clickAt(6200, { x: 1, y: 1 }, s.clip)]
        const [a, b] = buildZooms(clicks, DURATION, s.clip)
        const zooms = [{ ...a, level: from }, { ...b, level: to }]
        const steps = worstSteps(makeProject(zooms, s.clip), makeTrack(clicks), s, 5000, 7000)
        expect(steps.edge).toBeLessThanOrEqual(1.25 * maxKStep(600))
        expect(steps.zoom).toBeLessThanOrEqual(1 + 2 * maxKStep(600))
      }
    }
  })

  it('bounds the camera while walking through a group', () => {
    for (const s of setups()) {
      for (const level of [2, 4]) {
        const clicks = [
          clickAt(5000, { x: 0, y: 0 }, s.clip),
          clickAt(5400, { x: 1, y: 1 }, s.clip),
          clickAt(6400, { x: 0, y: 1 }, s.clip)
        ]
        const zooms = withLevel(buildZooms(clicks, DURATION, s.clip), level)
        expect(zooms).toHaveLength(1)
        const steps = worstSteps(makeProject(zooms, s.clip), makeTrack(clicks), s, 5000, 6400)
        expect(steps.edge).toBeLessThanOrEqual(maxKStep(400) + EPS)
      }
    }
  })

  it('stays continuous on recordings with random clicks', () => {
    const next = random(23)
    for (let run = 0; run < 6; run++) {
      let t = next() * 800
      const clicks: ClickPoint[] = []
      while (t < 20000) {
        clicks.push({ t, x: next() * 1920, y: next() * 1080 })
        t += 400 + next() * 3000
      }
      const track = makeTrack(clicks)
      const zooms = buildZooms(clicks, 20000, CLIPS[0])
      const shortest = Math.min(...zooms.flatMap((z) => [z.easeInMs, z.easeOutMs]).filter((ms) => ms > 0))
      for (const s of setups(CLIPS.slice(0, 1))) {
        const steps = worstSteps(makeProject(zooms, s.clip, 20000), track, s, 0, 20000)
        expect(steps.edge).toBeLessThanOrEqual(1.5 * maxKStep(Math.min(400, shortest)))
      }
    }
  })
})

describe('touching segments', () => {
  it('never dip below k=1 between them', () => {
    const clip = CLIPS[0]
    for (const gap of [1200, 1201, 1500, 2000, 2199, 2200]) {
      const clicks = [clickAt(5000, { x: 0.1, y: 0.1 }, clip), clickAt(5000 + gap, { x: 0.9, y: 0.9 }, clip)]
      const zooms = buildZooms(clicks, DURATION, clip)
      expect(zooms).toHaveLength(2)
      for (const phase of [0, 3, 7.5, 11]) {
        for (const t of sampleFrames(5000, 5000 + gap, 60, phase)) {
          expect(zoomAmount(zooms, t).k).toBe(1)
        }
      }
      expect(zoomAmount(zooms, zooms[0].endMs).k).toBe(1)
    }
  })

  it('never dip across a chain of three', () => {
    const clip = CLIPS[0]
    const clicks = [2000, 3300, 4600].map((t, i) => clickAt(t, CORNERS[i], clip))
    const zooms = buildZooms(clicks, DURATION, clip)
    for (const t of sampleFrames(2000, 4600)) expect(zoomAmount(zooms, t).k).toBe(1)
  })

  it('pan at held zoom from one click to the next', () => {
    for (const s of setups(CLIPS.slice(0, 1))) {
      const clicks = [clickAt(5000, { x: 0.1, y: 0.1 }, s.clip), clickAt(6200, { x: 0.9, y: 0.9 }, s.clip)]
      const zooms = buildZooms(clicks, DURATION, s.clip)
      const project = makeProject(zooms, s.clip)
      const track = makeTrack(clicks)
      const atJoin = frameAt(project, track, s, zooms[0].endMs)
      const afterJoin = frameAt(project, track, s, zooms[0].endMs + 1)
      const atClick = frameAt(project, track, s, 6200)
      expect(atJoin.camera.x).toBeCloseTo(frameAt(project, track, s, 5000).camera.x, 6)
      expect(afterJoin.camera.x).toBeCloseTo(atJoin.camera.x, 1)
      expectInsideCamera(clickOnCanvas(clicks[1], atClick.screen, s.clip), atClick.camera)
      expect(atClick.zoom).toBeCloseTo(atJoin.zoom, 9)
    }
  })

  it('arrive at the next click even when the pan comes from a group', () => {
    const clip = CLIPS[0]
    const clicks = [
      clickAt(3000, { x: 0, y: 0 }, clip),
      clickAt(3500, { x: 1, y: 0 }, clip),
      clickAt(4700, { x: 0, y: 1 }, clip)
    ]
    const zooms = buildZooms(clicks, DURATION, clip)
    expect(zooms).toHaveLength(2)
    const track = makeTrack(clicks)
    const start = aimAt(zooms, zooms[1], track, clip.width, clip.height, zooms[1].startMs + 1)
    expect(start.focus.x).toBeCloseTo(1, 4)
    expect(start.focus.y).toBeCloseTo(0, 4)
    const end = aimAt(zooms, zooms[1], track, clip.width, clip.height, 4700)
    expect(end.focus).toEqual({ x: 0, y: 1 })
  })

  it('keep the chain continuous when a pan is cut short by the next join', () => {
    const a = segment({ id: 'a', startMs: 0, endMs: 1000, focus: { x: 0, y: 0 } })
    const b = segment({ id: 'b', startMs: 1000, endMs: 1200, focus: { x: 1, y: 1 } })
    const c = segment({ id: 'c', startMs: 1200, endMs: 3000, focus: { x: 0, y: 1 } })
    const zooms = [a, b, c]
    const track = makeTrack([])
    const before = aimAt(zooms, b, track, 1920, 1080, 1200)
    const after = aimAt(zooms, c, track, 1920, 1080, 1200.001)
    expect(after.focus.x).toBeCloseTo(before.focus.x, 4)
    expect(after.focus.y).toBeCloseTo(before.focus.y, 4)
    expect(before.focus.x).toBeGreaterThan(0)
    expect(before.focus.x).toBeLessThan(1)
  })
})

describe('a group with several clicks', () => {
  const GAPS = [30, 80, 150, 300, 399, 400, 401, 800, 1199]

  it('has every click inside the camera at its own time', () => {
    for (const s of setups()) {
      for (const level of [1, 2, 4]) {
        for (const gap of GAPS) {
          const clicks = [
            clickAt(5000, { x: 0, y: 0 }, s.clip),
            clickAt(5000 + gap, { x: 1, y: 1 }, s.clip),
            clickAt(5000 + 2 * gap, { x: 1, y: 0 }, s.clip),
            clickAt(5000 + 3 * gap, { x: 0, y: 1 }, s.clip)
          ]
          const zooms = withLevel(buildZooms(clicks, DURATION, s.clip), level)
          expect(zooms).toHaveLength(1)
          const project = makeProject(zooms, s.clip)
          const track = makeTrack(clicks)
          for (const click of clicks) {
            const frame = frameAt(project, track, s, click.t)
            expectInsideCamera(clickOnCanvas(click, frame.screen, s.clip), frame.camera)
            expect(zoomAmount(zooms, click.t).k).toBe(1)
          }
        }
      }
    }
  })

  it('has every click inside the camera for random groups', () => {
    const next = random(41)
    for (let run = 0; run < 300; run++) {
      const s = setups()[run % setups().length]
      let t = next() * 2000
      const clicks: ClickPoint[] = []
      for (let i = 0; i < 2 + run % 5; i++) {
        clicks.push({ t, x: next() * s.clip.width, y: next() * s.clip.height })
        t += 1 + next() * 1198
      }
      const zooms = withLevel(buildZooms(clicks, t + 200, s.clip), 1 + next() * 3)
      expect(zooms).toHaveLength(1)
      const project = makeProject(zooms, s.clip, t + 200)
      const track = makeTrack(clicks)
      for (const click of clicks) {
        const frame = frameAt(project, track, s, click.t)
        expectInsideCamera(clickOnCanvas(click, frame.screen, s.clip), frame.camera)
      }
    }
  })

  it('walks the focus through each click exactly', () => {
    const clip = CLIPS[0]
    const clicks = [
      clickAt(5000, { x: 0.1, y: 0.2 }, clip),
      clickAt(5100, { x: 0.8, y: 0.3 }, clip),
      clickAt(5900, { x: 0.4, y: 0.9 }, clip)
    ]
    const [seg] = buildZooms(clicks, DURATION, clip)
    const track = makeTrack(clicks)
    expect(focusAt(seg, track, clip.width, clip.height, 5000)).toEqual({ x: 0.1, y: 0.2 })
    expect(focusAt(seg, track, clip.width, clip.height, 5100).x).toBeCloseTo(0.8)
    expect(focusAt(seg, track, clip.width, clip.height, 5100).y).toBeCloseTo(0.3)
    expect(focusAt(seg, track, clip.width, clip.height, 5900).x).toBeCloseTo(0.4)
    expect(focusAt(seg, track, clip.width, clip.height, 5900).y).toBeCloseTo(0.9)
  })

  it('keeps the first click in frame through the ease in', () => {
    const clip = CLIPS[0]
    const clicks = [clickAt(5000, { x: 0.1, y: 0.2 }, clip), clickAt(5100, { x: 0.8, y: 0.3 }, clip)]
    const [seg] = buildZooms(clicks, DURATION, clip)
    const track = makeTrack(clicks)
    for (const t of sampleFrames(seg.startMs, 5000)) {
      expect(focusAt(seg, track, clip.width, clip.height, t)).toEqual({ x: 0.1, y: 0.2 })
    }
  })

  it('leaves an edited or manual focus alone', () => {
    const clip = CLIPS[0]
    const clicks = [clickAt(5000, { x: 0.1, y: 0.2 }, clip), clickAt(5100, { x: 0.8, y: 0.3 }, clip)]
    const [seg] = buildZooms(clicks, DURATION, clip)
    const focus = { x: 0.6, y: 0.6 }
    const track = makeTrack(clicks)
    expect(focusAt({ ...seg, focus, edited: true }, track, clip.width, clip.height, 5100)).toEqual(focus)
    expect(focusAt({ ...seg, focus, origin: 'manual' }, track, clip.width, clip.height, 5100)).toEqual(focus)
  })
})
