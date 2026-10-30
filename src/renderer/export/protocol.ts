// Messages on the MessagePort between main and the hidden export window.

import type { FrameSpec } from '../../shared/compose'

export interface RawPlanes {
  format: 'yuv420p'
  width: number
  height: number
  matrix: 'bt709' | 'bt601'
  data: Uint8Array
}

export type ExportBackground = { kind: 'wallpaper'; id: string } | { kind: 'image'; bytes: Uint8Array }

export type ToWindow =
  | { type: 'begin'; job: number; width: number; height: number; background: ExportBackground }
  // screen or webcam is left out when the source frame hasn't changed since the last message
  | { type: 'frame'; job: number; n: number; spec: FrameSpec; screen?: RawPlanes; webcam?: RawPlanes }

export type FromWindow =
  | { type: 'ready'; job: number }
  | { type: 'rendered'; job: number; n: number; pixels: Uint8Array }
  | { type: 'error'; message: string }
