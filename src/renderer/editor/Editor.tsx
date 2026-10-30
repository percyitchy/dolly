import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from 'react'
import { buildCursorTrack } from '../../engine/cursor'
import type { CursorTrack } from '../../shared/compose'
import type { CaptionLanguage, OpenedProject } from '../../shared/ipc'
import { LOOK_DEFAULTS, outputSize, type Project, type Shape } from '../../shared/project'
import { renderWallpaper } from '../gl'
import { errorText } from '../home/error-text'
import { useAccess } from '../home/plan'
import { createAutosave, type Autosave, type SaveStatus } from './autosave'
import { editorReducer, initialState, withZooms, type EditorAction } from './editor-state'
import { ExportStrip } from './ExportStrip'
import { CaptionsPanel, CursorPanel, LookPanel, WebcamPanel, ZoomPanel, type CaptionRun, type Tool } from './Panels'
import { PreviewEngine } from './preview-engine'
import { Previews } from './Previews'
import { Timeline } from './Timeline'
import { addZoom, deleteBlock } from './timeline-model'

const AUTOSAVE_MS = 800

interface EditorProps {
  dir: string
  warnings: string[]
  onExit(): void
}

export function Editor({ dir, warnings, onExit }: EditorProps) {
  const [opened, setOpened] = useState<OpenedProject | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setOpened(null)
    setError(null)
    window.dolly.projects.open(dir).then(
      (result) => alive && setOpened(result),
      () => alive && setError("Couldn't open this project.")
    )
    return () => {
      alive = false
    }
  }, [dir])

  if (error) {
    return (
      <div className="message-screen">
        <p>{error}</p>
        <button type="button" className="ghost" onClick={onExit}>Back</button>
      </div>
    )
  }
  if (!opened) return <div className="message-screen" />
  return <Workspace key={dir} opened={opened} warnings={warnings} onExit={onExit} />
}

const wallpaperCache = new Map<string, TexImageSource>()

function wallpaperFor(id: string, shape: Shape): TexImageSource {
  const key = `${id}:${shape}`
  let source = wallpaperCache.get(key)
  if (!source) {
    const { width, height } = outputSize(shape, '1080p')
    source = renderWallpaper(id, width, height)
    wallpaperCache.set(key, source)
  }
  return source
}

type Background = (shape: Shape) => TexImageSource

function useBackground(dir: string, look: Project['look'], allowed: boolean): Background | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const file = look.background.kind === 'image' && allowed ? look.background.file : null
  const wallpaper = look.background.kind === 'wallpaper' ? look.background : (LOOK_DEFAULTS.background as { kind: 'wallpaper'; id: string })

  useEffect(() => {
    setImage(null)
    if (!file) return
    let alive = true
    window.dolly.projects.mediaUrl(dir, file).then((url) => {
      if (!alive) return
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => alive && setImage(img)
      img.src = url
    })
    return () => {
      alive = false
    }
  }, [dir, file])

  // A Free project keeping a Pro image previews on the default, as it exports
  return useMemo(() => {
    if (!file) return (shape: Shape) => wallpaperFor(wallpaper.id, shape)
    return image ? () => image : null
  }, [file, image, wallpaper.id])
}

function Workspace({ opened, warnings, onExit }: { opened: OpenedProject; warnings: string[]; onExit(): void }) {
  const { dir } = opened
  const { can, upgrade, sheetOpen } = useAccess()
  const [state, dispatch] = useReducer(editorReducer, opened.project, initialState)
  const { project, selectedId } = state
  const [tool, setTool] = useState<Tool | null>(null)
  const [captionId, setCaptionId] = useState<string | null>(null)
  const [focusDrag, setFocusDrag] = useState(false)
  const [captionRun, setCaptionRun] = useState<CaptionRun>({ state: 'idle' })
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [engine, setEngine] = useState<PreviewEngine | null>(null)
  const [mediaError, setMediaError] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [notices, setNotices] = useState(warnings)
  // Leaving now would strand the run, and edits held back while captions are written
  const busy = exporting || captionRun.state === 'running'

  const screen = project.clips.find((c) => c.kind === 'screen')
  const mic = project.clips.find((c) => c.kind === 'mic')
  const webcamClip = project.clips.find((c) => c.kind === 'webcam')
  const canWebcam = can('webcam')
  const canCaptions = can('captions')
  const selected = project.zooms.find((z) => z.id === selectedId) ?? null

  const { smooth, stiffness, damping } = project.cursor
  const track = useMemo<CursorTrack>(
    () => buildCursorTrack(opened.cursor, project.cursor),
    // Size and ripple don't change the path, so they don't need the spring re-run
    [opened.cursor, smooth, stiffness, damping]
  )
  const background = useBackground(dir, project.look, can('customBackground'))

  // Autosave
  const autosave = useRef<Autosave<Project> | null>(null)
  autosave.current ??= createAutosave((value) => window.dolly.projects.save(dir, value), AUTOSAVE_MS, setSaveStatus)
  const lastProject = useRef(project)
  useEffect(() => {
    if (lastProject.current === project) return
    lastProject.current = project
    autosave.current!.schedule(project)
  }, [project])
  useEffect(() => {
    const flush = () => void autosave.current?.flush()
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [])

  // Preview
  useEffect(() => {
    if (!screen) return
    let alive = true
    let made: PreviewEngine | null = null
    window.dolly.projects.mediaUrl(dir, screen.file).then(
      (url) => {
        if (!alive) return
        made = new PreviewEngine(screen, url)
        setEngine(made)
      },
      () => setMediaError(true)
    )
    return () => {
      alive = false
      made?.dispose()
      setEngine(null)
    }
    // The screen clip doesn't change once a project is open
  }, [dir])

  useEffect(() => {
    if (!engine || !mic) return
    let alive = true
    window.dolly.projects.mediaUrl(dir, mic.file).then((url) => alive && engine.addFollower('mic', mic, url), () => {})
    return () => {
      alive = false
    }
  }, [engine, dir])

  useEffect(() => {
    if (!engine || !webcamClip || !canWebcam) return
    let alive = true
    window.dolly.projects.mediaUrl(dir, webcamClip.file).then((url) => alive && engine.addFollower('webcam', webcamClip, url), () => {})
    return () => {
      alive = false
    }
  }, [engine, dir, canWebcam])

  useEffect(() => {
    engine?.setScene({
      project,
      track,
      background,
      pro: { webcam: canWebcam, captions: canCaptions },
      restShape: focusDrag ? '16:9' : null
    })
  }, [engine, project, track, background, canWebcam, canCaptions, focusDrag])

  // Captions: main writes them, so hold autosave until they've been read back
  useEffect(
    () =>
      window.dolly.captions.onEvent((event) => {
        if (event.type === 'progress') setCaptionRun({ state: 'running', pct: event.pct })
        if (event.type === 'failed') {
          setCaptionRun({ state: 'failed', message: event.message })
          autosave.current?.resume()
        }
        if (event.type === 'done' && event.projectDir === dir) {
          window.dolly.projects.open(dir).then(
            ({ project: saved }) => {
              dispatch({ type: 'edit', change: (p) => ({ ...p, captions: saved.captions }) })
              setCaptionRun({ state: 'idle' })
              autosave.current?.resume()
            },
            () => {
              setCaptionRun({ state: 'failed', message: "Couldn't read the new captions." })
              autosave.current?.resume()
            }
          )
        }
      }),
    [dir]
  )

  const generateCaptions = async (language: CaptionLanguage) => {
    setCaptionRun({ state: 'running', pct: 0 })
    await autosave.current!.flush()
    autosave.current!.pause()
    // Resolves when the job ends, and the outcome arrives as events. A rejection means it never started
    window.dolly.captions.generate(dir, language).catch((error: unknown) => {
      setCaptionRun({ state: 'failed', message: errorText(error, "Couldn't start captions.") })
      autosave.current?.resume()
    })
  }

  const selectBlock = useCallback((id: string) => {
    dispatch({ type: 'select', id })
    setTool('zoom')
  }, [])

  const selectCaption = useCallback(
    (id: string) => {
      setCaptionId(id)
      setTool('captions')
      const line = project.captions.find((c) => c.id === id)
      if (line) engine?.seek(line.startMs)
    },
    [project.captions, engine]
  )

  const addAtPlayhead = useCallback(() => {
    if (!engine) return
    const t = engine.getTime()
    const at = track.at(t)
    const focus = screen?.width && screen.height ? { x: at.x / screen.width, y: at.y / screen.height } : { x: 0.5, y: 0.5 }
    const id = crypto.randomUUID()
    const zooms = addZoom(project.zooms, t, project.durationMs, focus, id)
    if (!zooms) return
    dispatch({ type: 'edit', change: (p) => withZooms(p, zooms) })
    selectBlock(id)
  }, [engine, track, screen, project.zooms, project.durationMs, selectBlock])

  const toggleShape = (shape: Shape) =>
    dispatch({
      type: 'output',
      change: (o) => {
        const shapes = o.shapes.includes(shape) ? o.shapes.filter((s) => s !== shape) : [...o.shapes, shape]
        return { ...o, shapes }
      }
    })

  const openTool = (next: Tool) => {
    if (next === 'webcam' && !canWebcam) return upgrade('webcam')
    if (next === 'captions' && !canCaptions) return upgrade('captions')
    setTool((current) => (current === next ? null : next))
  }

  const exit = async () => {
    engine?.pause()
    await autosave.current?.flush()
    onExit()
  }

  useShortcuts({ engine, disabled: sheetOpen, selectedId, dispatch, onDeselect: () => dispatch({ type: 'select', id: null }) })

  if (!screen?.width || !screen.height || mediaError) {
    return (
      <div className="message-screen">
        <p>This project has no screen recording to show.</p>
        <button type="button" className="ghost" onClick={onExit}>Back</button>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="bar">
        <button type="button" className="mark-button" aria-label="All projects" disabled={busy} onClick={exit}>
          <span className="mark"><i /></span>
        </button>
        <b className="project-name">{project.name}</b>
        <nav className="tools" aria-label="Tools">
          <ToolTab tool="look" current={tool} label="Look" onOpen={openTool} />
          <ToolTab tool="cursor" current={tool} label="Cursor" onOpen={openTool} />
          <ToolTab tool="zoom" current={tool} label="Zoom" onOpen={openTool} />
          <ToolTab tool="webcam" current={tool} label="Webcam" locked={!canWebcam} onOpen={openTool} />
          <ToolTab tool="captions" current={tool} label="Captions" locked={!canCaptions} onOpen={openTool} />
        </nav>
        <span className="grow" />
        {saveStatus === 'failed' && <span className="save-failed">Couldn't save</span>}
        <button type="button" className="ghost" disabled={busy} onClick={exit}>Record again</button>
      </header>

      <div className="notices">
        {notices.map((w) => (
          <p key={w}>
            <span>{w}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setNotices((list) => list.filter((n) => n !== w))}>×</button>
          </p>
        ))}
      </div>

      <div className="stage-row">
        {engine ? (
          <Previews
            engine={engine}
            project={project}
            track={track}
            shapes={project.output.shapes}
            focusBlock={tool === 'zoom' ? selected : null}
            focusDrag={focusDrag}
            onFocusDrag={setFocusDrag}
            dispatch={dispatch}
            onShapeToggle={toggleShape}
          />
        ) : (
          <main className="formats" />
        )}
        {tool && (
          <aside className="panel" aria-label={`${tool} settings`}>
            <h2>{{ look: 'Look', cursor: 'Cursor', zoom: 'Zoom', webcam: 'Webcam', captions: 'Captions' }[tool]}</h2>
            {tool === 'look' && <LookPanel project={project} dispatch={dispatch} dir={dir} />}
            {tool === 'cursor' && <CursorPanel project={project} dispatch={dispatch} />}
            {tool === 'zoom' && <ZoomPanel dispatch={dispatch} seg={selected} />}
            {tool === 'webcam' && <WebcamPanel project={project} dispatch={dispatch} clip={webcamClip} />}
            {tool === 'captions' && (
              <CaptionsPanel
                project={project}
                dispatch={dispatch}
                selectedId={captionId}
                onSeek={(ms) => engine?.seek(ms)}
                onGenerate={generateCaptions}
                run={captionRun}
              />
            )}
          </aside>
        )}
      </div>

      {engine ? (
        <Timeline
          engine={engine}
          project={project}
          dir={dir}
          clicks={track.clicks}
          selectedId={selectedId}
          dispatch={dispatch}
          onSelectBlock={selectBlock}
          onSelectCaption={selectCaption}
          onAddZoom={addAtPlayhead}
        />
      ) : (
        <section className="tl" />
      )}

      <ExportStrip dir={dir} project={project} dispatch={dispatch} beforeExport={() => autosave.current!.flush()} onRunning={setExporting} />
    </div>
  )
}

function ToolTab({ tool, current, label, locked, onOpen }: { tool: Tool; current: Tool | null; label: string; locked?: boolean; onOpen(tool: Tool): void }) {
  return (
    <button type="button" className={current === tool ? 'on' : undefined} aria-pressed={current === tool} onClick={() => onOpen(tool)}>
      {label} {locked && <i className="pro">Pro</i>}
    </button>
  )
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true
  return target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'checkbox'
}

// A button focused with the keyboard keeps Space. One that was only clicked doesn't, or Space
// after clicking a toggle would flip the toggle instead of playing
function keyboardFocused(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.matches('button:focus-visible, [role="button"]:focus-visible')
}

function useShortcuts({ engine, disabled, selectedId, dispatch, onDeselect }: {
  engine: PreviewEngine | null
  disabled: boolean
  selectedId: string | null
  dispatch: Dispatch<EditorAction>
  onDeselect(): void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled || isTextField(e.target)) return
      const command = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (command && key === 'z') {
        e.preventDefault()
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
      } else if (command && key === 'y') {
        e.preventDefault()
        dispatch({ type: 'redo' })
      } else if (key === ' ' && !command) {
        if (keyboardFocused(e.target)) return
        e.preventDefault()
        engine?.toggle()
      } else if ((key === 'delete' || key === 'backspace') && selectedId) {
        e.preventDefault()
        dispatch({ type: 'edit', change: (p) => withZooms(p, deleteBlock(p.zooms, selectedId)) })
      } else if (key === 'escape' && selectedId) {
        onDeselect()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, disabled, selectedId, dispatch, onDeselect])
}
