// Rules every window lives under: locked-down web preferences, no navigation, no popups, and media only for the
// hidden recorder window while it's recording.

import { join } from 'node:path'
import { app, type BrowserWindow, type MenuItemConstructorOptions, type WebContents, type WebPreferences } from 'electron'

export type PreloadName = 'index' | 'recorder' | 'export' | 'stopbar'

export function secureWebPreferences(preload: PreloadName, extra: WebPreferences = {}): WebPreferences {
  return {
    preload: join(__dirname, `../preload/${preload}.cjs`),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    devTools: !app.isPackaged,
    ...extra
  }
}

// Pages only ever load from main, which fires none of these events. So anything that does fire them, such as a
// file dropped on the window, is a page trying to leave the app. Reloading itself is fine, and the dev server does
export function guardContents(contents: WebContents): void {
  const stay = (event: Electron.Event<{ url: string }>) => {
    if (event.url !== contents.getURL()) event.preventDefault()
  }
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', stay)
  contents.on('will-frame-navigate', stay)
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

export interface RecorderMedia {
  audio: boolean
  video: boolean
}

let recorder: { contents: WebContents; media: RecorderMedia } | null = null

export function grantRecorderMedia(contents: WebContents, media: RecorderMedia): void {
  recorder = { contents, media }
}

export function revokeRecorderMedia(contents: WebContents): void {
  if (recorder?.contents === contents) recorder = null
}

export interface PermissionAsk {
  contents: WebContents | null
  permission: string
  mediaTypes?: string[]
  mainFrame?: boolean
}

// Every permission is refused except media, for the recorder window, and only the kinds this recording uses
export function allowPermission({ contents, permission, mediaTypes = [], mainFrame = true }: PermissionAsk): boolean {
  if (permission !== 'media' || !mainFrame || !recorder || contents !== recorder.contents) return false
  const { audio, video } = recorder.media
  return mediaTypes.every((type) => (type === 'audio' && audio) || (type === 'video' && video) || (type === 'unknown' && (audio || video)))
}

// A second launch brings the first back. Not while recording though, as the window has to stay out of the shot
export function focusExisting(win: BrowserWindow | null, recording: boolean, create: () => void): void {
  if (recording) return
  if (!win) return create()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// The packaged menu. Electron's default has Reload and Toggle Developer Tools, and Windows needs no menu at all
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  return platform === 'darwin' ? [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }] : null
}
