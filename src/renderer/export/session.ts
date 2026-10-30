// Runs in the hidden export window: takes a frame from main, draws it, sends the pixels back.

import { createFrameRenderer, type FrameRenderer } from '../gl'
import { renderWallpaper } from '../gl/wallpapers'
import type { ExportBackground, FromWindow, RawPlanes, ToWindow } from './protocol'

async function loadBackground(background: ExportBackground, width: number, height: number): Promise<TexImageSource> {
  if (background.kind === 'wallpaper') return renderWallpaper(background.id, width, height)
  return createImageBitmap(new Blob([background.bytes as Uint8Array<ArrayBuffer>]))
}

export function attachExportPort(port: MessagePort): void {
  const send = (message: FromWindow) => port.postMessage(message)
  let renderer: FrameRenderer | null = null
  let current: OffscreenCanvas | null = null
  let background: TexImageSource | null = null
  let screen: RawPlanes | null = null
  let webcam: RawPlanes | null = null
  let pixels = new Uint8Array(0)

  const fail = (error: unknown) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) })

  async function begin(m: Extract<ToWindow, { type: 'begin' }>): Promise<void> {
    renderer?.dispose() // Loses the old context on purpose, so only the current canvas counts
    const canvas = new OffscreenCanvas(m.width, m.height)
    current = canvas
    canvas.addEventListener('webglcontextlost', () => {
      if (current === canvas) fail(new Error('The graphics context was lost'))
    })
    renderer = createFrameRenderer(canvas, { flipY: true })
    background = await loadBackground(m.background, m.width, m.height)
    screen = null
    webcam = null
    pixels = new Uint8Array(m.width * m.height * 4)
    send({ type: 'ready', job: m.job })
  }

  function frame(m: Extract<ToWindow, { type: 'frame' }>): void {
    if (m.screen) screen = m.screen
    if (m.webcam) webcam = m.webcam
    if (!renderer || !background || !screen) throw new Error('Frame arrived before its source')
    renderer.draw(m.spec, { screen, background, webcam: webcam ?? undefined })
    renderer.readPixels(pixels)
    send({ type: 'rendered', job: m.job, n: m.n, pixels })
  }

  port.onmessage = (event: MessageEvent<ToWindow>) => {
    try {
      if (event.data.type === 'begin') begin(event.data).catch(fail)
      else frame(event.data)
    } catch (error) {
      fail(error)
    }
  }
  port.start()
}
