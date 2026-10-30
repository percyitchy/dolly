// M2, M3, L2, L4: the rules every window lives under.

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true } }))

import type { BrowserWindow, WebContents } from 'electron'
import { allowPermission, appMenuTemplate, focusExisting, grantRecorderMedia, guardContents, revokeRecorderMedia, secureWebPreferences } from '../src/main/window-guard'
import { blockFileDrops } from '../src/renderer/no-file-drop'

const contents = (): WebContents => ({}) as WebContents

describe('permissions', () => {
  const recorder = contents()
  const other = contents()
  const media = (who: WebContents | null, mediaTypes?: string[], mainFrame = true) => allowPermission({ contents: who, permission: 'media', mediaTypes, mainFrame })

  it('refuses media with no recording under way', () => {
    expect(media(recorder, ['audio'])).toBe(false)
  })

  it('allows media only for the registered recorder window', () => {
    grantRecorderMedia(recorder, { audio: true, video: true })
    expect(media(recorder, ['audio', 'video'])).toBe(true)
    expect(media(other, ['audio'])).toBe(false)
    expect(media(null, ['audio'])).toBe(false)
    revokeRecorderMedia(recorder)
  })

  it('allows only the kinds this recording uses', () => {
    grantRecorderMedia(recorder, { audio: true, video: false })
    expect(media(recorder, ['audio'])).toBe(true)
    expect(media(recorder, ['video'])).toBe(false)
    expect(media(recorder, ['audio', 'video'])).toBe(false)
    expect(media(recorder, ['unknown'])).toBe(true)
    revokeRecorderMedia(recorder)
  })

  it('refuses a sub-frame, even in the recorder', () => {
    grantRecorderMedia(recorder, { audio: true, video: true })
    expect(media(recorder, ['audio'], false)).toBe(false)
    revokeRecorderMedia(recorder)
  })

  it.each(['notifications', 'geolocation', 'clipboard-read', 'display-capture', 'fullscreen', 'midi', 'unknown'])('refuses %s for everyone', (permission) => {
    grantRecorderMedia(recorder, { audio: true, video: true })
    expect(allowPermission({ contents: recorder, permission })).toBe(false)
    expect(allowPermission({ contents: other, permission })).toBe(false)
    revokeRecorderMedia(recorder)
  })

  it('revokes for the window that held it, and no other', () => {
    grantRecorderMedia(recorder, { audio: true, video: false })
    revokeRecorderMedia(other)
    expect(media(recorder, ['audio'])).toBe(true)
    revokeRecorderMedia(recorder)
    expect(media(recorder, ['audio'])).toBe(false)
  })
})

describe('guardContents', () => {
  function guarded() {
    const listeners = new Map<string, (event: { url?: string; preventDefault(): void }) => void>()
    const setWindowOpenHandler = vi.fn()
    const getURL = () => 'file:///App/out/renderer/index.html'
    guardContents({ getURL, setWindowOpenHandler, on: (name: string, listener: never) => listeners.set(name, listener) } as unknown as WebContents)
    return { listeners, setWindowOpenHandler }
  }

  it.each(['will-navigate', 'will-frame-navigate', 'will-attach-webview'])('stops %s to anywhere else', (name) => {
    const preventDefault = vi.fn()
    guarded().listeners.get(name)?.({ url: 'file:///Users/a/Downloads/dropped.html', preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it.each(['will-navigate', 'will-frame-navigate'])('lets %s reload the same page', (name) => {
    const preventDefault = vi.fn()
    guarded().listeners.get(name)?.({ url: 'file:///App/out/renderer/index.html', preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('denies new windows', () => {
    const { setWindowOpenHandler } = guarded()
    expect(setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
  })
})

describe('secureWebPreferences', () => {
  it('turns devTools off in a packaged build and keeps the sandbox on', () => {
    expect(secureWebPreferences('index')).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false })
  })

  it.each(['index', 'recorder', 'export'] as const)('gives the %s window its own preload', (name) => {
    expect(secureWebPreferences(name).preload).toMatch(new RegExp(`preload[\\\\/]${name}\\.cjs$`))
  })

  it('takes extras without losing the rest', () => {
    expect(secureWebPreferences('export', { backgroundThrottling: false })).toMatchObject({ backgroundThrottling: false, sandbox: true })
  })
})

describe('second launch', () => {
  const window = (minimized = false) => ({ isMinimized: () => minimized, restore: vi.fn(), show: vi.fn(), focus: vi.fn() })
  const as = (win: ReturnType<typeof window>) => win as unknown as BrowserWindow

  it('brings the window back', () => {
    const win = window(true)
    focusExisting(as(win), false, vi.fn())
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('opens a window when there is none', () => {
    const create = vi.fn()
    focusExisting(null, false, create)
    expect(create).toHaveBeenCalledOnce()
  })

  it('stays hidden while recording', () => {
    const win = window()
    const create = vi.fn()
    focusExisting(as(win), true, create)
    focusExisting(null, true, create)
    expect(win.show).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('application menu', () => {
  it('has no reload or devtools on macOS', () => {
    const roles = appMenuTemplate('darwin')?.map((item) => item.role)
    expect(roles).toEqual(['appMenu', 'editMenu', 'windowMenu'])
  })

  it('is empty on Windows', () => {
    expect(appMenuTemplate('win32')).toBeNull()
  })
})

describe('file drops', () => {
  it('stops the browser opening a dropped file', () => {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
    blockFileDrops({ addEventListener: (type: string, listener: never) => listeners.set(type, listener) } as never)
    for (const type of ['dragover', 'drop']) {
      const preventDefault = vi.fn()
      listeners.get(type)?.({ preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
  })
})
