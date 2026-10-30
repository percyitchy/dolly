// Plays one video into three canvases. Drawing runs on rAF rather than requestVideoFrameCallback while
// playing, because screen capture only delivers frames when something changes, and the cursor and camera
// must keep moving over a still screen. rVFC says when there's a new frame to upload.
//
// Each draw uploads the frame once per canvas, which is what makes the GPU work hard. So drawing stops at
// 60 Hz however fast the display is, and a view whose frame wouldn't change isn't drawn at all. A view at
// rest shows under half of a Retina clip's pixels, so those draws share one half-size copy. That also spares
// a mipmap rebuild per canvas per frame. Zoomed views need every pixel and get the video itself.

import { compose, type CursorTrack, type FrameSpec } from '../../shared/compose'
import type { Clip, Ms, Project, Shape } from '../../shared/project'
import { createFrameRenderer, type FrameRenderer, type FrameSources } from '../gl'
import { clipIsLive, clipSeconds, needsResync, nudgedRate, projectMs } from './media-sync'

export interface Scene {
  project: Project
  track: CursorTrack
  pro: { webcam: boolean; captions: boolean }
  // Per shape, because wallpapers are painted to the frame they fill. null until an image loads
  background: ((shape: Shape) => TexImageSource) | null
  restShape: Shape | null // Drawn with no zooms, while the focus is being dragged
}

interface View {
  canvas: HTMLCanvasElement
  renderer: FrameRenderer
  drawn: string // The last spec drawn, to tell when the next one would look the same
}

interface Follower {
  el: HTMLMediaElement
  clip: Clip
}

const MAX_DPR = 2
const MIN_DRAW_GAP_MS = 14 // Just under 60 Hz, so a 60 Hz display isn't throttled by timer jitter
const HALF_SIZE_BELOW = 0.5 // Output pixels per clip pixel

function makeVideo(url: string): HTMLVideoElement {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous' // A cross-origin frame can't be uploaded to WebGL without this
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url
  return video
}

export class PreviewEngine {
  private video: HTMLVideoElement
  private followers = new Map<'mic' | 'webcam', Follower>()
  private views = new Map<Shape, View>()
  private listeners = new Set<() => void>()
  private scene: Scene | null = null
  private t: Ms = 0
  private playing = false
  private failed = false
  private raf = 0
  private queuedSeek: number | null = null
  private disposed = false
  private lastDraw = 0
  private newFrame = true
  private half: HTMLCanvasElement | null = null

  constructor(
    private clip: Clip,
    url: string
  ) {
    this.video = makeVideo(url)
    this.video.addEventListener('loadeddata', this.redraw)
    this.video.addEventListener('seeked', this.onSeeked)
    this.video.addEventListener('error', this.onError)
    this.video.load()
    this.watchFrames()
  }

  addFollower(kind: 'mic' | 'webcam', clip: Clip, url: string): void {
    if (this.followers.has(kind)) return
    const el = kind === 'mic' ? new Audio() : makeVideo(url)
    if (kind === 'mic') {
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      el.src = url
    }
    el.addEventListener('seeked', this.redraw)
    el.addEventListener('loadeddata', this.redraw)
    el.load()
    this.followers.set(kind, { el, clip })
    this.syncFollowers(true)
  }

  attach(shape: Shape, canvas: HTMLCanvasElement): () => void {
    const view: View = { canvas, renderer: createFrameRenderer(canvas), drawn: '' }
    this.views.set(shape, view)
    return () => {
      if (this.views.get(shape) === view) this.views.delete(shape)
      view.renderer.dispose()
    }
  }

  resize(shape: Shape, cssWidth: number, cssHeight: number): void {
    const view = this.views.get(shape)
    if (!view) return
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    view.canvas.width = Math.max(1, Math.round(cssWidth * dpr))
    view.canvas.height = Math.max(1, Math.round(cssHeight * dpr))
    view.drawn = '' // Resizing clears the canvas
    this.redraw()
  }

  setScene(scene: Scene): void {
    this.scene = scene
    for (const view of this.views.values()) view.drawn = '' // The wallpaper isn't part of the spec
    if (!this.playing) this.redraw()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getTime = (): Ms => this.t
  getPlaying = (): boolean => this.playing
  getFailed = (): boolean => this.failed

  toggle = (): void => (this.playing ? this.pause() : this.play())

  play(): void {
    if (this.playing || this.failed) return
    if (this.atEnd()) this.seek(0)
    this.playing = true
    this.video.play().catch(() => this.pause())
    this.syncFollowers(true)
    this.raf = requestAnimationFrame(this.tick)
    this.emit()
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    cancelAnimationFrame(this.raf)
    this.video.pause()
    this.syncFollowers(false)
    this.emit()
  }

  seek(t: Ms): void {
    const duration = this.duration()
    this.t = Math.max(0, Math.min(duration, t))
    const seconds = clipSeconds(this.clip, this.t)
    // Scrubbing outruns the decoder, so only the newest target is kept
    if (this.video.seeking) this.queuedSeek = seconds
    else this.seekVideo(seconds)
    this.syncFollowers(true)
    this.redraw()
    this.emit()
  }

  dispose(): void {
    this.disposed = true
    this.pause()
    this.video.removeEventListener('loadeddata', this.redraw)
    this.video.removeEventListener('seeked', this.onSeeked)
    this.video.removeEventListener('error', this.onError)
    this.video.removeAttribute('src')
    this.video.load()
    for (const { el } of this.followers.values()) {
      el.pause()
      el.removeEventListener('seeked', this.redraw)
      el.removeEventListener('loadeddata', this.redraw)
      el.removeAttribute('src')
      el.load()
    }
    this.followers.clear()
    this.listeners.clear()
  }

  private duration(): Ms {
    return this.scene?.project.durationMs ?? this.clip.durationMs
  }

  private atEnd(): boolean {
    return this.video.ended || this.t >= this.duration() - 1
  }

  private seekVideo(seconds: number): void {
    this.video.currentTime = seconds
  }

  private onSeeked = (): void => {
    if (this.queuedSeek !== null) {
      const next = this.queuedSeek
      this.queuedSeek = null
      this.seekVideo(next)
      return
    }
    this.redraw()
  }

  private onError = (): void => {
    this.failed = true
    this.pause()
    this.emit()
  }

  private watchFrames = (): void => {
    if (this.disposed) return
    this.newFrame = true
    this.video.requestVideoFrameCallback(this.watchFrames)
  }

  private tick = (now: number): void => {
    if (!this.playing) return
    if (now - this.lastDraw < MIN_DRAW_GAP_MS) {
      this.raf = requestAnimationFrame(this.tick)
      return
    }
    this.lastDraw = now
    if (!this.video.seeking && this.queuedSeek === null) {
      this.t = projectMs(this.clip, this.video.currentTime, this.duration())
      if (this.atEnd()) {
        this.pause()
        this.redraw()
        return
      }
    }
    this.syncFollowers(false)
    this.draw(false)
    this.emit()
    this.raf = requestAnimationFrame(this.tick)
  }

  private syncFollowers(force: boolean): void {
    for (const { el, clip } of this.followers.values()) {
      const expected = clipSeconds(clip, this.t)
      const live = clipIsLive(clip, this.t)
      if (!this.playing || !live) {
        if (!el.paused) el.pause()
        el.playbackRate = 1
        if (force && !el.seeking) el.currentTime = expected
        continue
      }
      if (force || needsResync(el.currentTime, expected)) el.currentTime = expected
      if (el.paused) el.play().catch(() => {})
      const rate = nudgedRate(el.currentTime - expected)
      if (el.playbackRate !== rate) el.playbackRate = rate
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private redraw = (): void => this.draw(true)

  private screenSource(detail: number, fresh: boolean): TexImageSource {
    const { video } = this
    if (detail > HALF_SIZE_BELOW) return video
    const half = (this.half ??= document.createElement('canvas'))
    const width = video.videoWidth >> 1
    const height = video.videoHeight >> 1
    const resized = half.width !== width || half.height !== height
    if (resized) {
      half.width = width
      half.height = height
    }
    if (fresh || resized) half.getContext('2d', { alpha: false })!.drawImage(video, 0, 0, width, height)
    return half
  }

  private draw(always: boolean): void {
    const { scene, video } = this
    if (this.disposed || !scene?.background || video.readyState < 2) return
    const fresh = always || this.newFrame
    this.newFrame = false
    const webcam = this.followers.get('webcam')?.el as HTMLVideoElement | undefined
    const webcamFrame = webcam && webcam.readyState >= 2 ? webcam : undefined
    const rest = scene.restShape ? { ...scene.project, zooms: [] } : scene.project
    try {
      const specs: { view: View; shape: Shape; spec: FrameSpec }[] = []
      let detail = 0
      for (const [shape, view] of this.views) {
        const { canvas } = view
        if (canvas.clientWidth === 0) continue // A hidden tab
        const size = { width: canvas.width, height: canvas.height }
        const project = shape === scene.restShape ? rest : scene.project
        const spec = compose(project, scene.track, shape, size, this.t, scene.pro)
        detail = Math.max(detail, (spec.screen.w * spec.zoom) / this.clip.width!)
        specs.push({ view, shape, spec })
      }
      const screen = this.screenSource(detail, fresh)
      for (const { view, shape, spec } of specs) {
        const key = JSON.stringify(spec)
        if (!fresh && !webcamFrame && key === view.drawn) continue
        view.drawn = key
        const sources: FrameSources = { screen, background: scene.background(shape), webcam: webcamFrame }
        view.renderer.draw(spec, sources)
      }
    } catch (error) {
      console.error('Preview failed to draw', error)
      this.onError()
    }
  }
}
