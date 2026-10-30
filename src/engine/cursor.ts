// Spring smoothing, offline over the whole recording. The result is a 240 Hz table, so at() costs the same
// in order or scrubbing. The spring chases the raw path shifted ahead by its own lag, which cancels that lag,
// and is parked on each click so the last 80 ms has little left to correct.

import { clamp } from '../shared/compose'
import type { ClickPoint, CursorTrack } from '../shared/compose'
import type { CursorEvent, CursorStyle, Ms, Px } from '../shared/project'
import { CURSOR_DEFAULTS } from '../shared/project'

const STEP_MS = 1000 / 240
const PULL_MS = 80
const HOLD_SLOP_PX = 4 // Further than this between down and up is a drag, so the cursor has to follow
const MAX_GLIDE_MS = 1000 // No events means no movement, so a longer gap sits still and moves only at its end
const MAX_SPAN_MS = 6 * 60 * 60 * 1000 // Past this a table is too big, most likely a corrupt timestamp
const MAX_TAIL_STEPS = 30 * 240
const SETTLED_PX = 0.01

interface Point {
  x: Px
  y: Px
}

// A click, when the raw path got there, and how long the cursor stays on it
interface Anchor extends Point {
  arrive: Ms
  t: Ms
  end: Ms
}

// Raw positions at strictly increasing times
interface Path {
  ts: Float64Array
  xs: Float64Array
  ys: Float64Array
}

export function buildCursorTrack(events: CursorEvent[], style: CursorStyle): CursorTrack {
  const sorted = events
    .filter((e) => Number.isFinite(e.t) && Number.isFinite(e.x) && Number.isFinite(e.y))
    .sort((a, b) => a.t - b.t)
  const clicks: ClickPoint[] = sorted.filter(isLeftDown).map(({ t, x, y }) => ({ t, x, y }))
  if (sorted.length === 0) return { at: () => ({ x: 0, y: 0 }), clicks }

  const knots = collapseTimes(sorted)
  const path = buildPath(knots)
  const span = sorted[sorted.length - 1].t - sorted[0].t
  if (!style.smooth || span > MAX_SPAN_MS) return { at: (t) => rawAt(path, t), clicks }
  return { at: tableReader(path, knots, style), clicks }
}

function isLeftDown(e: CursorEvent): boolean {
  return e.kind === 'down' && e.button === 'left'
}

// One event per timestamp. A left down outranks everything, so its position is the one the path goes through
function collapseTimes(sorted: CursorEvent[]): CursorEvent[] {
  const rank = (e: CursorEvent) => (isLeftDown(e) ? 2 : e.kind === 'down' ? 1 : 0)
  const out: CursorEvent[] = []
  for (const e of sorted) {
    const prev = out[out.length - 1]
    if (prev?.t !== e.t) out.push(e)
    else if (rank(e) >= rank(prev)) out[out.length - 1] = e
  }
  return out
}

function buildPath(knots: CursorEvent[]): Path {
  const ts: number[] = []
  const xs: number[] = []
  const ys: number[] = []
  knots.forEach((e, i) => {
    const prev = knots[i - 1]
    if (prev && e.t - prev.t > MAX_GLIDE_MS) {
      ts.push(e.t - MAX_GLIDE_MS)
      xs.push(prev.x)
      ys.push(prev.y)
    }
    ts.push(e.t)
    xs.push(e.x)
    ys.push(e.y)
  })
  return { ts: Float64Array.from(ts), xs: Float64Array.from(xs), ys: Float64Array.from(ys) }
}

function rawAt({ ts, xs, ys }: Path, t: Ms): Point {
  const last = ts.length - 1
  if (!(t > ts[0])) return { x: xs[0], y: ys[0] }
  if (t >= ts[last]) return { x: xs[last], y: ys[last] }
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] <= t) lo = mid
    else hi = mid
  }
  const k = (t - ts[lo]) / (ts[hi] - ts[lo])
  return { x: xs[lo] + (xs[hi] - xs[lo]) * k, y: ys[lo] + (ys[hi] - ys[lo]) * k }
}

// Every button counts here, so a context menu opens under the cursor too, though clicks only lists the left one.
// Held to the up, or until the raw path leaves the click: a held button may be a drag
function findAnchors(knots: CursorEvent[]): Anchor[] {
  const anchors: Anchor[] = []
  knots.forEach((e, i) => {
    if (e.kind !== 'down') return
    const near = (n: CursorEvent) => Math.hypot(n.x - e.x, n.y - e.y) <= HOLD_SLOP_PX
    let arrive = e.t
    for (let j = i - 1; j >= 0 && knots[j].kind !== 'down' && near(knots[j]); j--) arrive = knots[j].t
    let end = knots[knots.length - 1].t
    for (let j = i + 1; j < knots.length; j++) {
      const n = knots[j]
      const released = n.kind === 'up' && n.button === e.button
      if (released || n.kind === 'down' || !near(n)) {
        end = n.t
        break
      }
    }
    anchors.push({ arrive, t: e.t, end, x: e.x, y: e.y })
  })
  return anchors
}

// Exact solution of x'' + cx' + k(x - target) = 0 over one step with a fixed target. Stable at any stiffness,
// where an Euler step would blow up, and it needs no case for under, over or critical damping
function springStep(k: number, c: number, h: number) {
  const disc = k - (c * c) / 4
  const w = Math.sqrt(Math.abs(disc))
  const co = disc > 0 ? Math.cos(w * h) : Math.cosh(w * h)
  const si = w < 1e-9 ? h : (disc > 0 ? Math.sin(w * h) : Math.sinh(w * h)) / w
  const decay = Math.exp((-c * h) / 2)
  return {
    xx: decay * (co + (c / 2) * si),
    xv: decay * si,
    vx: decay * -k * si,
    vv: decay * (co - (c / 2) * si)
  }
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u)
}

function tableReader(path: Path, knots: CursorEvent[], style: CursorStyle): (t: Ms) => Point {
  const anchors = findAnchors(knots)
  const { xs, ys, count } = simulate(path, anchors, style)
  const start = path.ts[0]

  return (t) => {
    const hold = anchorAt(anchors, t)
    if (hold) return { x: hold.x, y: hold.y }
    const p = (t - start) / STEP_MS
    if (!(p > 0)) return { x: xs[0], y: ys[0] }
    if (p >= count - 1) return { x: xs[count - 1], y: ys[count - 1] }
    const i = Math.floor(p)
    const k = p - i
    return { x: xs[i] + (xs[i + 1] - xs[i]) * k, y: ys[i] + (ys[i + 1] - ys[i]) * k }
  }
}

// The table cannot separate two clicks inside one step, so held time is answered from the click itself
function anchorAt(anchors: Anchor[], t: Ms): Anchor | null {
  let lo = 0
  let hi = anchors.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (anchors[mid].t <= t) lo = mid + 1
    else hi = mid
  }
  const a = anchors[lo - 1]
  return a && t <= a.end ? a : null
}

function simulate(path: Path, anchors: Anchor[], style: CursorStyle) {
  const k = clamp(Number.isFinite(style.stiffness) ? style.stiffness : CURSOR_DEFAULTS.stiffness, 1, 1e5)
  const c = clamp(Number.isFinite(style.damping) ? style.damping : CURSOR_DEFAULTS.damping, 0, 1e4)
  const leadMs = Math.max(0, (c / k) * 1000 - STEP_MS / 2) // The target is read once per step, half a step early
  // 80 ms at the default spring. A softer spring moves slower, so its pull is stretched to stay in proportion
  const pullMs = PULL_MS * Math.max(1, Math.sqrt(CURSOR_DEFAULTS.stiffness / k))
  const roaming = springStep(k, c, STEP_MS / 1000)
  // Once the target is on a click, at least critical damping, so a bouncy spring settles onto it instead of past it
  const landing = springStep(k, Math.max(c, 2 * Math.sqrt(k)), STEP_MS / 1000)

  const { ts, xs: rawX, ys: rawY } = path
  const lastKnot = ts.length - 1
  const start = ts[0]
  const body = Math.ceil((ts[lastKnot] - start) / STEP_MS) + 1
  const xs = new Float64Array(body + MAX_TAIL_STEPS)
  const ys = new Float64Array(body + MAX_TAIL_STEPS)

  let x = rawX[0]
  let y = rawY[0]
  let vx = 0
  let vy = 0
  let next = 0 // First anchor still ahead or held
  let free = start // When the cursor last came off a click
  let parked = false // The target has reached the next click
  let nx = 0 // Unit direction of the final approach
  let ny = 0
  let knot = 0
  let count = 0

  for (let i = 0; i < xs.length; i++) {
    const t = start + i * STEP_MS
    while (next < anchors.length && anchors[next].end < t) {
      const left = anchors[next++]
      x = left.x
      y = left.y
      vx = 0
      vy = 0
      free = left.end
      parked = false
    }

    const a = anchors[next]
    count = i + 1
    if (a && t + STEP_MS > a.t) {
      xs[i] = a.x
      ys[i] = a.y
      continue
    }

    if (a && !parked && t + leadMs >= a.arrive) {
      const d = Math.hypot(a.x - x, a.y - y) || 1
      nx = (a.x - x) / d
      ny = (a.y - y) / d
      parked = true
    }

    const want = parked ? a.t : t + leadMs
    while (knot < lastKnot && ts[knot + 1] <= want) knot++
    const after = Math.min(knot + 1, lastKnot)
    const seg = after > knot ? (want - ts[knot]) / (ts[after] - ts[knot]) : 0
    const tx = rawX[knot] + (rawX[after] - rawX[knot]) * seg
    const ty = rawY[knot] + (rawY[after] - rawY[knot]) * seg

    if (i > 0) {
      const s = parked ? landing : roaming
      const ex = x - tx
      const ey = y - ty
      x = tx + s.xx * ex + s.xv * vx
      y = ty + s.xx * ey + s.xv * vy
      vx = s.vx * ex + s.vv * vx
      vy = s.vx * ey + s.vv * vy
    }

    if (parked) {
      // Fast enough, even that passes it. Stop on the near side
      const past = (x - a.x) * nx + (y - a.y) * ny
      if (past > 0) {
        x -= past * nx
        y -= past * ny
        const speed = Math.max(0, vx * nx + vy * ny)
        vx -= speed * nx
        vy -= speed * ny
      }
    }

    let px = x
    let py = y
    if (a) {
      // The table lands on the last step at or before the click, so nothing is left for at() to jump over
      const land = start + Math.floor((a.t - start) / STEP_MS) * STEP_MS
      const from = Math.max(a.t - pullMs, free)
      if (t > from) {
        const w = smoothstep((t - from) / (land - from))
        px += (a.x - x) * w
        py += (a.y - y) * w
      }
    }
    xs[i] = px
    ys[i] = py

    const rest = Math.abs(rawX[lastKnot] - x) + Math.abs(rawY[lastKnot] - y) + Math.abs(vx) + Math.abs(vy)
    if (i >= body - 1 && !a && rest < SETTLED_PX) break
  }

  xs[count - 1] = rawX[lastKnot]
  ys[count - 1] = rawY[lastKnot]
  return { xs, ys, count }
}
