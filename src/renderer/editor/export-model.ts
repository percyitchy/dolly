// What the export strip shows and sends. No DOM.

import { can, FEATURE_LABELS, shapeFeature, type Feature, type Plan } from '../../shared/entitlements'
import { outputSize, type Ms, type OutputSettings, type Shape } from '../../shared/project'

export const SHAPE_INFO: { shape: Shape; name: string; hint: string }[] = [
  { shape: '16:9', name: 'Landscape', hint: '16:9 · X, YouTube' },
  { shape: '1:1', name: 'Square', hint: '1:1 · LinkedIn' },
  { shape: '9:16', name: 'Vertical', hint: '9:16' }
]

export function shapeName(shape: Shape): string {
  return SHAPE_INFO.find((s) => s.shape === shape)?.name ?? shape
}

// A project saved with Pro settings keeps them, but Free exports what Free allows
export function effectiveOutput(plan: Plan, output: OutputSettings): OutputSettings {
  return {
    ...output,
    shapes: output.shapes.filter((shape) => {
      const feature = shapeFeature(shape)
      return !feature || can(plan, feature)
    }),
    format: output.format === 'gif' && !can(plan, 'gif') ? 'mp4' : output.format,
    resolution: output.resolution === '4k' && !can(plan, 'export4k') ? '1080p' : output.resolution,
    fps: output.fps === 60 && !can(plan, 'export60fps') ? 30 : output.fps
  }
}

const MP4_BITS_PER_PIXEL = 0.13 // Screen content at about 8 Mbps for 1080p30
const GIF_BITS_PER_PIXEL = 0.8
const GIF_LONG_SIDE = 720
const GIF_FPS = 15

export function estimateBytes(output: OutputSettings, durationMs: Ms): number {
  const seconds = durationMs / 1000
  let bits = 0
  for (const shape of output.shapes) {
    const { width, height } = outputSize(shape, output.resolution)
    if (output.format === 'gif') {
      const scale = GIF_LONG_SIDE / Math.max(width, height)
      bits += width * scale * height * scale * GIF_FPS * GIF_BITS_PER_PIXEL * seconds
    } else {
      // Twice the frames costs far less than twice the bits
      const rate = output.fps === 60 ? 1.4 : 1
      bits += width * height * 30 * MP4_BITS_PER_PIXEL * rate * seconds
    }
  }
  return bits / 8
}

export function formatSize(bytes: number): string {
  const mb = bytes / 1e6
  if (mb < 1) return 'under 1 MB'
  if (mb < 1000) return `about ${Math.round(mb)} MB`
  return `about ${(mb / 1000).toFixed(1)} GB`
}

export function filesLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

export function exportNote(output: OutputSettings, durationMs: Ms): string {
  const count = output.shapes.length
  if (count === 0) return 'Tick a shape to export'
  return `${filesLabel(count)} · ${formatSize(estimateBytes(output, durationMs))}`
}

// One line naming what Free leaves out, or null when nothing is
export function leftOutLine(features: Feature[]): string | null {
  if (features.length === 0) return null
  const names = features.map((f, i) => {
    const label = FEATURE_LABELS[f]
    return i === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
  })
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const verb = features.length === 1 && features[0] !== 'customBackground' && features[0] !== 'captions' ? 'is' : 'are'
  return `${list} ${verb} left out of this export.`
}

export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
}
