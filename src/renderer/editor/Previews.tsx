import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type PointerEvent as ReactPointerEvent } from 'react'
import { aimAt, cameraAt, compose, restRect, zoomAmount, type CursorTrack } from '../../shared/compose'
import { shapeFeature } from '../../shared/entitlements'
import type { Project, Shape, ZoomSegment } from '../../shared/project'
import { ProBadge, useAccess } from '../home/plan'
import { withZooms, type EditorAction } from './editor-state'
import { SHAPE_INFO } from './export-model'
import type { PreviewEngine } from './preview-engine'
import { fullZoomMs, updateBlock } from './timeline-model'

const NARROW = '(max-width: 1099px)'
const CLASS: Record<Shape, string> = { '16:9': 'a', '1:1': 'b', '9:16': 'c' }
const NO_PRO = { webcam: false, captions: false }

// A size for maths only. Everything here comes back as a fraction of the frame
const UNIT = { width: 1600, height: 900 }

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches)
  useEffect(() => {
    const query = window.matchMedia(NARROW)
    const update = () => setNarrow(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return narrow
}

interface PreviewsProps {
  engine: PreviewEngine
  project: Project
  track: CursorTrack
  shapes: Shape[]
  focusBlock: ZoomSegment | null
  focusDrag: boolean
  onFocusDrag(active: boolean): void
  dispatch: Dispatch<EditorAction>
  onShapeToggle(shape: Shape): void
}

export function Previews({ engine, project, track, shapes, focusBlock, focusDrag, onFocusDrag, dispatch, onShapeToggle }: PreviewsProps) {
  const narrow = useNarrow()
  const [tab, setTab] = useState<Shape>('16:9')
  const failed = useSyncExternalStore(engine.subscribe, engine.getFailed)
  return (
    <main className={narrow ? 'formats tabbed' : 'formats'}>
      {narrow && (
        <div className="tabs" role="tablist" aria-label="Formats">
          {SHAPE_INFO.map(({ shape, name }) => (
            <button key={shape} type="button" role="tab" aria-selected={tab === shape} className={tab === shape ? 'on' : undefined} onClick={() => setTab(shape)}>
              {name}
            </button>
          ))}
        </div>
      )}
      {SHAPE_INFO.map((info) => (
        <Format
          key={info.shape}
          {...info}
          hidden={narrow && tab !== info.shape}
          ticked={shapes.includes(info.shape)}
          engine={engine}
          onToggle={() => onShapeToggle(info.shape)}
        >
          {info.shape === '16:9' && <ZoomTag engine={engine} project={project} track={track} />}
          {info.shape === '16:9' && focusBlock && (
            <FocusHandle
              engine={engine}
              project={project}
              track={track}
              seg={focusBlock}
              dragging={focusDrag}
              onDragging={onFocusDrag}
              dispatch={dispatch}
            />
          )}
        </Format>
      ))}
      {failed && <p className="preview-error">Couldn't load this recording.</p>}
    </main>
  )
}

interface FormatProps {
  shape: Shape
  name: string
  hint: string
  hidden: boolean
  ticked: boolean
  engine: PreviewEngine
  onToggle(): void
  children?: React.ReactNode
}

function Format({ shape, name, hint, hidden, ticked, engine, onToggle, children }: FormatProps) {
  const { can, upgrade } = useAccess()
  const feature = shapeFeature(shape)
  const locked = !!feature && !can(feature)
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current!
    const detach = engine.attach(shape, el)
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) engine.resize(shape, width, height)
    })
    observer.observe(frame.current!)
    return () => {
      observer.disconnect()
      detach()
    }
  }, [engine, shape])

  return (
    <section className={`fmt ${CLASS[shape]}${locked ? ' locked' : ''}`} hidden={hidden}>
      <header>
        <button
          type="button"
          role="checkbox"
          aria-checked={ticked && !locked}
          aria-label={locked ? `Add ${name}` : `Export ${name}`}
          className={ticked && !locked ? 'check on' : 'check'}
          onClick={locked ? () => upgrade(feature!) : onToggle}
        />
        <b>{name}</b>
        <span>{hint}</span>
        {feature && <ProBadge feature={feature} />}
      </header>
      <div className="frame" ref={frame}>
        <canvas ref={canvas} aria-label={`${name} preview`} />
        {children}
        {locked && (
          <button type="button" className="unlock" onClick={() => upgrade(feature!)}>
            Preview only
          </button>
        )}
      </div>
    </section>
  )
}

function ZoomTag({ engine, project, track }: { engine: PreviewEngine; project: Project; track: CursorTrack }) {
  const clip = project.clips.find((c) => c.kind === 'screen')
  const level = useSyncExternalStore(engine.subscribe, () => {
    const t = engine.getTime()
    const { k, seg } = zoomAmount(project.zooms, t)
    if (k <= 0.02 || !seg || !clip?.width || !clip.height) return 0
    return aimAt(project.zooms, seg, track, clip.width, clip.height, t).level // Mid-pan it's between two levels
  })
  return level ? <span className="zoomtag">{level.toFixed(1)}×</span> : null
}

interface FocusHandleProps {
  engine: PreviewEngine
  project: Project
  track: CursorTrack
  seg: ZoomSegment
  dragging: boolean
  onDragging(active: boolean): void
  dispatch: Dispatch<EditorAction>
}

// While dragging, the landscape preview pulls back to the whole frame and shows what the zoom will
// frame, because the point under the pointer would otherwise slide away as the camera moved
function FocusHandle({ engine, project, track, seg, dragging, onDragging, dispatch }: FocusHandleProps) {
  const t = useSyncExternalStore(engine.subscribe, engine.getTime)
  const overlay = useRef<HTMLDivElement>(null)
  const clip = project.clips.find((c) => c.kind === 'screen')
  if (!clip?.width || !clip.height) return null

  const rest = restRect(UNIT.width, UNIT.height, clip.width, clip.height, project.look.paddingPct)
  const camera = dragging ? { x: 0, y: 0, w: UNIT.width, h: UNIT.height } : compose(project, track, '16:9', UNIT, t, NO_PRO).camera
  const left = (rest.x + seg.focus.x * rest.w - camera.x) / camera.w
  const top = (rest.y + seg.focus.y * rest.h - camera.y) / camera.h
  const framed = cameraAt(UNIT.width, UNIT.height, rest, seg.level, 1, seg.focus).rect

  const move = (e: ReactPointerEvent) => {
    const box = overlay.current!.getBoundingClientRect()
    const x = ((e.clientX - box.left) / box.width) * UNIT.width
    const y = ((e.clientY - box.top) / box.height) * UNIT.height
    const focus = { x: (x - rest.x) / rest.w, y: (y - rest.y) / rest.h }
    dispatch({ type: 'edit', change: (p) => withZooms(p, updateBlock(p.zooms, seg.id, { focus })) })
  }

  const down = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    if (t < seg.startMs || t > seg.endMs) engine.seek(fullZoomMs(seg))
    dispatch({ type: 'gesture-start' })
    onDragging(true)
  }

  const up = () => {
    dispatch({ type: 'gesture-end' })
    onDragging(false)
  }

  return (
    <div className="focus-layer" ref={overlay}>
      {dragging && (
        <div
          className="focus-frame"
          style={{
            left: `${(framed.x / UNIT.width) * 100}%`,
            top: `${(framed.y / UNIT.height) * 100}%`,
            width: `${(framed.w / UNIT.width) * 100}%`,
            height: `${(framed.h / UNIT.height) * 100}%`
          }}
        />
      )}
      <button
        type="button"
        className="focus-dot"
        aria-label="Drag to set the zoom focus"
        style={{ left: `${Math.max(0, Math.min(1, left)) * 100}%`, top: `${Math.max(0, Math.min(1, top)) * 100}%` }}
        onPointerDown={down}
        onPointerMove={(e) => dragging && move(e)}
        onPointerUp={up}
        onPointerCancel={up}
      />
    </div>
  )
}
