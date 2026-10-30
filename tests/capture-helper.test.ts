// The helper protocol, against a stand-in program. The real binary is proved separately, since it needs a
// display and Screen Recording permission.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), on: vi.fn() },
  BrowserWindow: vi.fn(),
  dialog: {},
  globalShortcut: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Menu: {},
  nativeImage: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  screen: {},
  shell: {},
  systemPreferences: {},
  Tray: vi.fn()
}))
vi.mock('ffmpeg-static', () => ({ default: 'ffmpeg' }))
vi.mock('../src/main/license', () => ({ currentPlan: () => 'free' }))

const { CaptureHelper, clockOffset } = await import('../src/main/capture')

const FAKE = `
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const mode = process.argv[2]
if (mode === 'refuse') {
  say({ type: 'error', code: 'permission', message: 'Screen Recording permission is not granted' })
  process.exit(1)
}
if (mode === 'parting') {
  // A child that outlives this process holds stdout open, so exit fires well before the last line arrives
  const { spawn } = await import('node:child_process')
  const line = JSON.stringify({ type: 'stopped', reason: 'interrupted', durationMs: 500, frames: 30, repeats: 0, dropped: 0 })
  spawn(process.execPath, ['-e', 'setTimeout(() => console.log(' + JSON.stringify(line) + '), 150)'], { stdio: ['ignore', 'inherit', 'ignore'] })
  process.exit(0)
}
if (mode === 'tap') {
  say({ type: 'ready', width: 100, height: 50, fps: 60, scaleFactor: 2, hostMs: 1, mouseTap: 'listening', listenAccess: true })
  say({ type: 'tapLost' })
  say({ type: 'stopped', reason: 'write-failed', durationMs: 4000, frames: 240, repeats: 0, dropped: 0, tapEvents: 12, mouseTap: 'lost' })
  process.exit(0)
}
if (mode === 'crash') {
  say({ type: 'ready', width: 100, height: 50, fps: 60, scaleFactor: 2, hostMs: 1 })
  say({ type: 'firstFrame', hostMs: 5000 })
  setTimeout(() => process.exit(9), 20)
} else if (mode !== 'parting') {
  // Lines can arrive split across reads
  const line = JSON.stringify({ type: 'ready', width: 100, height: 50, fps: 60, scaleFactor: 2, hostMs: 1 })
  process.stdout.write(line.slice(0, 10))
  setTimeout(() => process.stdout.write(line.slice(10) + '\\nnot json\\n'), 10)
}
let text = ''
process.stdin.on('data', (d) => {
  text += d
  while (text.includes('\\n')) {
    const at = text.indexOf('\\n')
    const command = text.slice(0, at)
    text = text.slice(at + 1)
    if (command === 'ping') {
      say({ type: 'pong', hostMs: 1000 + Number(process.hrtime.bigint()) / 1e6 })
      say({ type: 'firstFrame', hostMs: 5000 })
    }
    if (command === 'stop') {
      say({ type: 'stopped', reason: 'requested', durationMs: 1234, frames: 74, repeats: 0, dropped: 0 })
      process.exit(0)
    }
  }
})
`

describe('CaptureHelper', () => {
  let dir: string
  let script: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dolly-helper-'))
    script = join(dir, 'fake.mjs')
    await writeFile(script, FAKE)
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('walks through ready, the clock sync, the first frame and stop', async () => {
    const helper = new CaptureHelper(process.execPath, [script, 'normal'])
    await expect(helper.ready).resolves.toMatchObject({ width: 100, height: 50, fps: 60, scaleFactor: 2 })
    const samples = [await helper.ping(), await helper.ping(), await helper.ping()]
    expect(samples.every((s) => s.receivedMs >= s.sentMs)).toBe(true)
    // Both clocks are hrtime in this test, so the offset is the 1000 the stand-in adds
    expect(clockOffset(samples)).toBeGreaterThan(900)
    expect(clockOffset(samples)).toBeLessThan(1100)
    await expect(helper.firstFrame).resolves.toBe(5000)
    helper.stop()
    await expect(helper.stopped).resolves.toMatchObject({ durationMs: 1234, frames: 74 })
  })

  it('passes on what the helper said when it refuses to start', async () => {
    const helper = new CaptureHelper(process.execPath, [script, 'refuse'])
    await expect(helper.ready).rejects.toThrow('Screen Recording permission is not granted')
    await expect(helper.firstFrame).rejects.toThrow()
    await expect(helper.stopped).rejects.toThrow()
  })

  it('reports a crash mid-recording, without touching what already resolved', async () => {
    const helper = new CaptureHelper(process.execPath, [script, 'crash'])
    await expect(helper.firstFrame).resolves.toBe(5000)
    await expect(helper.stopped).rejects.toThrow('stopped unexpectedly')
  })

  // The stand-in leaves a grandchild holding stdout, and a Windows pipe doesn't outlive its writer that way
  it.skipIf(process.platform === 'win32')('reads the last lines even when the helper exits right after them', async () => {
    const helper = new CaptureHelper(process.execPath, [script, 'parting'])
    await expect(helper.stopped).resolves.toMatchObject({ reason: 'interrupted', durationMs: 500 })
  })

  it('passes on the mouse tap state, losing it and its final count', async () => {
    const helper = new CaptureHelper(process.execPath, [script, 'tap'])
    await expect(helper.ready).resolves.toMatchObject({ mouseTap: 'listening', listenAccess: true })
    await expect(helper.tapLost).resolves.toBeUndefined()
    await expect(helper.stopped).resolves.toMatchObject({ reason: 'write-failed', tapEvents: 12, mouseTap: 'lost' })
  })

  it('never reports the tap lost on a helper that simply died', async () => {
    const helper = new CaptureHelper(process.execPath, [script, 'refuse'])
    const lost = vi.fn()
    helper.tapLost.then(lost, () => {})
    await expect(helper.stopped).rejects.toThrow()
    await Promise.resolve()
    expect(lost).not.toHaveBeenCalled()
  })

  it('reports a missing binary', async () => {
    const helper = new CaptureHelper(join(dir, 'no-such-program'), [])
    await expect(helper.ready).rejects.toThrow("Couldn't start the capture helper")
  })

  it('survives stop after the helper has already gone', async () => {
    const helper = new CaptureHelper(process.execPath, [script, 'refuse'])
    await expect(helper.stopped).rejects.toThrow()
    expect(() => helper.stop()).not.toThrow()
  })
})
