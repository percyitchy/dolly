import { useEffect } from 'react'
import type { PermissionKind } from '../../shared/ipc'
import { PermissionItem } from '../home/Home'
import type { PermissionRow } from '../home/permissions-model'
import { LicenseSettings } from '../upgrade/LicenseSettings'

interface SettingsProps {
  rows: PermissionRow[]
  onAllow(kind: PermissionKind): void
  onClose(): void
}

export function Settings({ rows, onAllow, onClose }: SettingsProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" className="scrim" aria-label="Close settings" onClick={onClose} />
      <div className="settings-card">
        <h1>Settings</h1>
        <section aria-label="License">
          <h2>License</h2>
          <LicenseSettings />
        </section>
        {rows.length > 0 && (
          <section aria-label="Permissions">
            <h2>Permissions</h2>
            <ul className="perm-list">
              {rows.map((r) => (
                <PermissionItem key={r.kind} row={r} onAllow={onAllow} />
              ))}
            </ul>
          </section>
        )}
        <button type="button" className="ghost" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
