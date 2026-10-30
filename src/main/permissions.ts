// The four permissions Dolly needs. Windows only asks about mic and camera.
// Input Monitoring is what macOS checks for a mouse event tap, even one with no keyboard events in its mask.
// It's the helper that holds the tap, so the helper is what asks. Accessibility isn't part of it.

import { execFile } from 'node:child_process'
import { shell, systemPreferences } from 'electron'
import type { PermissionKind, PermissionState } from '../shared/ipc'
import { nativeBin } from './paths'

export const PERMISSION_KINDS: PermissionKind[] = ['screen', 'input-monitoring', 'microphone', 'camera']

const SETTINGS_URLS: Record<string, Partial<Record<PermissionKind, string>>> = {
  darwin: {
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    'input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'
  },
  win32: {
    microphone: 'ms-settings:privacy-microphone',
    camera: 'ms-settings:privacy-webcam'
  }
}

export function isPermissionKind(kind: unknown): kind is PermissionKind {
  return PERMISSION_KINDS.includes(kind as PermissionKind)
}

export function settingsUrl(kind: PermissionKind, platform: NodeJS.Platform): string | null {
  return SETTINGS_URLS[platform]?.[kind] ?? null
}

export function needsPermission(kind: PermissionKind, platform: NodeJS.Platform): boolean {
  if (kind === 'microphone' || kind === 'camera') return platform === 'darwin' || platform === 'win32'
  return platform === 'darwin'
}

export function mapMediaStatus(status: string): PermissionState {
  if (status === 'granted') return 'granted'
  if (status === 'not-determined') return 'not-determined'
  return 'denied'
}

// Screen and Input Monitoring only answer yes or no. Until Dolly has asked, a no means "not asked yet", and
// asking again is harmless: the OS shows nothing and the row then offers the settings page
export function mapBooleanStatus(granted: boolean, asked: boolean): PermissionState {
  if (granted) return 'granted'
  return asked ? 'denied' : 'not-determined'
}

const asked = new Set<PermissionKind>()

// Opens the device and says whether that worked
export type MediaProbe = (kind: PermissionKind) => Promise<boolean>

// Windows has no prompt to raise, so what Allow learned by trying stands in for its not-determined
const probed = new Map<PermissionKind, PermissionState>()

type HelperCommand = 'permission' | 'request-permission' | 'request-mouse-permission'

function helperPermission(command: HelperCommand, kind: 'screen' | 'mouse'): Promise<boolean | null> {
  return new Promise((done) => {
    execFile(nativeBin('dolly-capture'), [command], { timeout: 60000, windowsHide: true }, (error, stdout) => {
      if (error) return done(null)
      try {
        const reply = JSON.parse(stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>
        const answer = reply[kind]
        done(typeof answer === 'boolean' ? answer : null)
      } catch {
        done(null)
      }
    })
  })
}

async function screenGranted(): Promise<boolean> {
  const answer = await helperPermission('permission', 'screen')
  return answer ?? systemPreferences.getMediaAccessStatus('screen') === 'granted'
}

export async function permissionStatus(kind: PermissionKind): Promise<PermissionState> {
  if (!needsPermission(kind, process.platform)) return 'not-needed'
  if (kind === 'screen') return mapBooleanStatus(await screenGranted(), asked.has(kind))
  if (kind === 'input-monitoring') return mapBooleanStatus((await helperPermission('permission', 'mouse')) ?? false, asked.has(kind))
  const state = mapMediaStatus(systemPreferences.getMediaAccessStatus(kind))
  return state === 'not-determined' ? (probed.get(kind) ?? state) : state
}

export async function allPermissions(): Promise<Record<PermissionKind, PermissionState>> {
  const [screen, inputMonitoring, microphone, camera] = await Promise.all(PERMISSION_KINDS.map(permissionStatus))
  return { screen, 'input-monitoring': inputMonitoring, microphone, camera }
}

export async function requestPermission(kind: PermissionKind, probe?: MediaProbe): Promise<PermissionState> {
  if (!needsPermission(kind, process.platform)) return 'not-needed'
  asked.add(kind)
  if (kind === 'screen') {
    await helperPermission('request-permission', 'screen')
  } else if (kind === 'input-monitoring') {
    await helperPermission('request-mouse-permission', 'mouse')
  } else if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess(kind)
  } else if (probe && (await permissionStatus(kind)) === 'not-determined') {
    probed.set(kind, (await probe(kind)) ? 'granted' : 'denied')
  }
  return permissionStatus(kind)
}

export async function openPermissionSettings(kind: PermissionKind): Promise<void> {
  const url = settingsUrl(kind, process.platform)
  if (url) await shell.openExternal(url)
}
