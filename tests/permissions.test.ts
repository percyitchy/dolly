// L13: Windows reports not-determined and has no prompt to raise, so Allow has to try the device.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Done = (error: Error | null, stdout: string) => void

const h = vi.hoisted(() => ({
  status: 'not-determined',
  ask: vi.fn(async () => true),
  trusted: vi.fn(() => false),
  helper: vi.fn((_bin: string, _args: string[], _options: unknown, _done: Done) => {})
}))

vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), execFile: h.helper }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo' },
  shell: {},
  systemPreferences: { getMediaAccessStatus: () => h.status, askForMediaAccess: h.ask, isTrustedAccessibilityClient: h.trusted }
}))
vi.mock('ffmpeg-static', () => ({ default: 'ffmpeg' }))

const platform = process.platform

async function permissions() {
  vi.resetModules()
  return import('../src/main/permissions')
}

beforeEach(() => {
  h.status = 'not-determined'
  h.ask.mockClear()
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

describe('Allow on Windows', () => {
  it('tries the device and unblocks Record when that works', async () => {
    const { permissionStatus, requestPermission } = await permissions()
    const probe = vi.fn(async () => true)
    expect(await permissionStatus('microphone')).toBe('not-determined')
    expect(await requestPermission('microphone', probe)).toBe('granted')
    expect(probe).toHaveBeenCalledExactlyOnceWith('microphone')
    expect(await permissionStatus('microphone')).toBe('granted')
    expect(await permissionStatus('camera')).toBe('not-determined')
  })

  it('reports denied when the device refuses, so the row offers Settings', async () => {
    const { requestPermission } = await permissions()
    expect(await requestPermission('camera', async () => false)).toBe('denied')
  })

  it('believes the OS once it gives a real answer', async () => {
    const { permissionStatus, requestPermission } = await permissions()
    await requestPermission('microphone', async () => false)
    h.status = 'granted'
    expect(await permissionStatus('microphone')).toBe('granted')
  })

  it('does not try a device the OS has already ruled on', async () => {
    const { requestPermission } = await permissions()
    const probe = vi.fn(async () => true)
    h.status = 'denied'
    expect(await requestPermission('microphone', probe)).toBe('denied')
    h.status = 'granted'
    expect(await requestPermission('microphone', probe)).toBe('granted')
    expect(probe).not.toHaveBeenCalled()
  })

  it('never calls the macOS prompt', async () => {
    const { requestPermission } = await permissions()
    await requestPermission('microphone', async () => true)
    expect(h.ask).not.toHaveBeenCalled()
  })

  it('leaves screen and input monitoring as not needed', async () => {
    const { requestPermission } = await permissions()
    expect(await requestPermission('screen', async () => true)).toBe('not-needed')
    expect(await requestPermission('input-monitoring', async () => true)).toBe('not-needed')
  })
})

describe('Allow on macOS', () => {
  it('still uses the system prompt and never the probe', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { requestPermission } = await permissions()
    const probe = vi.fn(async () => true)
    await requestPermission('microphone', probe)
    expect(h.ask).toHaveBeenCalledExactlyOnceWith('microphone')
    expect(probe).not.toHaveBeenCalled()
  })

  it('asks the helper about the mouse, and never touches Accessibility', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { requestPermission, permissionStatus } = await permissions()
    h.helper.mockImplementation((_bin, _args, _options, done) => done(null, JSON.stringify({ type: 'permission', screen: true, mouse: false }) + '\n'))
    expect(await permissionStatus('input-monitoring')).toBe('not-determined')
    h.helper.mockClear()
    expect(await requestPermission('input-monitoring')).toBe('denied')
    expect(h.helper.mock.calls.map((c) => (c[1] as string[])[0])).toEqual(['request-mouse-permission', 'permission'])

    h.helper.mockImplementation((_bin, _args, _options, done) => done(null, JSON.stringify({ type: 'permission', screen: true, mouse: true }) + '\n'))
    expect(await permissionStatus('input-monitoring')).toBe('granted')
    expect(h.trusted).not.toHaveBeenCalled()
  })

  it('treats a helper that gives no answer as no permission', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { permissionStatus } = await permissions()
    h.helper.mockImplementation((_bin, _args, _options, done) => done(new Error('gone'), ''))
    expect(await permissionStatus('input-monitoring')).toBe('not-determined')
  })
})
