import { useEffect, useRef, useState, type CSSProperties, type Dispatch } from 'react'
import { lockedInProject, type Feature } from '../../shared/entitlements'
import type { ExportEvent } from '../../shared/ipc'
import type { OutputSettings, Project, Shape } from '../../shared/project'
import { errorText } from '../home/error-text'
import { ProBadge, useAccess } from '../home/plan'
import type { EditorAction } from './editor-state'
import { effectiveOutput, exportNote, filesLabel, leftOutLine, shapeName, shortPath } from './export-model'

type Run =
  | { state: 'idle' }
  | { state: 'running'; shapes: Shape[]; fileIndex: number; pct: number }
  | { state: 'done'; files: string[] }
  | { state: 'failed'; message: string }

interface ExportStripProps {
  dir: string
  project: Project
  dispatch: Dispatch<EditorAction>
  beforeExport(): Promise<void>
  onRunning(running: boolean): void
}

export function ExportStrip({ dir, project, dispatch, beforeExport, onRunning }: ExportStripProps) {
  const { plan, can, upgrade } = useAccess()
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const output = effectiveOutput(plan, project.output)
  const leftOut = leftOutLine(lockedInProject(plan, project))
  const gif = output.format === 'gif'
  const runShapes = useRef<Shape[]>([])

  useEffect(
    () =>
      window.dolly.export.onEvent((event: ExportEvent) => {
        if (event.type === 'progress') {
          setRun({ state: 'running', shapes: runShapes.current, fileIndex: event.fileIndex, pct: event.pct })
        } else if (event.type === 'done') {
          setRun({ state: 'done', files: event.files })
        } else if (event.type === 'failed') {
          setRun({ state: 'failed', message: event.message })
        } else {
          setRun({ state: 'idle' })
        }
      }),
    []
  )

  const set = (patch: Partial<OutputSettings>) => {
    setRun({ state: 'idle' })
    dispatch({ type: 'output', change: (o) => ({ ...o, ...patch }) })
  }

  const pick = (feature: Feature, patch: Partial<OutputSettings>) => (can(feature) ? set(patch) : upgrade(feature))

  const pickFolder = async () => {
    const folder = await window.dolly.export.pickFolder()
    if (folder) set({ folder })
  }

  const start = async () => {
    runShapes.current = output.shapes
    setRun({ state: 'running', shapes: output.shapes, fileIndex: 0, pct: 0 })
    try {
      await beforeExport() // Export reads the project from disk
      await window.dolly.export.start({ projectDir: dir, output })
    } catch (error) {
      setRun({ state: 'failed', message: errorText(error, 'Export failed.') })
    }
  }

  const running = run.state === 'running'
  useEffect(() => onRunning(running), [running, onRunning])

  return (
    <footer className="ship" aria-label="Export">
      {run.state === 'running' ? (
        <Progress shapes={run.shapes} fileIndex={run.fileIndex} pct={run.pct} />
      ) : (
        <div className="opts">
          <Option label="Format">
            <button type="button" className={!gif ? 'on' : undefined} onClick={() => set({ format: 'mp4' })}>MP4</button>
            <button type="button" className={gif ? 'on' : undefined} onClick={() => pick('gif', { format: 'gif' })}>
              GIF <ProBadge feature="gif" />
            </button>
          </Option>
          <Option label="Resolution">
            <button type="button" disabled={gif} className={!gif && output.resolution === '1080p' ? 'on' : undefined} onClick={() => set({ resolution: '1080p' })}>1080p</button>
            <button type="button" disabled={gif} className={!gif && output.resolution === '4k' ? 'on' : undefined} onClick={() => pick('export4k', { resolution: '4k' })}>
              4K <ProBadge feature="export4k" />
            </button>
          </Option>
          <Option label="Frame rate">
            <button type="button" disabled={gif} className={!gif && output.fps === 30 ? 'on' : undefined} onClick={() => set({ fps: 30 })}>30</button>
            <button type="button" disabled={gif} className={!gif && output.fps === 60 ? 'on' : undefined} onClick={() => pick('export60fps', { fps: 60 })}>
              60 <ProBadge feature="export60fps" />
            </button>
          </Option>
        </div>
      )}
      <span className="grow" />
      <div className="note">
        {leftOut && <div className="left-out" title={leftOut}>{leftOut}</div>}
        {run.state === 'failed' ? (
          <div className="failed">{run.message}</div>
        ) : run.state === 'done' ? (
          <div>{filesLabel(run.files.length)} saved</div>
        ) : (
          <div>{exportNote(output, project.durationMs)}{gif ? ' · 720 px, 15 fps' : ''}</div>
        )}
        <button type="button" className="folder" disabled={running} title={output.folder} onClick={pickFolder}>
          {output.folder ? shortPath(output.folder) : 'Default folder'}
        </button>
      </div>
      {running && (
        <button type="button" className="ghost cancel" onClick={() => window.dolly.export.cancel()}>
          Cancel
        </button>
      )}
      {run.state === 'done' && run.files.length > 0 && (
        <button type="button" className="ghost cancel" onClick={() => window.dolly.export.reveal(run.files[0])}>
          {navigator.userAgent.includes('Mac') ? 'Reveal in Finder' : 'Show in Explorer'}
        </button>
      )}
      {!running && (
        <button type="button" className="primary" disabled={output.shapes.length === 0} onClick={start}>
          Export {filesLabel(output.shapes.length)}
        </button>
      )}
    </footer>
  )
}

function Option({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="opt">
      <span>{label}</span>
      <div className="seg">{children}</div>
    </div>
  )
}

function Progress({ shapes, fileIndex, pct }: { shapes: Shape[]; fileIndex: number; pct: number }) {
  return (
    <div className="opts progress">
      {shapes.map((shape, i) => {
        const value = i < fileIndex ? 100 : i > fileIndex ? 0 : pct
        return (
          <div className="opt" key={shape}>
            <span>{shapeName(shape)} · {Math.round(value)}%</span>
            <div className="bar-track" style={{ '--v': `${value}%` } as CSSProperties} role="progressbar" aria-valuenow={Math.round(value)} aria-label={`${shapeName(shape)} export`} />
          </div>
        )
      })}
    </div>
  )
}
