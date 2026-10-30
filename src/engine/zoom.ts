import { clamp, type ClickPoint } from '../shared/compose'
import { ZOOM_DEFAULTS, type Ms, type ZoomSegment } from '../shared/project'

// A ramp shorter than this reads as a jump cut, so the camera holds the zoom instead
const MIN_EASE_MS = 100

function fitEase(room: Ms, ease: Ms): Ms {
  return room < MIN_EASE_MS ? 0 : Math.min(room, ease)
}

function groupClicks(clicks: ClickPoint[], durationMs: Ms): ClickPoint[][] {
  const inside = clicks.filter((c) => c.t >= 0 && c.t <= durationMs).sort((a, b) => a.t - b.t)
  const groups: ClickPoint[][] = []
  for (const click of inside) {
    const group = groups[groups.length - 1]
    if (group && click.t - group[group.length - 1].t < ZOOM_DEFAULTS.mergeGapMs) group.push(click)
    else groups.push([click])
  }
  return groups
}

function collides(a: ZoomSegment, b: ZoomSegment): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs
}

// Clicks to segments. Regenerating keeps every segment where edited is true, and manual ones,
// which are the user's own even before they change them. Same input, same output and IDs
export function buildZooms(
  clicks: ClickPoint[],
  durationMs: Ms,
  clip: { width: number; height: number },
  existing: ZoomSegment[] = []
): ZoomSegment[] {
  const { level, easeInMs, easeOutMs, tailMs } = ZOOM_DEFAULTS
  const kept = existing.filter((s) => s.edited || s.origin === 'manual')
  const groups = groupClicks(clicks, durationMs)

  const autos = groups.map((group, i): ZoomSegment => {
    const first = group[0]
    const last = group[group.length - 1]
    const next = groups[i + 1]
    const startMs = Math.max(0, first.t - easeInMs)
    const endMs = Math.min(durationMs, last.t + tailMs, next ? next[0].t - easeInMs : Infinity)
    return {
      id: '',
      startMs,
      endMs,
      level,
      easeInMs: fitEase(first.t - startMs, easeInMs),
      easeOutMs: fitEase(endMs - last.t, easeOutMs),
      focus: { x: clamp(first.x / clip.width, 0, 1), y: clamp(first.y / clip.height, 0, 1) },
      clickMs: group.map((c) => c.t),
      origin: 'auto',
      edited: false
    }
  })

  const taken = new Set(kept.map((s) => s.id))
  const uniqueId = (base: string): string => {
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    return id
  }

  const added = autos
    .filter((s) => s.endMs > s.startMs && !kept.some((e) => collides(s, e)))
    .map((s) => ({ ...s, id: uniqueId(`zoom-${Math.round(s.clickMs[0])}`) }))
  return [...kept, ...added].sort((a, b) => a.startMs - b.startMs)
}
