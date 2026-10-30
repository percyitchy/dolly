// Mapping between the project clock and a clip's own time. No DOM.

import { clamp } from '../../shared/compose'
import type { Clip, Ms } from '../../shared/project'

export const MAX_DRIFT_S = 0.12 // Past this it's a jump, so seek
const NUDGE_FROM_S = 0.015
const NUDGE_RATE = 0.03

export function clipSeconds(clip: Clip, t: Ms): number {
  return Math.max(0, (t - clip.startMs) / 1000)
}

export function projectMs(clip: Clip, seconds: number, durationMs: Ms): Ms {
  return clamp(clip.startMs + seconds * 1000, 0, durationMs)
}

export function clipIsLive(clip: Clip, t: Ms): boolean {
  return t >= clip.startMs && t < clip.startMs + clip.durationMs
}

export function needsResync(actualS: number, expectedS: number): boolean {
  return Math.abs(actualS - expectedS) > MAX_DRIFT_S
}

// Small drift gets eased away, because seeking audio clicks. drift is actual minus expected
export function nudgedRate(driftS: number): number {
  if (Math.abs(driftS) < NUDGE_FROM_S) return 1
  return driftS > 0 ? 1 - NUDGE_RATE : 1 + NUDGE_RATE
}

// Downsample mono samples to one peak per bucket, 0 to 1
export function peaksOf(samples: ArrayLike<number>, buckets: number): number[] {
  const peaks: number[] = []
  const size = samples.length / buckets
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size)
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((b + 1) * size)))
    let peak = 0
    // Long recordings have millions of samples and every 16th is plenty for a lane this thin
    for (let i = from; i < to; i += 16) peak = Math.max(peak, Math.abs(samples[i]))
    peaks.push(Math.min(1, peak))
  }
  return peaks
}

const SILENCE = 0.02 // Below this it's room noise, so it isn't scaled up to look like speech

// SVG path of a mirrored waveform in a viewBox of peaks.length x 48, scaled to its loudest moment
export function peaksToPath(peaks: number[]): string {
  const top = peaks.reduce((max, p) => Math.max(max, p), SILENCE)
  return peaks
    .map((p, i) => {
      const half = Math.max(0.5, (p / top) * 24)
      return `M${i} ${(24 - half).toFixed(1)}v${(half * 2).toFixed(1)}`
    })
    .join('')
}
