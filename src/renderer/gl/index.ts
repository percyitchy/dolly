// Draws one FrameSpec. The editor preview and the export window both use this, so they can't differ.

import type { FrameSpec } from '../../shared/compose'
import { CURSOR, IMAGE, RIPPLE, SCENE, VERTEX, WEBCAM } from './shaders'

export { DEFAULT_WALLPAPER, renderWallpaper, wallpaperCss, wallpapers } from './wallpapers'
export type { Wallpaper } from './wallpapers'

// Raw planes, as the export pipeline gets them from ffmpeg. Y then U then V, tightly packed, limited range
export interface YuvFrame {
  format: 'yuv420p'
  width: number
  height: number
  data: Uint8Array
  matrix?: 'bt709' | 'bt601' // Default bt709
}

export interface FrameSources {
  screen: TexImageSource | YuvFrame
  background: TexImageSource
  webcam?: TexImageSource | YuvFrame
}

export interface FrameRendererOptions {
  // Draw upside down, so readPixels gives rows top first. Only for canvases nobody looks at
  flipY?: boolean
}

export interface FrameRenderer {
  draw(spec: FrameSpec, sources: FrameSources): void
  // RGBA of the last draw. Call in the same task as draw. out needs width * height * 4 bytes
  readPixels(out: Uint8Array): void
  dispose(): void
}

const CURSOR_UNIT = 3 // Clip pixels per unit of the arrow shape. The arrow is 16 units tall
const SUPERSAMPLE_FROM = 1.05 // Texels per output pixel where one sample starts to miss detail
const MIPMAP_FROM = 2

const COEF = {
  bt709: [1.5748, 0.1873, 0.4681, 1.8556],
  bt601: [1.402, 0.34414, 0.71414, 1.772]
} as const

type GL = WebGL2RenderingContext

function isYuv(source: TexImageSource | YuvFrame): source is YuvFrame {
  return (source as YuvFrame).format === 'yuv420p'
}

function sourceSize(source: TexImageSource | YuvFrame): { width: number; height: number } {
  if (isYuv(source)) return source
  if ('videoWidth' in source) return { width: source.videoWidth, height: source.videoHeight }
  if ('naturalWidth' in source) return { width: source.naturalWidth, height: source.naturalHeight }
  if ('displayWidth' in source) return { width: source.displayWidth, height: source.displayHeight }
  return source as { width: number; height: number }
}

class Program {
  readonly handle: WebGLProgram
  private uniforms = new Map<string, WebGLUniformLocation | null>()

  constructor(
    private gl: GL,
    fragment: string
  ) {
    const handle = gl.createProgram()
    gl.attachShader(handle, compile(gl, gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(handle, compile(gl, gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(handle)
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(handle)}`)
    }
    this.handle = handle
  }

  at(name: string): WebGLUniformLocation | null {
    let location = this.uniforms.get(name)
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.handle, name)
      this.uniforms.set(name, location)
    }
    return location
  }
}

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Could not create a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

function createTexture(gl: GL): WebGLTexture {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

// One image source on four texture units in a row: rgb, y, u, v
class Slot {
  private textures: WebGLTexture[]
  private planeSize = [
    [0, 0],
    [0, 0],
    [0, 0]
  ]
  private last: Uint8Array | null = null
  private mips = false
  yuv = false
  width = 0
  height = 0
  coef: readonly number[] = COEF.bt709

  constructor(
    private gl: GL,
    private unit: number
  ) {
    this.textures = [0, 1, 2, 3].map(() => createTexture(gl))
  }

  update(source: TexImageSource | YuvFrame, mipmap: boolean): void {
    const { gl } = this
    const size = sourceSize(source)
    this.width = size.width
    this.height = size.height
    const planes: number[] = []
    if (isYuv(source)) {
      this.yuv = true
      this.coef = COEF[source.matrix ?? 'bt709']
      if (source.data !== this.last || (mipmap && !this.mips)) {
        this.uploadPlanes(source, mipmap)
        this.last = source.data
        this.mips = mipmap
      }
      planes.push(1, 2, 3)
    } else {
      this.yuv = false
      this.last = null
      if (size.width > 0 && size.height > 0) {
        gl.activeTexture(gl.TEXTURE0 + this.unit)
        gl.bindTexture(gl.TEXTURE_2D, this.textures[0])
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
        if (mipmap) gl.generateMipmap(gl.TEXTURE_2D)
      }
      planes.push(0)
    }
    for (const plane of planes) {
      gl.activeTexture(gl.TEXTURE0 + this.unit + plane)
      gl.bindTexture(gl.TEXTURE_2D, this.textures[plane])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    }
  }

  private uploadPlanes(frame: YuvFrame, mipmap: boolean): void {
    const { gl } = this
    const { width: w, height: h, data } = frame
    const cw = (w + 1) >> 1
    const ch = (h + 1) >> 1
    const sizes = [
      [w, h, 0],
      [cw, ch, w * h],
      [cw, ch, w * h + cw * ch]
    ]
    sizes.forEach(([pw, ph, offset], i) => {
      gl.activeTexture(gl.TEXTURE0 + this.unit + i + 1)
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i + 1])
      const plane = data.subarray(offset, offset + pw * ph)
      if (this.planeSize[i][0] === pw && this.planeSize[i][1] === ph) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, gl.RED, gl.UNSIGNED_BYTE, plane)
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, plane)
        this.planeSize[i] = [pw, ph]
      }
      if (mipmap) gl.generateMipmap(gl.TEXTURE_2D)
    })
  }

  bind(program: Program): void {
    const { gl, unit } = this
    gl.uniform1i(program.at('uRgb'), unit)
    gl.uniform1i(program.at('uY'), unit + 1)
    gl.uniform1i(program.at('uU'), unit + 2)
    gl.uniform1i(program.at('uV'), unit + 3)
    gl.uniform1i(program.at('uIsYuv'), this.yuv ? 1 : 0)
    gl.uniform4fv(program.at('uCoef'), this.coef)
    gl.uniform1f(program.at('uChromaShift'), this.width > 0 ? 0.5 / this.width : 0)
  }

  dispose(): void {
    this.textures.forEach((t) => this.gl.deleteTexture(t))
  }
}

interface CaptionTexture {
  key: string
  width: number
  height: number
}

type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function wrapLines(ctx: Context2D, text: string, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > max) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

function paintCaption(text: string, outW: number, outH: number) {
  const fontSize = Math.round(Math.min(outW, outH) * 0.042)
  const font = `600 ${fontSize}px -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : Object.assign(document.createElement('canvas'), { width: 1, height: 1 })
  const ctx = canvas.getContext('2d') as Context2D | null
  if (!ctx) throw new Error('2D canvas is not available')
  const padX = fontSize * 0.8
  const padY = fontSize * 0.45
  const lineHeight = fontSize * 1.3
  ctx.font = font
  const lines = wrapLines(ctx, text, outW * 0.86 - padX * 2)
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width))
  const width = Math.ceil(textW + padX * 2)
  const height = Math.ceil(lines.length * lineHeight + padY * 2)
  canvas.width = width
  canvas.height = height
  ctx.font = font // Resizing a canvas resets its state
  ctx.fillStyle = 'rgba(12, 14, 18, 0.78)'
  ctx.beginPath()
  ctx.roundRect(0, 0, width, height, fontSize * 0.5)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  lines.forEach((line, i) => ctx.fillText(line, width / 2, padY + lineHeight * (i + 0.5)))
  return { canvas, width, height }
}

const UNIT_SCREEN = 0
const UNIT_WEBCAM = 4
const UNIT_BG = 8
const UNIT_CAPTION = 9

class Scene {
  private scene: Program
  private cursor: Program
  private ripple: Program
  private webcam: Program
  private image: Program
  private vao: WebGLVertexArrayObject
  private screenSlot: Slot
  private webcamSlot: Slot
  private bgTexture: WebGLTexture
  private captionTexture: WebGLTexture
  private bgSource: TexImageSource | null = null
  private bgSize = { width: 1, height: 1 }
  private caption: CaptionTexture | null = null

  constructor(
    private gl: GL,
    private flip: number
  ) {
    this.scene = new Program(gl, SCENE)
    this.cursor = new Program(gl, CURSOR)
    this.ripple = new Program(gl, RIPPLE)
    this.webcam = new Program(gl, WEBCAM)
    this.image = new Program(gl, IMAGE)
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    this.screenSlot = new Slot(gl, UNIT_SCREEN)
    this.webcamSlot = new Slot(gl, UNIT_WEBCAM)
    gl.activeTexture(gl.TEXTURE0 + UNIT_BG)
    this.bgTexture = createTexture(gl)
    gl.activeTexture(gl.TEXTURE0 + UNIT_CAPTION)
    this.captionTexture = createTexture(gl)
  }

  private quad(program: Program, x: number, y: number, w: number, h: number, outW: number, outH: number): void {
    const { gl } = this
    gl.uniform4f(program.at('uRect'), x, y, w, h)
    gl.uniform2f(program.at('uOut'), outW, outH)
    gl.uniform1f(program.at('uFlip'), this.flip)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  draw(spec: FrameSpec, sources: FrameSources): void {
    const { gl } = this
    const { width: W, height: H, camera: cam } = spec
    gl.viewport(0, 0, W, H)
    this.drawScene(spec, sources)

    gl.enable(gl.BLEND)
    const toOutX = (x: number) => ((x - cam.x) * W) / cam.w
    const toOutY = (y: number) => ((y - cam.y) * H) / cam.h
    const unit = (spec.cursor?.scale ?? 1) * CURSOR_UNIT * (W / cam.w)

    if (spec.ripple) {
      const x = toOutX(spec.ripple.x)
      const y = toOutY(spec.ripple.y)
      const p = spec.ripple.progress
      const eased = 1 - Math.pow(1 - p, 3)
      const ring = unit * (5 + 12 * eased)
      const m = ring + unit * 2
      gl.useProgram(this.ripple.handle)
      gl.uniform2f(this.ripple.at('uCenter'), x, y)
      gl.uniform1f(this.ripple.at('uRing'), ring)
      gl.uniform1f(this.ripple.at('uWidth'), Math.max(1, unit * 1.5))
      gl.uniform1f(this.ripple.at('uFade'), 1 - p)
      this.quad(this.ripple, x - m, y - m, m * 2, m * 2, W, H)
    }

    if (spec.cursor) {
      const x = toOutX(spec.cursor.x)
      const y = toOutY(spec.cursor.y)
      gl.useProgram(this.cursor.handle)
      gl.uniform2f(this.cursor.at('uTip'), x, y)
      gl.uniform1f(this.cursor.at('uUnit'), unit)
      this.quad(this.cursor, x - unit * 3, y - unit * 3, unit * 21, unit * 21, W, H)
    }

    if (spec.webcam && sources.webcam) this.drawWebcam(spec, sources.webcam)
    if (spec.caption) this.drawCaption(spec, spec.caption)
    gl.disable(gl.BLEND)
  }

  private drawScene(spec: FrameSpec, sources: FrameSources): void {
    const { gl } = this
    const { width: W, height: H, camera: cam, screen } = spec
    const clip = sourceSize(sources.screen)
    const minify = clip.width > 0 ? (clip.width / screen.w) * (cam.w / W) : 1
    this.screenSlot.update(sources.screen, minify > MIPMAP_FROM)
    this.updateBackground(sources.background)

    const p = this.scene
    gl.useProgram(p.handle)
    this.screenSlot.bind(p)
    gl.uniform1i(p.at('uBg'), UNIT_BG)
    gl.uniform4f(p.at('uCam'), cam.x, cam.y, cam.w, cam.h)
    gl.uniform4f(p.at('uScreen'), screen.x, screen.y, screen.w, screen.h)
    gl.uniform1f(p.at('uRadius'), spec.radius)
    gl.uniform1f(p.at('uShadow'), spec.shadow)
    // Cover: the image fills the canvas and overflows evenly
    const bg = this.bgSize
    const cover = Math.max(W / bg.width, H / bg.height)
    const scaleX = 1 / (bg.width * cover)
    const scaleY = 1 / (bg.height * cover)
    gl.uniform4f(p.at('uBgMap'), 0.5 - (W / 2) * scaleX, 0.5 - (H / 2) * scaleY, scaleX, scaleY)
    const pixel = cam.w / W
    gl.uniform2f(p.at('uStep'), pixel / screen.w, pixel / screen.h)
    gl.uniform1i(p.at('uSuper'), minify > SUPERSAMPLE_FROM ? 1 : 0)
    this.quad(p, 0, 0, W, H, W, H)
  }

  private updateBackground(source: TexImageSource): void {
    if (source === this.bgSource) return
    const { gl } = this
    const size = sourceSize(source)
    if (size.width === 0 || size.height === 0) return
    gl.activeTexture(gl.TEXTURE0 + UNIT_BG)
    gl.bindTexture(gl.TEXTURE_2D, this.bgTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    this.bgSource = source
    this.bgSize = size
  }

  private drawWebcam(spec: FrameSpec, source: TexImageSource | YuvFrame): void {
    const { gl } = this
    const bubble = spec.webcam!
    const { rect } = bubble
    this.webcamSlot.update(source, false)
    const { width, height } = this.webcamSlot
    if (width === 0 || height === 0) return
    const p = this.webcam
    const aspect = width / height
    gl.useProgram(p.handle)
    this.webcamSlot.bind(p)
    gl.uniform4f(p.at('uBox'), rect.x, rect.y, rect.w, rect.h)
    gl.uniform1f(p.at('uRadius'), bubble.shape === 'circle' ? rect.w / 2 : rect.w * 0.18)
    gl.uniform2f(p.at('uCrop'), aspect > 1 ? 1 / aspect : 1, aspect > 1 ? 1 : aspect)
    const m = rect.w * 0.14
    this.quad(p, rect.x - m, rect.y - m, rect.w + m * 2, rect.h + m * 2, spec.width, spec.height)
  }

  private drawCaption(spec: FrameSpec, text: string): void {
    const { gl } = this
    const { width: W, height: H } = spec
    const key = `${W}x${H}:${text}`
    if (this.caption?.key !== key) {
      const painted = paintCaption(text, W, H)
      gl.activeTexture(gl.TEXTURE0 + UNIT_CAPTION)
      gl.bindTexture(gl.TEXTURE_2D, this.captionTexture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, painted.canvas)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      this.caption = { key, width: painted.width, height: painted.height }
    }
    const { width, height } = this.caption
    const x = Math.round((W - width) / 2)
    let y = Math.round(H - height - H * 0.07)
    // A bubble in a bottom corner pushes the caption up instead of being covered by it
    const bubble = spec.webcam?.rect
    if (bubble && bubble.y < y + height && bubble.y + bubble.h > y && bubble.x < x + width && bubble.x + bubble.w > x) {
      y = Math.round(bubble.y - height - H * 0.015)
    }
    const p = this.image
    gl.useProgram(p.handle)
    gl.uniform1i(p.at('uImage'), UNIT_CAPTION)
    gl.uniform4f(p.at('uBox'), x, y, width, height)
    this.quad(p, x, y, width, height, W, H)
  }

  dispose(): void {
    const { gl } = this
    this.screenSlot.dispose()
    this.webcamSlot.dispose()
    gl.deleteTexture(this.bgTexture)
    gl.deleteTexture(this.captionTexture)
    gl.deleteVertexArray(this.vao)
    for (const p of [this.scene, this.cursor, this.ripple, this.webcam, this.image]) gl.deleteProgram(p.handle)
  }
}

export function createFrameRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: FrameRendererOptions = {}
): FrameRenderer {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance'
  }) as GL | null
  if (!gl) throw new Error('WebGL2 is not available')
  const flip = options.flipY ? -1 : 1
  let scene: Scene | null = new Scene(gl, flip)

  const onLost = (event: Event) => {
    event.preventDefault()
    scene = null
  }
  const onRestored = () => {
    scene = new Scene(gl, flip)
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    draw(spec, sources) {
      if (!scene) return
      if (canvas.width !== spec.width) canvas.width = spec.width
      if (canvas.height !== spec.height) canvas.height = spec.height
      scene.draw(spec, sources)
    },
    readPixels(out) {
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out)
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      scene?.dispose()
      scene = null
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}
