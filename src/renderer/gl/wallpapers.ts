// Built-in wallpapers, painted in code. Nothing here touches the disk or the network.

interface Glow {
  x: number // 0 to 1 across the frame
  y: number
  r: number // Radius, as a share of the frame on each axis
  color: string // #RRGGBB, fades to transparent
}

export interface Wallpaper {
  id: string
  name: string
  from: string // Top left of the base gradient
  to: string // Bottom right
  glows: Glow[]
}

export const DEFAULT_WALLPAPER = 'dusk'

export const wallpapers: Wallpaper[] = [
  {
    id: 'dusk',
    name: 'Dusk',
    from: '#2A2F5C',
    to: '#1C2540',
    glows: [
      { x: 0.12, y: 0.18, r: 0.62, color: '#FF8A5B' },
      { x: 0.92, y: 0.85, r: 0.6, color: '#6B5BFF' }
    ]
  },
  {
    id: 'dawn',
    name: 'Dawn',
    from: '#F6C9A8',
    to: '#B9A6E0',
    glows: [
      { x: 0.85, y: 0.1, r: 0.7, color: '#FFE3B0' },
      { x: 0.1, y: 0.95, r: 0.6, color: '#F08FA8' }
    ]
  },
  {
    id: 'ocean',
    name: 'Ocean',
    from: '#0D3B66',
    to: '#071E33',
    glows: [
      { x: 0.2, y: 0.85, r: 0.7, color: '#1FB5C4' },
      { x: 0.9, y: 0.15, r: 0.55, color: '#2D63F5' }
    ]
  },
  {
    id: 'forest',
    name: 'Forest',
    from: '#14342B',
    to: '#0B1F1A',
    glows: [
      { x: 0.15, y: 0.2, r: 0.65, color: '#3F9B6C' },
      { x: 0.88, y: 0.9, r: 0.55, color: '#C9B458' }
    ]
  },
  {
    id: 'ember',
    name: 'Ember',
    from: '#3B1420',
    to: '#1C0B12',
    glows: [
      { x: 0.8, y: 0.2, r: 0.65, color: '#FF5B3A' },
      { x: 0.15, y: 0.9, r: 0.6, color: '#FFB347' }
    ]
  },
  {
    id: 'orchid',
    name: 'Orchid',
    from: '#3A1F5C',
    to: '#1E1238',
    glows: [
      { x: 0.2, y: 0.15, r: 0.6, color: '#E05BD3' },
      { x: 0.85, y: 0.8, r: 0.65, color: '#5B8CFF' }
    ]
  },
  {
    id: 'slate',
    name: 'Slate',
    from: '#39414F',
    to: '#1B1F27',
    glows: [{ x: 0.5, y: 0.0, r: 0.8, color: '#6C7A91' }]
  },
  {
    id: 'paper',
    name: 'Paper',
    from: '#F5F6F8',
    to: '#DDE1E8',
    glows: [
      { x: 0.1, y: 0.1, r: 0.6, color: '#FFFFFF' },
      { x: 0.95, y: 0.95, r: 0.55, color: '#C7D2E5' }
    ]
  }
]

export function wallpaperById(id: string): Wallpaper {
  return wallpapers.find((w) => w.id === id) ?? wallpapers[0]
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// Glows are ellipses that stretch with the frame, like the objectBoundingBox gradients in recording.svg
function paint(ctx: Context2D, wallpaper: Wallpaper, width: number, height: number): void {
  ctx.save()
  ctx.scale(width, height)
  const base = ctx.createLinearGradient(0, 0, 1, 1)
  base.addColorStop(0, wallpaper.from)
  base.addColorStop(1, wallpaper.to)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, 1, 1)
  for (const glow of wallpaper.glows) {
    const g = ctx.createRadialGradient(glow.x, glow.y, 0, glow.x, glow.y, glow.r)
    g.addColorStop(0, glow.color)
    g.addColorStop(1, `${glow.color}00`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 1, 1)
  }
  ctx.restore()
}

// Works in a window and in a worker
export function renderWallpaper(id: string, width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height })
  const ctx = canvas.getContext('2d') as Context2D | null
  if (!ctx) throw new Error('2D canvas is not available')
  paint(ctx, wallpaperById(id), width, height)
  return canvas
}

// For swatches in the UI. Same colours as renderWallpaper, top layer first
export function wallpaperCss(id: string): string {
  const w = wallpaperById(id)
  const glows = [...w.glows]
    .reverse()
    .map((g) => {
      const r = `${g.r * 100}%`
      return `radial-gradient(ellipse ${r} ${r} at ${g.x * 100}% ${g.y * 100}%, ${g.color}, ${g.color}00)`
    })
  return [...glows, `linear-gradient(to bottom right, ${w.from}, ${w.to})`].join(', ')
}
