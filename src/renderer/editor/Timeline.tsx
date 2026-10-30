import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { ClickPoint } from '../../shared/compose'
import type { Caption, Clip, Project, ZoomSegment } from '../../shared/project'
import { ProBadge, useAccess } from '../home/plan'
import { withZooms, type EditorAction } from './editor-state'
import { peaksOf, peaksToPath } from './media-sync'
import type { PreviewEngine } from './preview-engine'
import {
  blockLabel,
  canAddZoom,
  formatTimecode,
  moveBlock,
  msFromX,
  pct,
  rulerTicks,
  stretchEnd,
  stretchStart,
  zoomSummary
} from './timeline-model'

interface TimelineProps {
  engine: PreviewEngine
  project: Project
  dir: string
  clicks: ClickPoint[]
  selectedId: string | null
  dispatch: Dispatch<EditorAction>
  onSelectBlock(id: string): void
  onSelectCaption(id: string): void
  onAddZoom(): void
}

type DragMode = 'move' | 'start' | 'end'

interface Drag {
  id: string
  mode: DragMode
  x: number
  base: ZoomSegment[]
  startMs: number
  endMs: number
  width: number
  moved: boolean
}

const DRAG_SLOP_PX = 3

export function Timeline({ engine, project, dir, clicks, selectedId, dispatch, onSelectBlock, onSelectCaption, onAddZoom }: TimelineProps) {
  const { durationMs } = project
  const lanes = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const drag = useRef<Drag | null>(null)
  const scrubbing = useRef(false)
  const screen = project.clips.find((c) => c.kind === 'screen')
  const mic = project.clips.find((c) => c.kind === 'mic')

  useLayoutEffect(() => {
    const el = lanes.current!
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const ticks = useMemo(() => rulerTicks(durationMs, width), [durationMs, width])

  const seekTo = (clientX: number) => {
    const box = lanes.current!.getBoundingClientRect()
    engine.seek(msFromX(clientX - box.left, box.width, durationMs))
  }

  const scrubDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('.block, .cap-block, .lane-lock')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubbing.current = true
    engine.pause()
    seekTo(e.clientX)
    if ((e.target as HTMLElement).closest('.zoom-lane')) dispatch({ type: 'select', id: null })
  }

  const blockDown = (e: ReactPointerEvent, seg: ZoomSegment, mode: DragMode) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      id: seg.id,
      mode,
      x: e.clientX,
      base: project.zooms,
      startMs: seg.startMs,
      endMs: seg.endMs,
      width: lanes.current!.clientWidth,
      moved: false
    }
  }

  const blockMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    e.stopPropagation() // The edges sit inside the block, so this would run twice
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) < DRAG_SLOP_PX) return
    if (!d.moved) {
      d.moved = true
      dispatch({ type: 'gesture-start' })
    }
    const dms = (dx / d.width) * durationMs
    const zooms =
      d.mode === 'move'
        ? moveBlock(d.base, d.id, d.startMs + dms, durationMs)
        : d.mode === 'start'
          ? stretchStart(d.base, d.id, d.startMs + dms, durationMs)
          : stretchEnd(d.base, d.id, d.endMs + dms, durationMs)
    dispatch({ type: 'edit', change: (p) => withZooms(p, zooms) })
  }

  const blockUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) dispatch({ type: 'gesture-end' })
    onSelectBlock(d.id)
  }

  const blockEvents = (seg: ZoomSegment, mode: DragMode) => ({
    onPointerDown: (e: ReactPointerEvent) => blockDown(e, seg, mode),
    onPointerMove: blockMove,
    onPointerUp: blockUp,
    onPointerCancel: blockUp
  })

  return (
    <section className="tl" aria-label="Timeline">
      <div className="tl-top">
        <PlayButton engine={engine} />
        <Timecode engine={engine} project={project} fps={screen?.fps ?? 60} />
        <span className="grow" />
        <span>{zoomSummary(project.zooms.length, clicks.length)}</span>
        <AddZoom engine={engine} project={project} onAdd={onAddZoom} />
      </div>
      <div className="tracks">
        <div className="lane-labels" aria-hidden="true">
          <span className="for-ruler" />
          <span className="for-clicks">Clicks</span>
          <span className="for-zoom">Zoom</span>
          <span className="for-screen">Screen</span>
          <span className="for-mic">Mic</span>
          <span className="for-captions">Captions</span>
        </div>
        <div
          className="lanes"
          ref={lanes}
          onPointerDown={scrubDown}
          onPointerMove={(e) => scrubbing.current && seekTo(e.clientX)}
          onPointerUp={() => (scrubbing.current = false)}
          onPointerCancel={() => (scrubbing.current = false)}
        >
          <div className="ruler" style={{ '--tick': pct((ticks[1]?.ms ?? durationMs) / 5, durationMs) } as CSSProperties}>
            {ticks.map((tick) => (
              <span key={tick.ms} style={{ left: pct(tick.ms, durationMs) }}>
                {tick.label}
              </span>
            ))}
          </div>
          <div className="lane clicks-lane">
            {clicks.map((c) => (
              <i key={c.t} className="tick" style={{ left: pct(c.t, durationMs) }} />
            ))}
          </div>
          <div className="lane zoom-lane">
            {project.zooms.map((seg) => (
              <div
                key={seg.id}
                className={seg.id === selectedId ? 'block sel' : 'block'}
                style={{ left: pct(seg.startMs, durationMs), width: pct(seg.endMs - seg.startMs, durationMs) }}
                role="button"
                tabIndex={0}
                aria-label={`Zoom block, ${blockLabel(seg)}`}
                aria-pressed={seg.id === selectedId}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectBlock(seg.id)}
                {...blockEvents(seg, 'move')}
              >
                <span className="block-label">{blockLabel(seg)}</span>
                <i className="edge l" {...blockEvents(seg, 'start')} />
                <i className="edge r" {...blockEvents(seg, 'end')} />
              </div>
            ))}
          </div>
          <div className="lane screen-lane">{screen && <FilmStrip dir={dir} clip={screen} width={width} />}</div>
          <div className="lane mic-lane">{mic ? <Waveform dir={dir} clip={mic} durationMs={durationMs} /> : <span className="lane-note">No mic</span>}</div>
          <CaptionsLane captions={project.captions} durationMs={durationMs} onSelect={onSelectCaption} />
          <Playhead engine={engine} durationMs={durationMs} />
        </div>
      </div>
    </section>
  )
}

function PlayButton({ engine }: { engine: PreviewEngine }) {
  const playing = useSyncExternalStore(engine.subscribe, engine.getPlaying)
  return (
    <button type="button" className={playing ? 'play on' : 'play'} aria-label={playing ? 'Pause' : 'Play'} onClick={engine.toggle}>
      {playing ? <i className="pause-icon" /> : '▶'}
    </button>
  )
}

function Timecode({ engine, project, fps }: { engine: PreviewEngine; project: Project; fps: number }) {
  const t = useSyncExternalStore(engine.subscribe, engine.getTime)
  return (
    <span className="tc">
      {formatTimecode(t, fps)} <small>/ {formatTimecode(project.durationMs, fps)}</small>
    </span>
  )
}

function AddZoom({ engine, project, onAdd }: { engine: PreviewEngine; project: Project; onAdd(): void }) {
  const can = useSyncExternalStore(engine.subscribe, () => canAddZoom(project.zooms, engine.getTime(), project.durationMs))
  return (
    <button type="button" className="ghost small" disabled={!can} title={can ? undefined : 'No room at the playhead'} onClick={onAdd}>
      + Add zoom
    </button>
  )
}

function Playhead({ engine, durationMs }: { engine: PreviewEngine; durationMs: number }) {
  const t = useSyncExternalStore(engine.subscribe, engine.getTime)
  return <i className="playhead" style={{ left: pct(t, durationMs) }} />
}

function CaptionsLane({ captions, durationMs, onSelect }: { captions: Caption[]; durationMs: number; onSelect(id: string): void }) {
  const { can, upgrade } = useAccess()
  const locked = !can('captions')
  return (
    <div className={locked ? 'lane captions-lane locked' : 'lane captions-lane'}>
      {captions.map((c) => (
        <button
          key={c.id}
          type="button"
          className="cap-block"
          style={{ left: pct(c.startMs, durationMs), width: pct(c.endMs - c.startMs, durationMs) }}
          onClick={() => (locked ? upgrade('captions') : onSelect(c.id))}
        >
          {c.text}
        </button>
      ))}
      {locked && captions.length === 0 && (
        <button type="button" className="lane-lock" onClick={() => upgrade('captions')}>
          <ProBadge feature="captions" />
        </button>
      )}
    </div>
  )
}

const THUMB_ASPECT = 16 / 9
const MAX_THUMBS = 24

function FilmStrip({ dir, clip, width }: { dir: string; clip: Clip; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const count = Math.min(MAX_THUMBS, Math.max(1, Math.ceil(width / (26 * THUMB_ASPECT))))

  useEffect(() => {
    const el = canvas.current!
    const ctx = el.getContext('2d')
    if (!ctx) return
    const thumbW = 96
    const thumbH = Math.round(thumbW / THUMB_ASPECT)
    el.width = thumbW * count
    el.height = thumbH
    let i = 0
    let stopped = false
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    const next = () => {
      if (stopped || i >= count) return
      video.currentTime = (((i + 0.5) / count) * clip.durationMs) / 1000
    }
    const drawn = () => {
      if (stopped) return
      ctx.drawImage(video, i * thumbW, 0, thumbW, thumbH)
      i++
      next()
    }
    video.addEventListener('loadeddata', next, { once: true })
    video.addEventListener('seeked', drawn)
    window.dolly.projects.mediaUrl(dir, clip.file).then(
      (url) => {
        if (stopped) return
        video.src = url
        video.load()
      },
      () => {}
    )
    return () => {
      stopped = true
      video.removeEventListener('seeked', drawn)
      video.removeAttribute('src')
      video.load()
    }
  }, [dir, clip.file, clip.durationMs, count])

  return <canvas ref={canvas} className="film" aria-hidden="true" />
}

const WAVE_BUCKETS = 800

function Waveform({ dir, clip, durationMs }: { dir: string; clip: Clip; durationMs: number }) {
  const [path, setPath] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      const url = await window.dolly.projects.mediaUrl(dir, clip.file)
      const data = await (await fetch(url)).arrayBuffer()
      const audio = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(data)
      if (alive) setPath(peaksToPath(peaksOf(audio.getChannelData(0), WAVE_BUCKETS)))
    }
    load().catch(() => {}) // A missing waveform shouldn't stop the editor
    return () => {
      alive = false
    }
  }, [dir, clip.file])

  return (
    <svg
      className="wave"
      viewBox={`0 0 ${WAVE_BUCKETS} 48`}
      preserveAspectRatio="none"
      style={{ left: pct(clip.startMs, durationMs), width: pct(clip.durationMs, durationMs) }}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}
