// The Smoothness slider. 0.5 is the spec's default spring, left is tighter, right is looser.
// Damping follows stiffness so the spring keeps the same near-critical feel at every setting.

import { CURSOR_DEFAULTS, type CursorStyle } from '../../shared/project'

const RANGE = 4 // Stiffness spans 4x either side of the default

export function smoothnessToSpring(smoothness: number): Pick<CursorStyle, 'stiffness' | 'damping'> {
  const stiffness = CURSOR_DEFAULTS.stiffness * Math.pow(RANGE, 1 - 2 * smoothness)
  const damping = CURSOR_DEFAULTS.damping * Math.sqrt(stiffness / CURSOR_DEFAULTS.stiffness)
  return { stiffness, damping }
}

export function springToSmoothness(stiffness: number): number {
  const s = (1 - Math.log(stiffness / CURSOR_DEFAULTS.stiffness) / Math.log(RANGE)) / 2
  return Math.max(0, Math.min(1, s))
}
