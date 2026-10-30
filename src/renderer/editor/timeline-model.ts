// Pure timeline maths. Every function takes the zoom list and returns a new sorted one, or the same
// array when nothing changed, so a click that moves nothing never marks a block as edited.

import { clamp } from '../../shared/compose'
import { ZOOM_DEFAULTS, type Ms, type ZoomSegment } from '../../shared/project'

export const MIN_BLOCK_MS = 500
export const ADD_BLOCK_MS = 2000
export const LEVEL_RANGE = { min: 1.2, max: 4 }
export const EASE_RANGE = { min: 0, max: 1500 }

interface Room {
  seg: ZoomSegment
  lo: Ms // Where the previous block ends, or 0
  hi: Ms // Where the next block starts, or the end of the recording
}

function roomFor(zooms: ZoomSegment[], id: string, durationMs: Ms): Room | null {
  const sorted = sortZooms(zooms)
  const i = sorted.findIndex((z) => z.id === id)
  if (i < 0) return null
  return {
    seg: sorted[i],
    lo: i > 0 ? sorted[i - 1].endMs : 0,
    hi: i < sorted.length - 1 ? sorted[i + 1].startMs : durationMs
  }
}

export function sortZooms(zooms: ZoomSegment[]): ZoomSegment[] {
  return [...zooms].sort((a, b) => a.startMs - b.startMs)
}

function replace(zooms: ZoomSegment[], seg: ZoomSegment, next: Partial<ZoomSegment>): ZoomSegment[] {
  const keys = Object.keys(next) as (keyof ZoomSegment)[]
  if (keys.every((k) => Object.is(seg[k], next[k]))) return zooms
  return sortZooms(zooms.map((z) => (z.id === seg.id ? { ...z, ...next, edited: true } : z)))
}

// A block too short for its eases would never reach full zoom, so the eases give way
function fitEase(startMs: Ms, endMs: Ms, seg: ZoomSegment): Pick<ZoomSegment, 'easeInMs' | 'easeOutMs'> {
  const len = endMs - startMs
  const total = seg.easeInMs + seg.easeOutMs
  if (total <= len || total === 0) return { easeInMs: seg.easeInMs, easeOutMs: seg.easeOutMs }
  return { easeInMs: (seg.easeInMs * len) / total, easeOutMs: (seg.easeOutMs * len) / total }
}

export function moveBlock(zooms: ZoomSegment[], id: string, startMs: Ms, durationMs: Ms): ZoomSegment[] {
  const room = roomFor(zooms, id, durationMs)
  if (!room) return zooms
  const { seg, lo, hi } = room
  const len = seg.endMs - seg.startMs
  const start = clamp(startMs, lo, Math.max(lo, hi - len))
  return replace(zooms, seg, { startMs: start, endMs: start + len })
}

export function stretchStart(zooms: ZoomSegment[], id: string, startMs: Ms, durationMs: Ms): ZoomSegment[] {
  const room = roomFor(zooms, id, durationMs)
  if (!room) return zooms
  const { seg, lo } = room
  const latest = Math.max(seg.startMs, seg.endMs - MIN_BLOCK_MS)
  const start = clamp(startMs, Math.min(lo, seg.startMs), latest)
  return replace(zooms, seg, { startMs: start, ...fitEase(start, seg.endMs, seg) })
}

export function stretchEnd(zooms: ZoomSegment[], id: string, endMs: Ms, durationMs: Ms): ZoomSegment[] {
  const room = roomFor(zooms, id, durationMs)
  if (!room) return zooms
  const { seg, hi } = room
  const earliest = Math.min(seg.endMs, seg.startMs + MIN_BLOCK_MS)
  const end = clamp(endMs, earliest, Math.max(hi, seg.endMs))
  return replace(zooms, seg, { endMs: end, ...fitEase(seg.startMs, end, seg) })
}

export function deleteBlock(zooms: ZoomSegment[], id: string): ZoomSegment[] {
  return zooms.some((z) => z.id === id) ? zooms.filter((z) => z.id !== id) : zooms
}

// The stretch of free time at t, or null when t sits inside a block
function gapAt(zooms: ZoomSegment[], t: Ms, durationMs: Ms): { lo: Ms; hi: Ms } | null {
  let lo = 0
  let hi = durationMs
  for (const z of sortZooms(zooms)) {
    if (t >= z.startMs && t < z.endMs) return null
    if (z.endMs <= t) lo = Math.max(lo, z.endMs)
    else if (z.startMs > t) hi = Math.min(hi, z.startMs)
  }
  return { lo, hi }
}

export function canAddZoom(zooms: ZoomSegment[], t: Ms, durationMs: Ms): boolean {
  const gap = gapAt(zooms, clamp(t, 0, durationMs), durationMs)
  return !!gap && gap.hi - gap.lo >= Math.min(MIN_BLOCK_MS, durationMs) && durationMs > 0
}

// A manual block at the playhead, slid back if it would run into the next block or the end
export function addZoom(
  zooms: ZoomSegment[],
  t: Ms,
  durationMs: Ms,
  focus: { x: number; y: number },
  id: string
): ZoomSegment[] | null {
  const at = clamp(t, 0, durationMs)
  if (!canAddZoom(zooms, at, durationMs)) return null
  const gap = gapAt(zooms, at, durationMs)!
  const len = Math.min(ADD_BLOCK_MS, gap.hi - gap.lo)
  const startMs = clamp(at, gap.lo, gap.hi - len)
  const endMs = startMs + len
  const seg: ZoomSegment = {
    id,
    startMs,
    endMs,
    level: ZOOM_DEFAULTS.level,
    ...fitEase(startMs, endMs, { easeInMs: ZOOM_DEFAULTS.easeInMs, easeOutMs: ZOOM_DEFAULTS.easeOutMs } as ZoomSegment),
    focus: { x: clamp(focus.x, 0, 1), y: clamp(focus.y, 0, 1) },
    clickMs: [],
    origin: 'manual',
    edited: true
  }
  return sortZooms([...zooms, seg])
}

export interface BlockPatch {
  level?: number
  easeInMs?: Ms
  easeOutMs?: Ms
  focus?: { x: number; y: number }
}

export function updateBlock(zooms: ZoomSegment[], id: string, patch: BlockPatch): ZoomSegment[] {
  const seg = zooms.find((z) => z.id === id)
  if (!seg) return zooms
  const len = seg.endMs - seg.startMs
  const next: Partial<ZoomSegment> = {}
  if (patch.level !== undefined) next.level = clamp(patch.level, LEVEL_RANGE.min, LEVEL_RANGE.max)
  if (patch.easeInMs !== undefined) next.easeInMs = clamp(patch.easeInMs, 0, Math.max(0, len - seg.easeOutMs))
  if (patch.easeOutMs !== undefined) next.easeOutMs = clamp(patch.easeOutMs, 0, Math.max(0, len - seg.easeInMs))
  if (patch.focus) {
    const x = clamp(patch.focus.x, 0, 1)
    const y = clamp(patch.focus.y, 0, 1)
    if (x !== seg.focus.x || y !== seg.focus.y) next.focus = { x, y }
  }
  return replace(zooms, seg, next)
}

// When the block is on screen at its fullest, for jumping the playhead there
export function fullZoomMs(seg: ZoomSegment): Ms {
  return Math.min(seg.startMs + seg.easeInMs, seg.endMs)
}

export function blockLabel(seg: ZoomSegment): string {
  const level = `${seg.level.toFixed(1)}×`
  return seg.clickMs.length > 1 ? `${level} · ${seg.clickMs.length} clicks` : level
}

export function msFromX(x: number, width: number, durationMs: Ms): Ms {
  if (width <= 0) return 0
  return clamp((x / width) * durationMs, 0, durationMs)
}

export function pct(ms: Ms, durationMs: Ms): string {
  return `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`
}

const RULER_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

// Labelled ruler ticks, spaced so they never collide at this width
export function rulerTicks(durationMs: Ms, widthPx: number, minGapPx = 64): { ms: Ms; label: string }[] {
  if (durationMs <= 0 || widthPx <= 0) return [{ ms: 0, label: '0s' }]
  const seconds = durationMs / 1000
  const step = RULER_STEPS_S.find((s) => (s / seconds) * widthPx >= minGapPx) ?? RULER_STEPS_S[RULER_STEPS_S.length - 1]
  const ticks: { ms: Ms; label: string }[] = []
  for (let s = 0; s < seconds; s += step) ticks.push({ ms: s * 1000, label: rulerLabel(s) })
  return ticks
}

function rulerLabel(s: number): string {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatTimecode(ms: Ms, fps: number): string {
  const total = Math.max(0, ms)
  const seconds = Math.floor(total / 1000)
  const frames = Math.floor(((total % 1000) / 1000) * fps)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}:${two(frames)}`
}

export function formatDuration(ms: Ms): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// The zoom summary on the timeline header
export function zoomSummary(zoomCount: number, clickCount: number): string {
  const zooms = `${zoomCount} ${zoomCount === 1 ? 'zoom' : 'zooms'}`
  return `${zooms} from ${clickCount} ${clickCount === 1 ? 'click' : 'clicks'}`
}
