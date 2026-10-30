import { useCallback, useEffect, useRef, useState } from 'react'
import type { DisplayInfo, PermissionKind, PermissionState, ProjectSummary } from '../../shared/ipc'
import { Toggle } from '../editor/controls'
import { formatDuration } from '../editor/timeline-model'
import { Settings } from '../settings/Settings'
import { errorText } from './error-text'
import { canRecord, clicksWanted, missingPermissions, permissionRows, type PermissionRow, type Permissions } from './permissions-model'
import { ProBadge, useAccess } from './plan'

const PERMISSION_POLL_MS = 2000
const COUNTDOWN_FROM = 3

type Phase = { name: 'idle' } | { name: 'countdown'; left: number } | { name: 'starting' } | { name: 'recording' } | { name: 'saving' }

export function Home({ onOpen }: { onOpen(dir: string, warnings?: string[]): void }) {
  const { can, upgrade } = useAccess()
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [displayId, setDisplayId] = useState<string | null>(null)
  const [mic, setMic] = useState(true)
  const [webcam, setWebcam] = useState(false)
  const [clicks, setClicks] = useState(true)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [perms, setPerms] = useState<Permissions | null>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const projectDir = useRef<string | null>(null)
  const lastWarnings = useRef<string[]>([]) // For the handler below, which outlives one render
  const webcamOn = webcam && can('webcam')
  const clicksOn = clicksWanted(clicks, perms)
  const choices = { mic, webcam: webcamOn, clicks: clicksOn }

  const loadPermissions = useCallback(() => {
    window.dolly.capture.permissions().then(setPerms, () => {})
  }, [])

  useEffect(() => {
    loadPermissions()
    window.dolly.capture.displays().then(
      (list) => {
        setDisplays(list)
        setDisplayId((list.find((d) => d.primary) ?? list[0])?.id ?? null)
      },
      () => setError("Couldn't list your displays.")
    )
    window.dolly.projects.list().then(setProjects, () => {})
  }, [loadPermissions])

  // Permissions change in System Settings, so look again when the user comes back
  const missing = perms ? missingPermissions(perms, choices) : []
  useEffect(() => {
    if (missing.length === 0) return
    const timer = setInterval(loadPermissions, PERMISSION_POLL_MS)
    window.addEventListener('focus', loadPermissions)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', loadPermissions)
    }
  }, [missing.length, loadPermissions])

  useEffect(
    () =>
      window.dolly.capture.onEvent(async (event) => {
        if (event.type === 'started') {
          projectDir.current = event.projectDir
          lastWarnings.current = event.warnings ?? []
          setWarnings(lastWarnings.current)
          setPhase({ name: 'recording' })
        } else if (event.type === 'warning') {
          lastWarnings.current = [...lastWarnings.current, event.message]
          setWarnings(lastWarnings.current)
        } else if (event.type === 'error') {
          setError(event.message)
          setPhase({ name: 'idle' })
        } else {
          setPhase({ name: 'saving' })
          lastWarnings.current = [...lastWarnings.current, ...(event.warnings ?? [])]
          const dir = projectDir.current ?? (await window.dolly.projects.list()).find((p) => p.id === event.projectId)?.dir
          if (dir) onOpen(dir, lastWarnings.current)
          else setPhase({ name: 'idle' })
        }
      }),
    [onOpen]
  )

  useEffect(() => {
    if (phase.name !== 'countdown') return
    if (phase.left === 0) {
      setPhase({ name: 'starting' })
      window.dolly.capture.start({ displayId: displayId!, mic, webcam: webcamOn, clicks: clicksOn }).catch((e: unknown) => {
        setError(errorText(e, "Couldn't start recording."))
        setPhase({ name: 'idle' })
      })
      return
    }
    const timer = setTimeout(() => setPhase({ name: 'countdown', left: phase.left - 1 }), 1000)
    return () => clearTimeout(timer)
  }, [phase, displayId, mic, webcamOn, clicksOn])

  useEffect(() => {
    if (phase.name !== 'countdown') return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPhase({ name: 'idle' })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase.name])

  const toggleWebcam = (on: boolean) => {
    if (!can('webcam')) return upgrade('webcam')
    setWebcam(on)
  }

  const record = () => {
    setError(null)
    setWarnings([])
    setPhase({ name: 'countdown', left: COUNTDOWN_FROM })
  }

  const allow = async (kind: PermissionKind) => {
    const state: PermissionState = await window.dolly.capture.requestPermission(kind)
    setPerms((p) => (p ? { ...p, [kind]: state } : p))
    loadPermissions()
  }

  const rows = perms ? permissionRows(perms, choices, can('webcam')) : []
  const ready = !!perms && !!displayId && canRecord(perms, choices)

  return (
    <div className="home">
      <header className="bar">
        <span className="mark"><i /></span>
        <b>Dolly</b>
        <span className="grow" />
        <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>Settings</button>
      </header>

      <main className="home-main">
        <section className="home-card" aria-label="New recording">
          {missing.length > 0 ? (
            <PermissionsCard
              rows={rows}
              missing={missing}
              onAllow={allow}
              onSkipMic={() => setMic(false)}
              onSkipClicks={() => setClicks(false)}
            />
          ) : (
            <>
              <h1>New recording</h1>
              <div className="field">
                <span>Display</span>
                <div className="display-list" role="radiogroup" aria-label="Display">
                  {displays.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      role="radio"
                      aria-checked={d.id === displayId}
                      className={d.id === displayId ? 'display on' : 'display'}
                      onClick={() => setDisplayId(d.id)}
                    >
                      <b>{d.name}</b>
                      <span>{d.width} × {d.height}</span>
                    </button>
                  ))}
                </div>
              </div>
              <Toggle label="Microphone" on={mic} onChange={setMic} />
              <Toggle label="Webcam" on={webcamOn} onChange={toggleWebcam} badge={<ProBadge feature="webcam" />} />
              <button type="button" className="primary record" disabled={!ready} onClick={record}>
                <i className="rec-dot" /> Record
              </button>
            </>
          )}
          {error && <p className="error">{error}</p>}
          {warnings.map((w) => <p key={w} className="warning">{w}</p>)}
        </section>

        <section className="recent" aria-label="Recent projects">
          <h2>Recent</h2>
          {projects.length === 0 ? (
            <p className="muted">Your recordings show up here.</p>
          ) : (
            <ul>
              {projects.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => onOpen(p.dir)}>
                    <b>{p.name}</b>
                    <span>{formatDate(p.createdAt)}</span>
                    <span className="tc">{formatDuration(p.durationMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {phase.name !== 'idle' && <RecordingOverlay phase={phase} warnings={warnings} onCancel={() => setPhase({ name: 'idle' })} />}
      {settingsOpen && (
        <Settings rows={rows} onClose={() => setSettingsOpen(false)} onAllow={allow} />
      )}
    </div>
  )
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}

function PermissionsCard({ rows, missing, onAllow, onSkipMic, onSkipClicks }: {
  rows: PermissionRow[]
  missing: PermissionKind[]
  onAllow(kind: PermissionKind): void
  onSkipMic(): void
  onSkipClicks(): void
}) {
  const next = rows.find((r) => r.action && r.required)
  return (
    <>
      <h1>Before your first recording</h1>
      <p className="muted">Dolly needs a few permissions. Here's why, before your system asks.</p>
      <ul className="perm-list">
        {rows.map((r) => (
          <PermissionItem key={r.kind} row={r} primary={r.kind === next?.kind} onAllow={onAllow} />
        ))}
      </ul>
      {(missing.includes('screen') || missing.includes('input-monitoring')) && (
        <p className="muted">
          Already on in System Settings? macOS forgets this after an update. Remove Dolly from that list with the minus
          button, then allow it again.
        </p>
      )}
      {missing.includes('microphone') && (
        <button type="button" className="link" onClick={onSkipMic}>Record without the mic</button>
      )}
      {missing.includes('input-monitoring') && (
        <button type="button" className="link" onClick={onSkipClicks}>Record without automatic zooms</button>
      )}
    </>
  )
}

export function PermissionItem({ row, primary, onAllow }: { row: PermissionRow; primary?: boolean; onAllow(kind: PermissionKind): void }) {
  const className = primary ? 'primary small' : 'ghost small'
  return (
    <li>
      <div>
        <b>{row.title}</b>
        <p>{row.why}</p>
      </div>
      {row.action === 'allow' && <button type="button" className={className} onClick={() => onAllow(row.kind)}>Allow</button>}
      {row.action === 'open-settings' && (
        <button type="button" className={className} onClick={() => window.dolly.capture.openPermissionSettings(row.kind)}>Open Settings</button>
      )}
      {row.action === null && <span className="granted">Allowed</span>}
    </li>
  )
}

function RecordingOverlay({ phase, warnings, onCancel }: { phase: Phase; warnings: string[]; onCancel(): void }) {
  const stopKey = navigator.userAgent.includes('Mac') ? '⌘⇧2' : 'Ctrl+Shift+2'
  return (
    <div className="rec-overlay" role="status">
      {phase.name === 'countdown' && (
        <>
          <span key={phase.left} className="count">{phase.left || ''}</span>
          <button type="button" className="ghost on-dark" onClick={onCancel}>Cancel</button>
        </>
      )}
      {phase.name === 'recording' && (
        <>
          <p className="rec-state"><i className="rec-dot" /> Recording</p>
          <button type="button" className="primary" onClick={() => window.dolly.capture.stop()}>Stop</button>
          <p className="muted">Or press {stopKey}</p>
          {warnings.map((w) => <p key={w} className="warning">{w}</p>)}
        </>
      )}
      {phase.name === 'starting' && <p className="rec-state">Starting</p>}
      {phase.name === 'saving' && <p className="rec-state">Saving your recording</p>}
    </div>
  )
}
