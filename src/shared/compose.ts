// Pure frame maths. compose(project, track, shape, size, t) describes one output frame, and both the
// preview and the export draw exactly that description. Same input, same frame.

import type { Caption, Ms, Project, Px, Shape, ZoomSegment } from './project'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ClickPoint {
  t: Ms
  x: Px
  y: Px
}

// Built by engine/cursor.ts. Positions are in screen clip pixels
export interface CursorTrack {
  at(t: Ms): { x: Px; y: Px }
  clicks: ClickPoint[]
}

export interface FrameSpec {
  width: number
  height: number
  // Camera window into the canvas. The renderer maps this rect onto the whole output
  camera: Rect
  // The screen clip's rect on the canvas, before the camera applies
  screen: Rect
  radius: number // Canvas px
  shadow: number // 0 to 1
  // All below are canvas px, so the renderer applies the camera to them too
  cursor: { x: number; y: number; scale: number } | null
  ripple: { x: number; y: number; progress: number } | null
  // Fixed to the output, not moved by the camera
  webcam: { rect: Rect; shape: 'circle' | 'rounded' } | null
  caption: string | null
  zoom: number // Current camera scale, 1 at rest
}

const RIPPLE_MS = 400
const FOCUS_MOVE_MS = 400

export function easeInOutCubic(x: number): number {
  const v = clamp(x, 0, 1)
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k
}

// Screen rect at rest. 16:9 pads inside the frame, 1:1 and 9:16 fit the frame width
export function restRect(frameW: number, frameH: number, clipW: number, clipH: number, paddingPct: number): Rect {
  const pad = frameW > frameH ? (frameH * paddingPct) / 100 : 0
  const scale = Math.min((frameW - pad * 2) / clipW, (frameH - pad * 2) / clipH)
  const w = clipW * scale
  const h = clipH * scale
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h }
}

// Eased progress of a ramp. A ramp with no length is already done once it starts
function ramp(elapsed: Ms, ms: Ms): number {
  return ms > 0 ? easeInOutCubic(elapsed / ms) : elapsed >= 0 ? 1 : 0
}

function byStart(zooms: ZoomSegment[]): ZoomSegment[] {
  return [...zooms].sort((a, b) => a.startMs - b.startMs)
}

// How far in the camera is at time t: 0 at rest, 1 at full zoom. Touching segments stay at 1 between them
export function zoomAmount(zooms: ZoomSegment[], t: Ms): { k: number; seg: ZoomSegment | null } {
  const sorted = byStart(zooms)
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    if (t < s.startMs || t > s.endMs) continue
    const touchedBefore = sorted.slice(0, i).some((o) => o.endMs >= s.startMs)
    const touchedAfter = sorted.slice(i + 1).some((o) => o.startMs <= s.endMs)
    const inK = touchedBefore ? 1 : ramp(t - s.startMs, s.easeInMs)
    const outK = touchedAfter ? 1 : ramp(s.endMs - t, s.easeOutMs)
    return { k: Math.min(inK, outK), seg: s }
  }
  return { k: 0, seg: null }
}

// Where the camera aims, 0 to 1 across the screen clip. Unedited auto zooms walk through their clicks,
// arriving on each one exactly at its own time
export function focusAt(seg: ZoomSegment, track: CursorTrack, clipW: number, clipH: number, t: Ms): { x: number; y: number } {
  if (seg.edited || seg.origin === 'manual' || seg.clickMs.length < 2) return seg.focus
  const points = seg.clickMs
    .map((ms) => track.clicks.find((c) => c.t === ms))
    .filter((c): c is ClickPoint => !!c)
    .map((c) => ({ t: c.t, x: c.x / clipW, y: c.y / clipH }))
  if (points.length === 0) return seg.focus
  let at = { x: points[0].x, y: points[0].y }
  for (let i = 1; i < points.length; i++) {
    const moveMs = Math.min(FOCUS_MOVE_MS, points[i].t - points[i - 1].t)
    const k = ramp(t - (points[i].t - moveMs), moveMs)
    at = { x: lerp(at.x, points[i].x, k), y: lerp(at.y, points[i].y, k) }
  }
  return at
}

// The focus and level to aim with. A segment that touches the one before it pans and changes level
// from there over its ease in, which is what keeps the camera moving at held zoom across the join
export function aimAt(
  zooms: ZoomSegment[],
  seg: ZoomSegment,
  track: CursorTrack,
  clipW: number,
  clipH: number,
  t: Ms
): { focus: { x: number; y: number }; level: number } {
  const own = { focus: focusAt(seg, track, clipW, clipH, t), level: seg.level }
  const sorted = byStart(zooms)
  const prev = sorted
    .slice(0, sorted.indexOf(seg))
    .filter((o) => o.endMs >= seg.startMs)
    .sort((a, b) => a.endMs - b.endMs)
    .pop()
  if (!prev) return own
  const k = ramp(t - prev.endMs, seg.startMs + seg.easeInMs - prev.endMs)
  if (k >= 1) return own
  const from = aimAt(zooms, prev, track, clipW, clipH, prev.endMs)
  return {
    focus: { x: lerp(from.focus.x, own.focus.x, k), y: lerp(from.focus.y, own.focus.y, k) },
    level: lerp(from.level, own.level, k)
  }
}

// The camera for one shape. At full zoom every shape shows the same slice of the screen:
// screen height on canvas = frame height x level. Bounds tighten from the canvas to the screen as it zooms
export function cameraAt(
  frameW: number,
  frameH: number,
  rest: Rect,
  level: number,
  k: number,
  focus: { x: number; y: number }
): { rect: Rect; scale: number } {
  const target = Math.max(1, (level * frameH) / rest.h)
  const scale = Math.pow(target, k)
  const w = frameW / scale
  const h = frameH / scale
  const fx = rest.x + focus.x * rest.w
  const fy = rest.y + focus.y * rest.h
  const wantX = lerp(frameW / 2, fx, k)
  const wantY = lerp(frameH / 2, fy, k)
  const left = lerp(0, rest.x, k)
  const right = lerp(frameW, rest.x + rest.w, k)
  const top = lerp(0, rest.y, k)
  const bottom = lerp(frameH, rest.y + rest.h, k)
  const cx = fitAxis(wantX, w, left, right, frameW)
  const cy = fitAxis(wantY, h, top, bottom, frameH)
  return { rect: { x: cx - w / 2, y: cy - h / 2, w, h }, scale }
}

// Centre on an axis inside [lo, hi], and always inside the canvas [0, limit]
function fitAxis(want: number, size: number, lo: number, hi: number, limit: number): number {
  const half = size / 2
  const inner = size <= hi - lo ? clamp(want, lo + half, hi - half) : (lo + hi) / 2
  return clamp(inner, half, limit - half)
}

function captionAt(captions: Caption[], t: Ms): string | null {
  return captions.find((c) => t >= c.startMs && t < c.endMs)?.text ?? null
}

export function compose(
  project: Project,
  track: CursorTrack,
  shape: Shape,
  size: { width: number; height: number },
  t: Ms,
  pro: { webcam: boolean; captions: boolean }
): FrameSpec {
  const clip = project.clips.find((c) => c.kind === 'screen')
  if (!clip?.width || !clip.height) throw new Error('Project has no screen clip')
  const { width, height } = size
  const rest = restRect(width, height, clip.width, clip.height, project.look.paddingPct)
  const { k, seg } = zoomAmount(project.zooms, t)
  const aim = seg
    ? aimAt(project.zooms, seg, track, clip.width, clip.height, t)
    : { focus: { x: 0.5, y: 0.5 }, level: 1 }
  const { rect: camera, scale } = cameraAt(width, height, rest, aim.level, k, aim.focus)

  const toCanvas = (p: { x: Px; y: Px }) => ({
    x: rest.x + (p.x / clip.width!) * rest.w,
    y: rest.y + (p.y / clip.height!) * rest.h
  })

  const c = toCanvas(track.at(t))
  const click = project.cursor.clickRipple
    ? [...track.clicks].reverse().find((e) => t >= e.t && t - e.t < RIPPLE_MS)
    : undefined
  const ripple = click ? { ...toCanvas(click), progress: (t - click.t) / RIPPLE_MS } : null

  let webcam: FrameSpec['webcam'] = null
  if (project.webcam && pro.webcam && project.clips.some((x) => x.kind === 'webcam')) {
    const shrink = lerp(1, 2 / 3, k) // Shrinks by a third while zoomed
    const s = (Math.min(width, height) * project.webcam.sizePct * shrink) / 100
    const m = Math.min(width, height) * 0.04
    const left = project.webcam.corner === 'tl' || project.webcam.corner === 'bl'
    const top = project.webcam.corner === 'tl' || project.webcam.corner === 'tr'
    webcam = {
      rect: { x: left ? m : width - m - s, y: top ? m : height - m - s, w: s, h: s },
      shape: project.webcam.shape
    }
  }

  return {
    width,
    height,
    camera,
    screen: rest,
    radius: (Math.min(rest.w, rest.h) * project.look.cornerRadiusPct) / 100,
    shadow: project.look.shadow,
    // The renderer's arrow is sized for a 2x clip, so a 1x display doesn't get one twice as big
    cursor: { ...c, scale: (project.cursor.scale * (clip.scaleFactor ?? 2) * rest.w) / (2 * clip.width) },
    ripple,
    webcam,
    caption: pro.captions ? captionAt(project.captions, t) : null,
    zoom: scale
  }
}
