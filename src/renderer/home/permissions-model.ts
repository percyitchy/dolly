// Which permissions to explain and what each one needs next. No DOM.

import type { PermissionKind, PermissionState } from '../../shared/ipc'

export interface PermissionCopy {
  kind: PermissionKind
  title: string
  why: string
}

export const PERMISSION_COPY: PermissionCopy[] = [
  {
    kind: 'screen',
    title: 'Screen Recording',
    why: 'Lets Dolly record your display. Your recordings stay on this computer.'
  },
  {
    kind: 'input-monitoring',
    title: 'Input Monitoring',
    why: "Lets Dolly see where you click, even in other apps, so each click gets a zoom. macOS's prompt says keystrokes, but Dolly only asks for mouse events, so it never sees what you type."
  },
  {
    kind: 'microphone',
    title: 'Microphone',
    why: 'Records your voice over the video. Only used when the mic is on.'
  },
  {
    kind: 'camera',
    title: 'Camera',
    why: 'Records the webcam bubble. Only used when the webcam is on.'
  }
]

export type PermissionAction = 'allow' | 'open-settings' | null

export interface PermissionRow extends PermissionCopy {
  state: PermissionState
  action: PermissionAction
  required: boolean
}

export type Permissions = Record<PermissionKind, PermissionState>

export interface RecordingChoices {
  mic: boolean
  webcam: boolean
  clicks: boolean // Off when the user chose to record with no automatic zooms
}

// Skipping clicks only stands while the permission is missing, since no switch turns them back on afterwards
export function clicksWanted(chosen: boolean, perms: Permissions | null): boolean {
  return chosen || perms?.['input-monitoring'] === 'granted'
}

function isOk(state: PermissionState): boolean {
  return state === 'granted' || state === 'not-needed'
}

function requiredFor(kind: PermissionKind, choices: RecordingChoices): boolean {
  if (kind === 'microphone') return choices.mic
  if (kind === 'camera') return choices.webcam
  if (kind === 'input-monitoring') return choices.clicks
  return true
}

export function actionFor(state: PermissionState): PermissionAction {
  if (state === 'not-determined') return 'allow'
  if (state === 'denied') return 'open-settings'
  return null
}

// not-needed kinds are hidden, which is everything but mic and camera on Windows.
// The camera row only shows for someone who can turn the webcam on
export function permissionRows(perms: Permissions, choices: RecordingChoices, canWebcam: boolean): PermissionRow[] {
  return PERMISSION_COPY.filter((c) => perms[c.kind] !== 'not-needed')
    .filter((c) => c.kind !== 'camera' || canWebcam)
    .map((c) => ({
      ...c,
      state: perms[c.kind],
      action: actionFor(perms[c.kind]),
      required: requiredFor(c.kind, choices)
    }))
}

// The first-run panel shows until nothing Dolly needs is outstanding
export function missingPermissions(perms: Permissions, choices: RecordingChoices): PermissionKind[] {
  return PERMISSION_COPY.map((c) => c.kind).filter((k) => requiredFor(k, choices) && !isOk(perms[k]))
}

export function canRecord(perms: Permissions, choices: RecordingChoices): boolean {
  return missingPermissions(perms, choices).length === 0
}
