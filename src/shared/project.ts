// The project data model. Everything on disk and everything the engines read is one of these types.

export type Ms = number // Milliseconds from recording start, capture clock
export type Px = number // Pixels in the screen clip

export interface Project {
  version: 1
  id: string
  name: string
  createdAt: string // ISO 8601
  durationMs: Ms
  clips: Clip[]
  zooms: ZoomSegment[]
  look: Look
  cursor: CursorStyle
  webcam: WebcamStyle | null // Pro
  captions: Caption[] // Pro
  output: OutputSettings
}

export interface Clip {
  id: string
  kind: 'screen' | 'mic' | 'webcam'
  file: string // Relative to the project folder
  startMs: Ms // Offset against the capture clock
  durationMs: Ms
  width?: Px
  height?: Px
  fps?: number
  scaleFactor?: number // Screen points to pixels
}

// One JSON object per line in cursor.jsonl. Kept out of project.json for size
export interface CursorEvent {
  t: Ms
  x: Px
  y: Px
  kind: 'move' | 'down' | 'up'
  button?: 'left' | 'right' | 'middle'
}

export interface ZoomSegment {
  id: string
  startMs: Ms
  endMs: Ms
  level: number // Default 2.0
  easeInMs: Ms // Default 600
  easeOutMs: Ms // Default 600
  focus: { x: number; y: number } // 0 to 1 across the screen clip
  clickMs: Ms[] // Clicks merged here, empty for manual zooms
  origin: 'auto' | 'manual'
  edited: boolean // True once the user changes it
}

export interface Look {
  background: { kind: 'wallpaper'; id: string } | { kind: 'image'; file: string } // image is Pro
  paddingPct: number // Default 6
  cornerRadiusPct: number
  shadow: number // 0 to 1
}

export interface CursorStyle {
  smooth: boolean
  stiffness: number // Default 170
  damping: number // Default 26
  scale: number
  clickRipple: boolean
}

export interface WebcamStyle {
  shape: 'circle' | 'rounded'
  corner: 'tl' | 'tr' | 'bl' | 'br'
  sizePct: number
}

export interface Caption {
  id: string
  startMs: Ms
  endMs: Ms
  text: string
}

export type Shape = '16:9' | '1:1' | '9:16' // 9:16 is Pro

export interface OutputSettings {
  shapes: Shape[]
  format: 'mp4' | 'gif' // gif is Pro
  resolution: '1080p' | '4k' // 4k is Pro
  fps: 30 | 60 // 60 is Pro
  folder: string
}

export const ZOOM_DEFAULTS = {
  level: 2,
  easeInMs: 600,
  easeOutMs: 600,
  mergeGapMs: 1200, // Clicks closer than this share a segment
  tailMs: 1600 // Last click to segment end: 1.0 s hold plus 0.6 s ease out
} as const

export const CURSOR_DEFAULTS: CursorStyle = {
  smooth: true,
  stiffness: 170,
  damping: 26,
  scale: 1,
  clickRipple: true
}

export const LOOK_DEFAULTS: Look = {
  background: { kind: 'wallpaper', id: 'dusk' },
  paddingPct: 6,
  cornerRadiusPct: 1.2,
  shadow: 0.5
}

// Output pixels for a shape. 1080p and 4K name the short side
export function outputSize(shape: Shape, resolution: OutputSettings['resolution']): { width: number; height: number } {
  const short = resolution === '4k' ? 2160 : 1080
  const long = Math.round((short * 16) / 9)
  if (shape === '16:9') return { width: long, height: short }
  if (shape === '9:16') return { width: short, height: long }
  return { width: short, height: short }
}
