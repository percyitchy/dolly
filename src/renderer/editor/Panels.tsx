import { useEffect, useState, type Dispatch } from 'react'
import { CAPTION_LANGUAGES, type CaptionLanguage } from '../../shared/ipc'
import type { Clip, Project, WebcamStyle, ZoomSegment } from '../../shared/project'
import { wallpapers, wallpaperCss } from '../gl'
import { ProBadge, useAccess } from '../home/plan'
import { Seg, Slider, Toggle } from './controls'
import { smoothnessToSpring, springToSmoothness } from './cursor-model'
import { withZooms, type EditorAction } from './editor-state'
import { EASE_RANGE, LEVEL_RANGE, deleteBlock, formatDuration, updateBlock } from './timeline-model'

export type Tool = 'look' | 'cursor' | 'zoom' | 'webcam' | 'captions'

interface PanelProps {
  project: Project
  dispatch: Dispatch<EditorAction>
}

function useGesture(dispatch: Dispatch<EditorAction>) {
  return (phase: 'start' | 'end') => dispatch({ type: phase === 'start' ? 'gesture-start' : 'gesture-end' })
}

export function LookPanel({ project, dispatch, dir }: PanelProps & { dir: string }) {
  const { can, upgrade } = useAccess()
  const gesture = useGesture(dispatch)
  const { look } = project
  const set = (patch: Partial<Project['look']>) => dispatch({ type: 'edit', change: (p) => ({ ...p, look: { ...p.look, ...patch } }) })

  const pickImage = async () => {
    if (!can('customBackground')) return upgrade('customBackground')
    const file = await window.dolly.projects.pickBackgroundImage(dir)
    if (file) set({ background: { kind: 'image', file } })
  }

  return (
    <>
      <div className="field">
        <span>Wallpaper</span>
        <div className="swatches">
          {wallpapers.map((w) => (
            <button
              key={w.id}
              type="button"
              title={w.name}
              aria-label={w.name}
              aria-pressed={look.background.kind === 'wallpaper' && look.background.id === w.id}
              className={look.background.kind === 'wallpaper' && look.background.id === w.id ? 'swatch on' : 'swatch'}
              style={{ background: wallpaperCss(w.id) }}
              onClick={() => set({ background: { kind: 'wallpaper', id: w.id } })}
            />
          ))}
        </div>
        <button type="button" className={look.background.kind === 'image' ? 'ghost small wide on' : 'ghost small wide'} onClick={pickImage}>
          {look.background.kind === 'image' ? 'Change image' : 'Your own image'} <ProBadge feature="customBackground" />
        </button>
      </div>
      <Slider label="Padding" value={look.paddingPct} min={0} max={20} step={0.5} format={(v) => `${v}%`} onChange={(paddingPct) => set({ paddingPct })} onGesture={gesture} />
      <Slider label="Corner radius" value={look.cornerRadiusPct} min={0} max={8} step={0.1} format={(v) => `${v.toFixed(1)}%`} onChange={(cornerRadiusPct) => set({ cornerRadiusPct })} onGesture={gesture} />
      <Slider label="Shadow" value={look.shadow} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(shadow) => set({ shadow })} onGesture={gesture} />
    </>
  )
}

export function CursorPanel({ project, dispatch }: PanelProps) {
  const gesture = useGesture(dispatch)
  const { cursor } = project
  const set = (patch: Partial<Project['cursor']>) => dispatch({ type: 'edit', change: (p) => ({ ...p, cursor: { ...p.cursor, ...patch } }) })
  return (
    <>
      <Toggle label="Smooth" on={cursor.smooth} onChange={(smooth) => set({ smooth })} />
      <Slider
        label="Smoothness"
        value={springToSmoothness(cursor.stiffness)}
        min={0}
        max={1}
        step={0.01}
        disabled={!cursor.smooth}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => set(smoothnessToSpring(v))}
        onGesture={gesture}
      />
      <Toggle label="Click ripple" on={cursor.clickRipple} onChange={(clickRipple) => set({ clickRipple })} />
      <Slider label="Size" value={cursor.scale} min={0.5} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(scale) => set({ scale })} onGesture={gesture} />
    </>
  )
}

export function ZoomPanel({ dispatch, seg }: Omit<PanelProps, 'project'> & { seg: ZoomSegment | null }) {
  const gesture = useGesture(dispatch)
  if (!seg) return <p className="panel-note">Pick a zoom on the timeline to change it.</p>
  const set = (patch: Parameters<typeof updateBlock>[2]) =>
    dispatch({ type: 'edit', change: (p) => withZooms(p, updateBlock(p.zooms, seg.id, patch)) })
  const remove = () => dispatch({ type: 'edit', change: (p) => withZooms(p, deleteBlock(p.zooms, seg.id)) })
  const seconds = (v: number) => `${(v / 1000).toFixed(2)} s`
  return (
    <>
      <Slider label="Level" value={seg.level} min={LEVEL_RANGE.min} max={LEVEL_RANGE.max} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(level) => set({ level })} onGesture={gesture} />
      <Slider label="Ease in" value={seg.easeInMs} min={EASE_RANGE.min} max={EASE_RANGE.max} step={50} format={seconds} onChange={(easeInMs) => set({ easeInMs })} onGesture={gesture} />
      <Slider label="Ease out" value={seg.easeOutMs} min={EASE_RANGE.min} max={EASE_RANGE.max} step={50} format={seconds} onChange={(easeOutMs) => set({ easeOutMs })} onGesture={gesture} />
      <p className="panel-note">Drag the dot on the Landscape preview to aim this zoom.</p>
      <button type="button" className="ghost small wide" onClick={remove}>
        Delete zoom
      </button>
    </>
  )
}

const WEBCAM_DEFAULT: WebcamStyle = { shape: 'circle', corner: 'br', sizePct: 22 }

export function WebcamPanel({ project, dispatch, clip }: PanelProps & { clip: Clip | undefined }) {
  const gesture = useGesture(dispatch)
  const { webcam } = project
  if (!clip) return <p className="panel-note">This recording has no webcam clip.</p>
  const set = (next: WebcamStyle | null) => dispatch({ type: 'edit', change: (p) => ({ ...p, webcam: next }) })
  return (
    <>
      <Toggle label="Show bubble" on={!!webcam} onChange={(on) => set(on ? WEBCAM_DEFAULT : null)} />
      {webcam && (
        <>
          <div className="field">
            <span>Shape</span>
            <Seg
              label="Shape"
              value={webcam.shape}
              options={[
                { value: 'circle', label: 'Circle' },
                { value: 'rounded', label: 'Rounded' }
              ]}
              onChange={(shape) => set({ ...webcam, shape })}
            />
          </div>
          <div className="field">
            <span>Corner</span>
            <div className="corners" role="group" aria-label="Corner">
              {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
                <button
                  key={corner}
                  type="button"
                  aria-label={{ tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' }[corner]}
                  aria-pressed={webcam.corner === corner}
                  className={webcam.corner === corner ? `corner ${corner} on` : `corner ${corner}`}
                  onClick={() => set({ ...webcam, corner })}
                />
              ))}
            </div>
          </div>
          <Slider label="Size" value={webcam.sizePct} min={10} max={40} step={1} format={(v) => `${v}%`} onChange={(sizePct) => set({ ...webcam, sizePct })} onGesture={gesture} />
        </>
      )}
    </>
  )
}

interface CaptionsPanelProps extends PanelProps {
  selectedId: string | null
  onSeek(ms: number): void
  onGenerate(language: CaptionLanguage): void
  run: CaptionRun
}

export type CaptionRun = { state: 'idle' } | { state: 'running'; pct: number } | { state: 'failed'; message: string }

export function CaptionsPanel({ project, dispatch, selectedId, onSeek, onGenerate, run }: CaptionsPanelProps) {
  const gesture = useGesture(dispatch)
  const hasMic = project.clips.some((c) => c.kind === 'mic')
  const [focusId, setFocusId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [language, setLanguage] = useState<CaptionLanguage>('auto')

  useEffect(() => {
    if (selectedId) setFocusId(selectedId)
  }, [selectedId])

  const setText = (id: string, text: string) =>
    dispatch({ type: 'edit', change: (p) => ({ ...p, captions: p.captions.map((c) => (c.id === id ? { ...c, text } : c)) }) })
  const remove = (id: string) =>
    dispatch({ type: 'edit', change: (p) => ({ ...p, captions: p.captions.filter((c) => c.id !== id) }) })

  return (
    <>
      {!hasMic && <p className="panel-note">Captions come from the mic track, and this recording has none.</p>}
      {hasMic && run.state === 'running' && (
        <div className="field">
          <span>Generating, on this computer</span>
          <progress max={100} value={Math.round(run.pct)} />
        </div>
      )}
      {hasMic && run.state !== 'running' && (
        <label className="field">
          <span>Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value as CaptionLanguage)}>
            {CAPTION_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </label>
      )}
      {hasMic && run.state !== 'running' && !confirming && (
        <button
          type="button"
          className="ghost small wide"
          onClick={() => (project.captions.length > 0 ? setConfirming(true) : onGenerate(language))}
        >
          {project.captions.length > 0 ? 'Generate again' : 'Generate captions'}
        </button>
      )}
      {confirming && (
        <div className="confirm">
          <p className="panel-note">This replaces every line below, including your edits.</p>
          <div className="confirm-actions">
            <button type="button" className="ghost small" onClick={() => setConfirming(false)}>Keep my lines</button>
            <button
              type="button"
              className="primary small"
              onClick={() => {
                setConfirming(false)
                onGenerate(language)
              }}
            >
              Replace
            </button>
          </div>
        </div>
      )}
      {run.state === 'failed' && <p className="panel-note error">{run.message}</p>}
      {project.captions.length > 0 && (
        <ul className="caption-lines">
          {project.captions.map((c) => (
            <li key={c.id} className={c.id === focusId ? 'on' : undefined}>
              <button type="button" className="caption-time" onClick={() => onSeek(c.startMs)}>
                {formatDuration(c.startMs)}
              </button>
              <input
                type="text"
                aria-label={`Caption at ${formatDuration(c.startMs)}`}
                value={c.text}
                onFocus={() => gesture('start')}
                onBlur={() => gesture('end')}
                onChange={(e) => setText(c.id, e.target.value)}
              />
              <button type="button" className="caption-remove" aria-label="Delete line" onClick={() => remove(c.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
