// M13, L10: every invoke channel answers the main window only, the hidden windows get narrow preloads,
// and quitting leaves no export temp files behind.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  quit: [] as (() => void)[]
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => tmpdir(),
    on: (name: string, listener: () => void) => name === 'will-quit' && h.quit.push(listener),
    commandLine: { appendSwitch: vi.fn() }
  },
  BrowserWindow: vi.fn(),
  dialog: {},
  globalShortcut: {},
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, handler), on: vi.fn() },
  MessageChannelMain: vi.fn(),
  Menu: {},
  nativeImage: {},
  net: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  screen: { getAllDisplays: () => [] },
  session: {},
  shell: {},
  systemPreferences: {},
  Tray: vi.fn()
}))
vi.mock('ffmpeg-static', () => ({ default: 'ffmpeg' }))

const capture = await import('../src/main/capture')
const projects = await import('../src/main/projects')
const exporter = await import('../src/main/export')
const captions = await import('../src/main/captions')
const license = await import('../src/main/license')

const mainContents = { id: 'main' }
const ctx = { mainWindow: () => ({ webContents: mainContents }) as never, send: () => {} }
for (const module of [capture, projects, exporter, captions, license]) module.register(ctx)

const srcRoot = fileURLToPath(new URL('../src', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

const preload = (name: string) => readFileSync(join(srcRoot, 'preload', `${name}.ts`), 'utf8')

describe('invoke channels', () => {
  const invoked = [...preload('index').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1])

  it('covers every channel the main preload calls', () => {
    expect(invoked.length).toBeGreaterThan(15)
    expect([...h.handlers.keys()].sort()).toEqual([...invoked].sort())
  })

  it.each([...h.handlers.keys()])('%s refuses a hidden window', async (channel) => {
    const call = async () => h.handlers.get(channel)?.({ sender: { id: 'recorder' } })
    await expect(call()).rejects.toThrow('Not allowed from this window')
  })

  it.each([...h.handlers.keys()])('%s refuses everyone once the main window is gone', async (channel) => {
    const closed = new Map(h.handlers)
    h.handlers.clear()
    capture.register({ ...ctx, mainWindow: () => null })
    projects.register({ ...ctx, mainWindow: () => null })
    exporter.register({ ...ctx, mainWindow: () => null })
    captions.register({ ...ctx, mainWindow: () => null })
    license.register({ ...ctx, mainWindow: () => null })
    const call = async () => h.handlers.get(channel)?.({ sender: mainContents })
    await expect(call()).rejects.toThrow('Not allowed from this window')
    h.handlers.clear()
    closed.forEach((handler, name) => h.handlers.set(name, handler))
  })

  it('answers the main window', async () => {
    expect(await h.handlers.get('capture:displays')?.({ sender: mainContents })).toEqual([])
    expect(await h.handlers.get('license:status')?.({ sender: mainContents })).toEqual({ plan: 'free' })
  })

  it('never registers a handler around the check', () => {
    const direct = sources(join(srcRoot, 'main')).filter((path) => /ipcMain\.handle\(/.test(readFileSync(path, 'utf8')))
    expect(direct.map((path) => basename(path))).toEqual(['context.ts'])
  })
})

describe('preloads', () => {
  it('gives the recorder window only its three calls', () => {
    const code = preload('recorder')
    expect(code).toMatch(/exposeInMainWorld\('dollyRecorder'/)
    expect(code).not.toMatch(/ipcRenderer\.invoke|exposeInMainWorld\('dolly'/)
    expect([...code.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])).toEqual(['onCommand', 'report', 'chunk'])
  })

  it('gives the export window no API at all', () => {
    const code = preload('export')
    expect(code).not.toMatch(/contextBridge|ipcRenderer\.(invoke|send)/)
  })

  it('keeps the hidden windows out of the main preload', () => {
    const code = preload('index')
    expect(code).not.toMatch(/recorder|exportPort/i)
  })

  it('sends each window its own preload', () => {
    const file = (name: string) => readFileSync(join(srcRoot, 'main', name), 'utf8')
    expect(file('capture.ts')).toMatch(/secureWebPreferences\('recorder'/)
    expect(file('export.ts')).toMatch(/secureWebPreferences\('export'/)
    expect(file('index.ts')).toMatch(/secureWebPreferences\('index'/)
  })

  it.each(['index', 'recorder', 'export'])('builds %s as one file, since a sandboxed preload cannot require a sibling', (name) => {
    const built = fileURLToPath(new URL(`../out/preload/${name}.cjs`, import.meta.url))
    if (!existsSync(built)) return // Only there after a build
    const required = [...readFileSync(built, 'utf8').matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1])
    expect(new Set(required)).toEqual(new Set(['electron']))
  })
})

describe('quitting mid-export', () => {
  it('deletes the temp files before the process goes', () => {
    const folder = mkdtempSync(join(tmpdir(), 'dolly-quit-'))
    const temps = ['a.part', 'a.lossless', 'a.palette'].map((name) => join(folder, name))
    temps.forEach((path) => writeFileSync(path, 'x'))
    const kept = join(folder, 'finished.mp4')
    writeFileSync(kept, 'x')
    const release = exporter.trackTemps(temps)
    h.quit.forEach((listener) => listener())
    expect(readdirSync(folder)).toEqual(['finished.mp4'])
    release()
    rmSync(folder, { recursive: true, force: true })
  })

  it('leaves files alone once the job has let them go', () => {
    const folder = mkdtempSync(join(tmpdir(), 'dolly-quit-'))
    const path = join(folder, 'a.part')
    writeFileSync(path, 'x')
    exporter.trackTemps([path])()
    h.quit.forEach((listener) => listener())
    expect(existsSync(path)).toBe(true)
    rmSync(folder, { recursive: true, force: true })
  })
})
