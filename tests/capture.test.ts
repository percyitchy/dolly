import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_DEFAULTS, outputSize, type CursorEvent, type Project } from '../src/shared/project'

const uiohook = vi.hoisted(() => ({
  loads: 0,
  hook: { on: () => {}, off: () => {}, start: () => {}, stop: () => {} }
}))

const disk = vi.hoisted(() => ({ failRename: false }))

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: (from: string, to: string) => (disk.failRename ? Promise.reject(new Error('ENOSPC')) : real.rename(from, to))
  }
})
vi.mock('uiohook-napi', () => {
  uiohook.loads += 1
  return { uIOhook: uiohook.hook }
})
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir(), on: vi.fn() },
  BrowserWindow: vi.fn(),
  dialog: {},
  globalShortcut: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Menu: {},
  nativeImage: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  safeStorage: {},
  screen: {},
  session: {},
  shell: {},
  systemPreferences: {},
  Tray: vi.fn()
}))
vi.mock('ffmpeg-static', () => ({ default: 'ffmpeg' }))
vi.mock('../src/main/license', () => ({ currentPlan: () => 'free' }))

const {
  buttonName,
  clickPoints,
  convertEvent,
  displayMapFor,
  dropClicksFrom,
  InputLog,
  isOnDisplay,
  mouseSourceFor,
  parseTapLog,
  toClip
} = await import('../src/main/input')
const {
  assertProject,
  checkProjectDir,
  checkRelativeFile,
  contentTypeFor,
  createProjectDir,
  importBackground,
  isInside,
  listProjects,
  mediaFromUrl,
  mediaUrlFor,
  openProject,
  parseCursorLog,
  parseRange,
  realProjectDir,
  realProjectFile,
  sanitizeName,
  saveProject,
  serveFile,
  writeJsonAtomic
} = await import('../src/main/projects')
const { mapBooleanStatus, mapMediaStatus, needsPermission, settingsUrl } = await import('../src/main/permissions')
const {
  buildProject,
  checkFreeSpace,
  checkOptions,
  cleanUp,
  clicksWarning,
  clockOffset,
  defaultProjectName,
  freeBytes,
  importantBytes,
  MIN_FREE_TO_CONTINUE,
  MIN_FREE_TO_START,
  mouseLogArgs,
  parseDuration,
  parseHelperLine,
  readyWarnings,
  savedMs,
  stopWarnings,
  trayEndMs,
  watchFreeSpace
} = await import('../src/main/capture')

const { buildZooms } = await import('../src/engine/zoom')
const { buildCursorTrack } = await import('../src/engine/cursor')
const { compose } = await import('../src/shared/compose')

const macDisplay = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 }
const macMap = displayMapFor(macDisplay, { width: 3024, height: 1964 }, 'darwin')

function sampleProject(): Project {
  return buildProject({
    id: 'p1',
    name: 'Demo',
    createdAt: '2026-10-30T10:00:00.000Z',
    durationMs: 5000,
    screen: { file: 'screen.mp4', width: 3024, height: 1964, fps: 60, scaleFactor: 2 },
    media: [],
    zooms: [],
    folder: '/tmp/out'
  })
}

describe('input conversion', () => {
  it('turns macOS points into clip pixels', () => {
    expect(toClip(100, 50, macMap)).toEqual({ x: 200, y: 100 })
  })

  it('uses the display origin on a second macOS monitor to the left', () => {
    const map = displayMapFor(
      { bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 },
      { width: 1920, height: 1080 },
      'darwin'
    )
    expect(toClip(-1920, -200, map)).toEqual({ x: 0, y: 0 })
    expect(toClip(-960, 340, map)).toEqual({ x: 960, y: 540 })
    expect(isOnDisplay(10, 10, map)).toBe(false)
  })

  it('treats Windows hook coordinates as physical pixels', () => {
    const map = displayMapFor(
      { bounds: { x: 1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
      { width: 1920, height: 1080 },
      'win32',
      { x: 2560, y: 0 }
    )
    expect(map).toMatchObject({ originX: 2560, originY: 0, width: 1920, height: 1080 })
    expect(toClip(2560 + 960, 540, map)).toEqual({ x: 960, y: 540 })
  })

  it('accounts for a clip scaled below the native size', () => {
    const map = displayMapFor(macDisplay, { width: 1512, height: 982 }, 'darwin')
    expect(toClip(756, 491, map)).toEqual({ x: 756, y: 491 })
  })

  it('drops moves and presses off the display but clamps a release whose press was logged', () => {
    expect(convertEvent({ kind: 'move', x: 2000, y: 10 }, macMap, 110, 100)).toBeNull()
    expect(convertEvent({ kind: 'down', x: 2000, y: 10, button: 1 }, macMap, 110, 100)).toBeNull()
    const held = new Set<unknown>()
    expect(convertEvent({ kind: 'down', x: 10, y: 10, button: 2 }, macMap, 105, 100, held)).not.toBeNull()
    expect(convertEvent({ kind: 'up', x: -5, y: 5000, button: 2 }, macMap, 110, 100, held)).toMatchObject({ x: 0, y: 1963, button: 'right' })
  })

  it('logs no release when the press and release were both off the display', () => {
    const held = new Set<unknown>()
    expect(convertEvent({ kind: 'down', x: 2000, y: 10, button: 1 }, macMap, 105, 100, held)).toBeNull()
    expect(convertEvent({ kind: 'up', x: 2000, y: 10, button: 1 }, macMap, 110, 100, held)).toBeNull()
  })

  it('keeps a release on the display even with no logged press', () => {
    const held = new Set<unknown>()
    expect(convertEvent({ kind: 'down', x: 2000, y: 10, button: 1 }, macMap, 105, 100, held)).toBeNull()
    expect(convertEvent({ kind: 'up', x: 50, y: 60, button: 1 }, macMap, 110, 100, held)).toMatchObject({ kind: 'up', x: 100, y: 120 })
  })

  it('tracks each button on its own, and a press only ends once', () => {
    const held = new Set<unknown>()
    convertEvent({ kind: 'down', x: 10, y: 10, button: 1 }, macMap, 105, 100, held)
    expect(convertEvent({ kind: 'up', x: 2000, y: 10, button: 2 }, macMap, 110, 100, held)).toBeNull()
    expect(convertEvent({ kind: 'up', x: 2000, y: 10, button: 1 }, macMap, 110, 100, held)).not.toBeNull()
    expect(convertEvent({ kind: 'up', x: 2000, y: 10, button: 1 }, macMap, 115, 100, held)).toBeNull()
  })

  it('makes no zoom from a press on another display', () => {
    const press = convertEvent({ kind: 'down', x: 2000, y: 10, button: 1 }, macMap, 110, 100)
    expect(clickPoints(press ? [press] : [], 5000)).toEqual([])
    const here = convertEvent({ kind: 'down', x: 100, y: 10, button: 1 }, macMap, 110, 100)
    expect(clickPoints(here ? [here] : [], 5000)).toEqual([{ t: 10, x: 200, y: 20 }])
  })

  it('counts the right and bottom edges as off the display', () => {
    expect(isOnDisplay(1511, 981, macMap)).toBe(true)
    expect(isOnDisplay(1512, 500, macMap)).toBe(false)
    expect(isOnDisplay(500, 982, macMap)).toBe(false)
  })

  it('stamps time from the origin and drops anything before it', () => {
    expect(convertEvent({ kind: 'move', x: 1, y: 1 }, macMap, 99, 100)).toBeNull()
    expect(convertEvent({ kind: 'move', x: 1, y: 1 }, macMap, 1100.126, 100)?.t).toBe(1000.13)
  })

  it('never puts a button on a move, and leaves unknown buttons off', () => {
    expect(convertEvent({ kind: 'move', x: 1, y: 1, button: 1 }, macMap, 110, 100)).not.toHaveProperty('button')
    expect(convertEvent({ kind: 'down', x: 1, y: 1, button: 9 }, macMap, 110, 100)).not.toHaveProperty('button')
    expect([buttonName(1), buttonName(2), buttonName(3), buttonName(0)]).toEqual(['left', 'right', 'middle', undefined])
  })
})

describe('the macOS mouse log', () => {
  const host = 500000 // firstFrame.hostMs. The tap's clock has nothing to do with main's
  const line = (ms: number, k: string, x: number, y: number, b?: number) =>
    JSON.stringify({ h: host + ms, k, x, y, ...(b === undefined ? {} : { b }) })

  let dir: string
  let file: string
  let tapFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dolly-tap-'))
    file = join(dir, 'cursor.jsonl')
    tapFile = join(dir, 'mouse.jsonl')
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  function log(listening: boolean, cursorPoint = () => ({ x: 10, y: 20 })) {
    return new InputLog({ file, map: macMap, now: () => 110, cursorPoint, source: { kind: 'tap', file: tapFile, listening } })
  }

  it('picks the tap on macOS and the hook everywhere else', () => {
    expect(mouseSourceFor('darwin', tapFile, { mouseTap: 'listening' })).toEqual({ kind: 'tap', file: tapFile, listening: true })
    expect(mouseSourceFor('darwin', tapFile, { mouseTap: 'disabled' })).toMatchObject({ listening: false })
    expect(mouseSourceFor('darwin', tapFile, { mouseTap: 'unavailable' })).toMatchObject({ listening: false })
    expect(mouseSourceFor('darwin', tapFile, {})).toMatchObject({ listening: false })
    expect(mouseSourceFor('win32', tapFile, {})).toEqual({ kind: 'hook' })
  })

  it('picks neither when the recording wants no clicks', () => {
    expect(mouseSourceFor('darwin', tapFile, { mouseTap: 'listening' }, false)).toEqual({ kind: 'poll' })
    expect(mouseSourceFor('win32', tapFile, {}, false)).toEqual({ kind: 'poll' })
  })

  it('only opens the tap when clicks are on and Input Monitoring is granted', () => {
    expect(mouseLogArgs(tapFile, true, 'darwin', 'granted')).toEqual(['--mouse-log', tapFile])
    expect(mouseLogArgs(tapFile, false, 'darwin', 'granted')).toEqual([])
    expect(mouseLogArgs(tapFile, true, 'darwin', 'denied')).toEqual([])
    expect(mouseLogArgs(tapFile, true, 'darwin', 'not-determined')).toEqual([])
    expect(mouseLogArgs(tapFile, true, 'win32', 'not-needed')).toEqual([])
  })

  it('polls with no tap, leaves no mouse log behind and loads no hook', async () => {
    vi.useFakeTimers()
    uiohook.loads = 0
    let point = { x: 10, y: 10 }
    const input = new InputLog({ file, map: macMap, now: () => 110, cursorPoint: () => point, source: { kind: 'poll' } })
    expect(await input.start()).toBe(false)
    input.setOrigin(100, host)
    point = { x: 20, y: 20 }
    vi.advanceTimersByTime(20)
    vi.useRealTimers()
    await input.stop()
    expect(parseCursorLog(await readFile(file, 'utf8')).map((e) => e.x)).toEqual([20, 40])
    expect(await readdir(dir)).toEqual(['cursor.jsonl'])
    expect(uiohook.loads).toBe(0)
  })

  it('converts points to clip pixels on the capture clock', () => {
    const events = parseTapLog([line(-5, 'm', 1, 1), line(250, 'd', 50, 60, 1), line(300, 'u', 50, 60, 1), line(310, 'm', 50.5, 60)].join('\n'), macMap, host)
    expect(events).toEqual([
      { t: 250, x: 100, y: 120, kind: 'down', button: 'left' },
      { t: 300, x: 100, y: 120, kind: 'up', button: 'left' },
      { t: 310, x: 101, y: 120, kind: 'move' }
    ])
  })

  it('applies the same display rule as the hook', () => {
    const text = [
      line(10, 'm', 2000, 10),
      line(20, 'd', 2000, 10, 1),
      line(30, 'u', 2000, 10, 1), // Stray: pressed and released on another display
      line(40, 'd', 100, 100, 2),
      line(50, 'u', 2000, 100, 2) // A drag off the edge, which still has to end
    ].join('\n')
    expect(parseTapLog(text, macMap, host)).toEqual([
      { t: 40, x: 200, y: 200, kind: 'down', button: 'right' },
      { t: 50, x: 3023, y: 200, kind: 'up', button: 'right' }
    ])
  })

  it('names the middle button and leaves side buttons unnamed', () => {
    const events = parseTapLog([line(1, 'd', 5, 5, 3), line(2, 'd', 5, 5, 4)].join('\n'), macMap, host)
    expect(events[0].button).toBe('middle')
    expect(events[1]).not.toHaveProperty('button')
  })

  it('skips a line cut short and anything that is not an event', () => {
    const text = [line(10, 'm', 5, 5), '{"h":5000', '{"k":"m"}', '{"h":"x","k":"m","x":1,"y":1}', line(20, 'z', 5, 5), 'null', ''].join('\n')
    expect(parseTapLog(text, macMap, host).map((e) => e.t)).toEqual([10])
  })

  it('reads the log into cursor.jsonl at the end, deletes it and counts its clicks', async () => {
    const input = log(true)
    expect(await input.start()).toBe(true)
    input.setOrigin(100, host)
    await writeFile(tapFile, [line(-5, 'm', 1, 1), line(250, 'd', 50, 60, 1), line(300, 'u', 50, 60, 1)].join('\n') + '\n')
    await input.stop()

    expect(parseCursorLog(await readFile(file, 'utf8'))).toEqual([
      { t: 0, x: 20, y: 40, kind: 'move' },
      { t: 250, x: 100, y: 120, kind: 'down', button: 'left' },
      { t: 300, x: 100, y: 120, kind: 'up', button: 'left' }
    ])
    expect(input.clicks.map((e) => e.t)).toEqual([250])
    await expect(readFile(tapFile)).rejects.toThrow()
  })

  it('deletes a log with nothing in it for this display', async () => {
    const input = log(true)
    await input.start()
    input.setOrigin(100, host)
    await writeFile(tapFile, line(-5, 'm', 1, 1) + '\n')
    await input.stop()
    await expect(readFile(tapFile)).rejects.toThrow()
  })

  it('keeps both logs whole when the merge cannot be saved, and still counts the clicks', async () => {
    const input = log(true)
    await input.start()
    input.setOrigin(100, host)
    await writeFile(tapFile, line(250, 'd', 50, 60, 1) + '\n')
    disk.failRename = true
    try {
      await input.stop()
    } finally {
      disk.failRename = false
    }

    expect(parseCursorLog(await readFile(file, 'utf8'))).toEqual([{ t: 0, x: 20, y: 40, kind: 'move' }])
    expect(await readFile(tapFile, 'utf8')).toContain('"k":"d"')
    expect(input.clicks.map((e) => e.t)).toEqual([250])
    expect((await readdir(dir)).sort()).toEqual(['cursor.jsonl', 'mouse.jsonl']) // The temp file went too
  })

  it('still drops tray clicks when the log cannot be rewritten', async () => {
    const input = log(true)
    await input.start()
    input.setOrigin(100, host)
    await writeFile(tapFile, [line(100, 'd', 5, 5, 1), line(900, 'd', 5, 5, 1)].join('\n') + '\n')
    await input.stop()
    disk.failRename = true
    try {
      await expect(input.dropClicksFrom(500)).resolves.toBeUndefined()
    } finally {
      disk.failRename = false
    }
    expect(input.clicks.map((e) => e.t)).toEqual([100])
    expect(parseCursorLog(await readFile(file, 'utf8')).filter((e) => e.kind === 'down')).toHaveLength(2)
  })

  it('takes tray clicks back out after the log is merged', async () => {
    const input = log(true)
    await input.start()
    input.setOrigin(100, host)
    await writeFile(tapFile, [line(100, 'd', 5, 5, 1), line(900, 'd', 5, 5, 1)].join('\n') + '\n')
    await input.stop()
    await input.dropClicksFrom(500)
    expect(input.clicks.map((e) => e.t)).toEqual([100])
    expect(parseCursorLog(await readFile(file, 'utf8')).filter((e) => e.kind === 'down')).toHaveLength(1)
  })

  it('polls and reports no clicks when the tap never came up, and copes with no log', async () => {
    vi.useFakeTimers()
    let point = { x: 10, y: 10 }
    const input = log(false, () => point)
    expect(await input.start()).toBe(false)
    input.setOrigin(100, host)
    point = { x: 20, y: 20 }
    vi.advanceTimersByTime(20)
    vi.useRealTimers()
    await input.stop()
    expect(parseCursorLog(await readFile(file, 'utf8')).map((e) => [e.t, e.x, e.kind])).toEqual([
      [0, 20, 'move'],
      [10, 40, 'move']
    ])
  })

  it('starts polling once when the tap goes quiet, and merges both by time', async () => {
    vi.useFakeTimers()
    let point = { x: 10, y: 10 }
    const input = log(true, () => point)
    await input.start()
    input.setOrigin(100, host)
    point = { x: 15, y: 15 }
    vi.advanceTimersByTime(100) // Nothing polled while the tap is fine, or the 15 would show up below

    input.tapLost()
    input.tapLost()
    point = { x: 20, y: 20 }
    vi.advanceTimersByTime(20)
    vi.useRealTimers()
    await writeFile(tapFile, [line(5, 'd', 3, 3, 1), line(40, 'm', 4, 4)].join('\n') + '\n')
    await input.stop()

    const events = parseCursorLog(await readFile(file, 'utf8'))
    expect(events.map((e) => e.t)).toEqual([0, 5, 10, 40])
    expect(input.clicks).toHaveLength(1)
  })

  it('stops polling when the recording stops, even if the tap reported late', async () => {
    const input = log(true)
    await input.start()
    await input.stop()
    input.tapLost()
    await expect(input.stop()).resolves.toBeUndefined()
  })

  it('never loads uiohook-napi for the tap, but does for the hook', async () => {
    uiohook.loads = 0
    const input = log(true)
    await input.start()
    input.setOrigin(100, host)
    input.tapLost()
    await input.stop()
    expect(uiohook.loads).toBe(0)

    // The positive control: the same check does see a load, so the zero above means something
    vi.resetModules()
    const again = await import('../src/main/input')
    const windows = new again.InputLog({ file, map: macMap, now: () => 0, cursorPoint: () => ({ x: 0, y: 0 }), source: { kind: 'hook' } })
    expect(await windows.start()).toBe(true)
    await windows.stop()
    expect(uiohook.loads).toBe(1)
  })
})

describe('the reason a recording stopped', () => {
  it('says nothing when the user stopped it', () => {
    expect(stopWarnings('requested')).toEqual([])
  })

  it('explains a recording cut short', () => {
    expect(stopWarnings('interrupted')).toEqual([expect.stringMatching(/stopped early/)])
  })

  it('names the disk when writing failed', () => {
    expect(stopWarnings('write-failed')).toEqual([expect.stringMatching(/disk is full/)])
  })

  it('says so when a resolution change ended it', () => {
    expect(stopWarnings('interrupted', false, true)).toEqual([expect.stringMatching(/resolution changed/)])
    expect(stopWarnings('interrupted', false, false)).toEqual([expect.stringMatching(/stopped early/)])
    expect(stopWarnings('write-failed', false, true)).toEqual([expect.stringMatching(/disk is full/)])
  })

  it('says the disk was nearly full when Dolly stopped first, whatever the helper saw', () => {
    expect(stopWarnings('requested', true)).toEqual([expect.stringMatching(/nearly full/)])
    expect(stopWarnings('write-failed', true)).toEqual([expect.stringMatching(/nearly full/)])
  })
})

describe('how long the saved video is', () => {
  const stopped = (reason: string) => ({ reason, durationMs: 4000 })

  it('trusts the helper unless a write failed', async () => {
    const probe = vi.fn(async () => 1000)
    await expect(savedMs(stopped('requested'), probe)).resolves.toBe(4000)
    await expect(savedMs(stopped('interrupted'), probe)).resolves.toBe(4000)
    expect(probe).not.toHaveBeenCalled()
  })

  it('asks the file after a failed write, as one that finalized or kept its fragments still plays', async () => {
    await expect(savedMs(stopped('write-failed'), async () => 2000)).resolves.toBe(2000)
  })

  it('says nothing was saved when the file has no length, which is a Windows file with no index', async () => {
    await expect(savedMs(stopped('write-failed'), async () => null)).rejects.toThrow(/can't be played/)
    await expect(savedMs(stopped('write-failed'), async () => 0)).rejects.toThrow(/can't be played/)
  })

  it('never promises a saved recording in that case', async () => {
    const message = await savedMs(stopped('write-failed'), async () => null).catch((error: Error) => error.message)
    expect(message).not.toMatch(/is saved/)
  })
})

describe('a stop from the tray', () => {
  it('ends the video where the menu opened', () => {
    expect(trayEndMs(9000, 7500.126)).toBe(7500.13)
  })

  it('keeps the whole video when the menu time is unknown', () => {
    expect(trayEndMs(9000, null)).toBe(9000)
  })

  it('ignores a cut that would leave almost nothing', () => {
    expect(trayEndMs(9000, 999)).toBe(9000)
    expect(trayEndMs(9000, 0)).toBe(9000)
    expect(trayEndMs(9000, -40)).toBe(9000)
    expect(trayEndMs(9000, 1000)).toBe(1000)
  })

  it('never reaches past the end of the file', () => {
    expect(trayEndMs(3000, 3000)).toBe(3000)
    expect(trayEndMs(3000, 5000)).toBe(3000) // A failed write can leave less than the menu time
  })

  it('trims the project and its screen clip, and leaves a mic clip its real length', () => {
    const durationMs = trayEndMs(9000, 7500)
    const project = buildProject({
      id: 'p',
      name: 'n',
      createdAt: 'now',
      durationMs,
      screen: { file: 'screen.mp4', width: 10, height: 10, fps: 60, scaleFactor: 1 },
      media: [{ kind: 'mic', file: 'mic.webm', startMs: 0, durationMs: 9000 }],
      zooms: buildZooms([{ t: 7400, x: 5, y: 5 }, { t: 7600, x: 5, y: 5 }], durationMs, { width: 10, height: 10 }),
      folder: '/tmp'
    })
    expect(project.durationMs).toBe(7500)
    expect(project.clips.map((c) => [c.kind, c.durationMs])).toEqual([['screen', 7500], ['mic', 9000]])
    expect(project.zooms.flatMap((z) => z.clickMs)).toEqual([7400])
    expect(Math.max(...project.zooms.map((z) => z.endMs))).toBeLessThanOrEqual(7500)
  })
})

describe('what the helper could not set up', () => {
  it('says nothing when Windows hid both, or on macOS where neither is reported', () => {
    expect(readyWarnings({ cursorHidden: true, borderHidden: true })).toEqual([])
    expect(readyWarnings({})).toEqual([])
  })

  it('warns about the real cursor and the yellow border separately', () => {
    expect(readyWarnings({ cursorHidden: false, borderHidden: true })).toEqual([expect.stringMatching(/real cursor/)])
    expect(readyWarnings({ cursorHidden: true, borderHidden: false })).toEqual([expect.stringMatching(/yellow border/)])
    expect(readyWarnings({ cursorHidden: false, borderHidden: false })).toHaveLength(2)
  })

  it('only points at a permission on macOS, where there is one', () => {
    expect(clicksWarning('darwin')).toContain('Allow Input Monitoring')
    expect(clicksWarning('win32')).not.toContain('Allow')
    expect(clicksWarning('darwin')).not.toContain('Accessibility')
  })
})

describe('free disk space', () => {
  const space = (bytes: number) => async () => ({ bavail: bytes / 4096, bsize: 4096 })
  const noHelper = async () => null

  it('multiplies blocks by block size', () => {
    expect(freeBytes({ bavail: 10, bsize: 4096 })).toBe(40960)
  })

  it('refuses to start short of the minimum, in plain words', async () => {
    await expect(checkFreeSpace('/x', space(MIN_FREE_TO_START - 4096), noHelper)).rejects.toThrow(/Free up at least 1 GB/)
    await expect(checkFreeSpace('/x', space(MIN_FREE_TO_START), noHelper)).resolves.toBeUndefined()
  })

  it('counts purgeable space, which only the helper can see', async () => {
    await expect(checkFreeSpace('/x', space(0), async () => MIN_FREE_TO_START)).resolves.toBeUndefined()
    await expect(checkFreeSpace('/x', space(0), async () => MIN_FREE_TO_START - 1)).rejects.toThrow(/Free up at least 1 GB/)
  })

  it('only starts the helper when statfs says there is not enough', async () => {
    const helper = vi.fn(async () => 0)
    await checkFreeSpace('/x', space(MIN_FREE_TO_START), helper)
    expect(helper).not.toHaveBeenCalled()
  })

  it('reads a real disk with statfs', async () => {
    await expect(checkFreeSpace(tmpdir())).resolves.toBeUndefined()
  })

  it('starts anyway when the disk cannot say', async () => {
    await expect(checkFreeSpace('/x', () => Promise.reject(new Error('ENOSYS')), noHelper)).resolves.toBeUndefined()
    await expect(checkFreeSpace(join(tmpdir(), 'no-such-folder-dolly'))).resolves.toBeUndefined()
  })

  it('stops once when space runs low, and leaves room to finish', async () => {
    vi.useFakeTimers()
    let free = MIN_FREE_TO_CONTINUE + 4096
    const low = vi.fn()
    const read = vi.fn(async () => ({ bavail: free / 4096, bsize: 4096 }))
    const end = watchFreeSpace('/x', low, read, 2000, noHelper)

    await vi.advanceTimersByTimeAsync(2000)
    expect(low).not.toHaveBeenCalled()
    free = MIN_FREE_TO_CONTINUE - 4096
    await vi.advanceTimersByTimeAsync(2000)
    expect(low).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10000)
    expect(low).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledTimes(2)
    end()
    vi.useRealTimers()
  })

  it('carries on while purgeable space covers it, and asks one at a time', async () => {
    vi.useFakeTimers()
    const low = vi.fn()
    let answer = (_: number | null) => {}
    const helper = vi.fn(() => new Promise<number | null>((done) => (answer = done)))
    const end = watchFreeSpace('/x', low, space(0), 2000, helper)

    await vi.advanceTimersByTimeAsync(6000)
    expect(helper).toHaveBeenCalledOnce()
    answer(MIN_FREE_TO_CONTINUE)
    await vi.advanceTimersByTimeAsync(2000)
    expect(low).not.toHaveBeenCalled()
    expect(helper).toHaveBeenCalledTimes(2)
    answer(MIN_FREE_TO_CONTINUE - 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(low).toHaveBeenCalledOnce()
    end()
    vi.useRealTimers()
  })

  it('ignores an answer that arrives after the watch ended', async () => {
    vi.useFakeTimers()
    const low = vi.fn()
    let answer = (_: number | null) => {}
    const end = watchFreeSpace('/x', low, space(0), 2000, () => new Promise((done) => (answer = done)))
    await vi.advanceTimersByTimeAsync(2000)
    end()
    answer(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(low).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it.runIf(process.platform === 'darwin' && existsSync('native/bin/darwin-arm64/dolly-capture'))('asks the real helper on macOS', async () => {
    expect(await importantBytes(tmpdir())).toBeGreaterThan(0)
    expect(await importantBytes(join(tmpdir(), 'no-such-folder-dolly'))).toBeNull()
  })

  it('stops watching when told to, and shrugs off a failed read', async () => {
    vi.useFakeTimers()
    const low = vi.fn()
    const read = vi.fn(() => Promise.reject(new Error('EIO')))
    const end = watchFreeSpace('/x', low, read, 2000, noHelper)
    await vi.advanceTimersByTimeAsync(2000)
    expect(low).not.toHaveBeenCalled()
    end()
    await vi.advanceTimersByTimeAsync(10000)
    expect(read).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('leaves more room to start than to carry on', () => {
    expect(MIN_FREE_TO_START).toBeGreaterThan(MIN_FREE_TO_CONTINUE * 2)
  })

  it('reads the length ffmpeg prints', () => {
    expect(parseDuration('  Duration: 00:00:04.00, start: 0.000000, bitrate: 3825 kb/s')).toBe(4000)
    expect(parseDuration('Duration: 01:02:03.50, start')).toBe(3723500)
    expect(parseDuration('Duration: N/A, bitrate: N/A')).toBeNull()
    expect(parseDuration('moov atom not found')).toBeNull()
  })
})

describe('cleaning up a failed start', () => {
  it('runs every step and ends with the last, whatever throws', async () => {
    const ran: string[] = []
    await cleanUp(
      [
        () => ran.push('one'),
        () => {
          throw new Error('sync')
        },
        () => Promise.reject(new Error('async')),
        () => ran.push('four')
      ],
      () => ran.push('show')
    )
    expect(ran).toEqual(['one', 'four', 'show'])
  })
})

describe('click extraction', () => {
  const events: CursorEvent[] = [
    { t: 0, x: 1, y: 1, kind: 'move' },
    { t: 100, x: 2, y: 2, kind: 'down', button: 'left' },
    { t: 150, x: 2, y: 2, kind: 'up', button: 'left' },
    { t: 900, x: 3, y: 3, kind: 'down', button: 'right' },
    { t: 5001, x: 4, y: 4, kind: 'down', button: 'left' }
  ]

  it('keeps left presses inside the recording', () => {
    expect(clickPoints(events, 5000)).toEqual([{ t: 100, x: 2, y: 2 }])
  })

  it('agrees with what the cursor engine calls a click', () => {
    expect(clickPoints(events, 6000)).toEqual(buildCursorTrack(events, CURSOR_DEFAULTS).clicks)
  })

  it('removes presses and releases from the log, but keeps the cursor path', () => {
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n{"broken'
    const kept = parseCursorLog(dropClicksFrom(text, 120))
    expect(kept.map((e) => e.kind)).toEqual(['move', 'down'])
    expect(parseCursorLog(dropClicksFrom(JSON.stringify({ t: 500, x: 1, y: 1, kind: 'move' }), 120))).toHaveLength(1)
  })
})

describe('clicks through the real zoom and cursor engines', () => {
  const clip = { width: 3024, height: 1964 }
  const press = (t: number, x: number, y: number, button: CursorEvent['button'] = 'left'): CursorEvent[] => [
    { t, x, y, kind: 'down', button },
    { t: t + 60, x, y, kind: 'up', button }
  ]
  const events: CursorEvent[] = [
    { t: 0, x: 100, y: 100, kind: 'move' },
    ...press(1000, 300, 400),
    ...press(1500, 900, 400),
    ...press(4000, 1512, 982, 'right'),
    ...press(6000, 2000, 1500),
    { t: 9000, x: 2000, y: 1500, kind: 'move' }
  ]
  const durationMs = 9000
  const zooms = buildZooms(clickPoints(events, durationMs), durationMs, clip)
  const track = buildCursorTrack(events, CURSOR_DEFAULTS)

  it('gives each click group one zoom, and none to a right click', () => {
    expect(zooms.map((z) => z.clickMs)).toEqual([[1000, 1500], [6000]])
    expect(zooms.every((z) => z.origin === 'auto' && !z.edited)).toBe(true)
  })

  it('aims each zoom at its first click, in 0 to 1 across the clip', () => {
    expect(zooms[0].focus.x).toBeCloseTo(300 / clip.width)
    expect(zooms[0].focus.y).toBeCloseTo(400 / clip.height)
  })

  it('leaves every zoom click findable in the track, which compose relies on', () => {
    const known = new Set(track.clicks.map((c) => c.t))
    expect(zooms.flatMap((z) => z.clickMs).every((t) => known.has(t))).toBe(true)
  })

  it('holds a click on the very first and very last moment', () => {
    const edge = [...press(0, 10, 10), ...press(durationMs, 20, 20)]
    expect(buildZooms(clickPoints(edge, durationMs), durationMs, clip).map((z) => z.clickMs)).toEqual([[0], [durationMs]])
  })

  it('makes a project that survives a save and composes a frame', async () => {
    const project = buildProject({
      id: 'p',
      name: 'n',
      createdAt: '2026-10-30T10:00:00.000Z',
      durationMs,
      screen: { file: 'screen.mp4', ...clip, fps: 60, scaleFactor: 2 },
      media: [],
      zooms,
      folder: '/tmp/out'
    })
    const saved = assertProject(JSON.parse(JSON.stringify(project)))
    const atClick = compose(saved, track, '16:9', outputSize('16:9', '1080p'), 1000, { webcam: false, captions: false })
    const atRest = compose(saved, track, '16:9', outputSize('16:9', '1080p'), 8900, { webcam: false, captions: false })
    expect(atClick.zoom).toBeGreaterThan(1.9)
    expect(atRest.zoom).toBe(1)
  })
})

describe('InputLog', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dolly-input-'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  function fakeHook(failOnStart = false) {
    const listeners = new Map<string, (e: { x: number; y: number; button?: unknown }) => void>()
    return {
      listeners,
      on: (name: string, fn: (e: { x: number; y: number; button?: unknown }) => void) => listeners.set(name, fn),
      off: (name: string) => listeners.delete(name),
      start: vi.fn(() => {
        if (failOnStart) throw new Error('UIOHOOK_ERROR_AXAPI_DISABLED')
      }),
      stop: vi.fn()
    }
  }

  it('writes cursor.jsonl on the capture clock, starting from the current position', async () => {
    const file = join(dir, 'cursor.jsonl')
    const hook = fakeHook()
    let clock = 1000
    const log = new InputLog({ file, map: macMap, now: () => clock, cursorPoint: () => ({ x: 10, y: 20 }), source: { kind: 'hook', hook } })
    expect(await log.start()).toBe(true)
    hook.listeners.get('mousemove')!({ x: 1, y: 1 }) // Before t=0, so it's dropped
    log.setOrigin(1000, 0)
    clock = 1250
    hook.listeners.get('mousedown')!({ x: 50, y: 60, button: 1 })
    clock = 1300
    hook.listeners.get('mouseup')!({ x: 50, y: 60, button: 1 })
    await log.stop()

    expect(hook.stop).toHaveBeenCalledOnce()
    expect(hook.listeners.size).toBe(0)
    expect(parseCursorLog(await readFile(file, 'utf8'))).toEqual([
      { t: 0, x: 20, y: 40, kind: 'move' },
      { t: 250, x: 100, y: 120, kind: 'down', button: 'left' },
      { t: 300, x: 100, y: 120, kind: 'up', button: 'left' }
    ])
    expect(log.clicks).toHaveLength(1)
  })

  it('logs no stray release through the hook either', async () => {
    const file = join(dir, 'cursor.jsonl')
    const hook = fakeHook()
    const log = new InputLog({ file, map: macMap, now: () => 1100, cursorPoint: () => ({ x: 10, y: 20 }), source: { kind: 'hook', hook } })
    await log.start()
    log.setOrigin(1000, 0)
    hook.listeners.get('mousedown')!({ x: 2000, y: 10, button: 1 })
    hook.listeners.get('mouseup')!({ x: 2000, y: 10, button: 1 })
    await log.stop()
    expect(parseCursorLog(await readFile(file, 'utf8')).map((e) => e.kind)).toEqual(['move'])
  })

  it('falls back to polling when the hook fails to start', async () => {
    const hook = fakeHook(true)
    const log = new InputLog({ file: join(dir, 'cursor.jsonl'), map: macMap, now: () => 0, cursorPoint: () => ({ x: 0, y: 0 }), source: { kind: 'hook', hook } })
    expect(await log.start()).toBe(false)
    expect(hook.listeners.size).toBe(0)
    await log.stop()
    expect(hook.stop).not.toHaveBeenCalled()
  })

  it('takes tray clicks back out of the log', async () => {
    const file = join(dir, 'cursor.jsonl')
    const hook = fakeHook()
    let clock = 0
    const log = new InputLog({ file, map: macMap, now: () => clock, cursorPoint: () => ({ x: 0, y: 0 }), source: { kind: 'hook', hook } })
    await log.start()
    log.setOrigin(0, 0)
    clock = 100
    hook.listeners.get('mousedown')!({ x: 5, y: 5, button: 1 })
    clock = 900
    hook.listeners.get('mousedown')!({ x: 5, y: 5, button: 1 })
    await log.stop()
    await log.dropClicksFrom(500)
    expect(log.clicks.map((e) => e.t)).toEqual([100])
    expect(parseCursorLog(await readFile(file, 'utf8')).filter((e) => e.kind === 'down')).toHaveLength(1)
  })
})

describe('path checks', () => {
  const root = '/Users/me/Movies/Dolly'

  it('accepts a project folder directly under the root', () => {
    expect(checkProjectDir(root, `${root}/Demo.dolly`)).toBe(`${root}/Demo.dolly`)
    expect(checkProjectDir(root, `${root}/x/../Demo.dolly`)).toBe(`${root}/Demo.dolly`)
  })

  it.each([
    ['a relative path', 'Demo.dolly'],
    ['the root itself', root],
    ['a parent climb', `${root}/../Demo.dolly`],
    ['a nested folder', `${root}/a/Demo.dolly`],
    ['the wrong extension', `${root}/Demo`],
    ['a bare extension', `${root}/.dolly`],
    ['a sibling with the same prefix', `${root}-evil/Demo.dolly`],
    ['a null byte', `${root}/De\0mo.dolly`],
    ['an empty string', ''],
    ['not a string', 42],
    ['undefined', undefined]
  ])('rejects %s', (_label, dir) => {
    expect(() => checkProjectDir(root, dir)).toThrow()
  })

  it('accepts relative project files and normalizes separators', () => {
    expect(checkRelativeFile('screen.mp4')).toBe('screen.mp4')
    expect(checkRelativeFile('backgrounds/a.png')).toBe('backgrounds/a.png')
    expect(checkRelativeFile('backgrounds\\a.png')).toBe('backgrounds/a.png')
  })

  it.each([
    ['a climb', '../secret'],
    ['a climb in the middle', 'a/../../secret'],
    ['a backslash climb', '..\\secret'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows drive', 'C:\\Windows\\win.ini'],
    ['a drive-relative path', 'C:evil'],
    ['a UNC path', '\\\\server\\share'],
    ['a dot segment', './a'],
    ['an empty segment', 'a//b'],
    ['a null byte', 'a\0.png'],
    ['an empty string', ''],
    ['not a string', null]
  ])('rejects %s as a file', (_label, file) => {
    expect(() => checkRelativeFile(file)).toThrow()
  })

  it('tells inside from outside', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(false)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a/b/..c')).toBe(true)
  })
})

describe('names', () => {
  it('cleans what the file system would reject', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a b c d e f g h i j')
    expect(sanitizeName('  hi   there  ', 'x')).toBe('hi there')
    expect(sanitizeName('..\u0000..', 'x')).toBe('x')
    expect(sanitizeName('...hidden...', 'x')).toBe('hidden')
    expect(sanitizeName('', 'fallback')).toBe('fallback')
    expect(sanitizeName(undefined, 'fallback')).toBe('fallback')
    expect(sanitizeName('a'.repeat(500), 'x')).toHaveLength(80)
  })

  it('avoids Windows device names', () => {
    expect(sanitizeName('CON', 'Recording')).toBe('Recording CON')
    expect(sanitizeName('lpt1', 'Recording')).toBe('Recording lpt1')
  })

  it('names a recording by its local time', () => {
    expect(defaultProjectName(new Date(2026, 9, 3, 7, 8, 9))).toBe('Recording 2026-10-03 07.08.09')
  })
})

describe('projects on disk', () => {
  let base: string
  let root: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dolly-projects-'))
    root = join(base, 'Dolly')
    await mkdir(root)
  })
  afterEach(() => rm(base, { recursive: true, force: true }))

  it('saves and opens a project with its cursor log', async () => {
    const dir = await createProjectDir(root, 'Demo')
    await writeJsonAtomic(join(dir, 'project.json'), sampleProject())
    await writeFile(join(dir, 'cursor.jsonl'), '{"t":0,"x":1,"y":2,"kind":"move"}\n{"t":5,"x":')
    const opened = await openProject(root, dir)
    expect(opened.project.name).toBe('Demo')
    expect(opened.cursor).toEqual([{ t: 0, x: 1, y: 2, kind: 'move' }])

    await saveProject(root, dir, { ...opened.project, name: 'Renamed' })
    expect((await openProject(root, dir)).project.name).toBe('Renamed')
  })

  it('opens a project with no cursor log', async () => {
    const dir = await createProjectDir(root, 'Demo')
    await writeJsonAtomic(join(dir, 'project.json'), sampleProject())
    expect((await openProject(root, dir)).cursor).toEqual([])
  })

  it('refuses to save a project pointing outside its folder', async () => {
    const dir = await createProjectDir(root, 'Demo')
    await writeJsonAtomic(join(dir, 'project.json'), sampleProject())
    const bad = sampleProject()
    bad.clips[0].file = '../../secret.mp4'
    await expect(saveProject(root, dir, bad)).rejects.toThrow()
    const badImage = sampleProject()
    badImage.look.background = { kind: 'image', file: '/etc/passwd' }
    await expect(saveProject(root, dir, badImage)).rejects.toThrow()
    expect((await openProject(root, dir)).project.clips[0].file).toBe('screen.mp4')
  })

  it('never reuses a folder', async () => {
    const a = await createProjectDir(root, 'Demo')
    const b = await createProjectDir(root, 'Demo')
    expect(a.endsWith('Demo.dolly')).toBe(true)
    expect(b.endsWith('Demo 2.dolly')).toBe(true)
  })

  it('lists newest first and skips unfinished folders', async () => {
    const older = await createProjectDir(root, 'Older')
    await writeJsonAtomic(join(older, 'project.json'), { ...sampleProject(), id: 'older', createdAt: '2026-01-01T00:00:00.000Z' })
    const newer = await createProjectDir(root, 'Newer')
    await writeJsonAtomic(join(newer, 'project.json'), { ...sampleProject(), id: 'newer', createdAt: '2026-06-01T00:00:00.000Z' })
    await createProjectDir(root, 'Mid recording')
    const broken = await createProjectDir(root, 'Broken')
    await writeFile(join(broken, 'project.json'), '{')
    await writeFile(join(root, 'stray.txt'), 'x')
    expect((await listProjects(root)).map((p) => p.id)).toEqual(['newer', 'older'])
  })

  it('lists nothing when the Dolly folder does not exist yet', async () => {
    expect(await listProjects(join(base, 'missing'))).toEqual([])
  })

  it('does not follow symlinks out of the Dolly folder', async () => {
    const outside = join(base, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.mp4'), 'secret')
    const link = join(root, 'Link.dolly')
    await symlink(outside, link)
    await expect(realProjectDir(root, link)).rejects.toThrow()

    const dir = await createProjectDir(root, 'Demo')
    await symlink(join(outside, 'secret.mp4'), join(dir, 'screen.mp4'))
    await expect(realProjectFile(root, dir, 'screen.mp4')).rejects.toThrow()
  })

  it('resolves a real file inside a project', async () => {
    const dir = await createProjectDir(root, 'Demo')
    await writeFile(join(dir, 'screen.mp4'), 'x')
    await expect(realProjectFile(root, dir, 'screen.mp4')).resolves.toContain('screen.mp4')
    await expect(realProjectFile(root, dir, 'missing.mp4')).rejects.toThrow()
  })

  it('copies a chosen background into the project and returns a relative path', async () => {
    const dir = await createProjectDir(root, 'Demo')
    const source = join(base, 'photo.PNG')
    await writeFile(source, 'png')
    const file = await importBackground(root, dir, source)
    expect(file).toMatch(/^backgrounds\/[0-9a-f-]+\.png$/)
    expect(await readFile(join(dir, file), 'utf8')).toBe('png')
    await writeFile(join(base, 'run.sh'), 'x')
    await expect(importBackground(root, dir, join(base, 'run.sh'))).rejects.toThrow()
  })
})

describe('project shape', () => {
  it('fills in the defaults a recording starts with', () => {
    const p = sampleProject()
    expect(p.version).toBe(1)
    expect(p.output).toEqual({ shapes: ['16:9', '1:1'], format: 'mp4', resolution: '1080p', fps: 30, folder: '/tmp/out' })
    expect(p.look).toMatchObject({ paddingPct: 6, background: { kind: 'wallpaper' } })
    expect(p.cursor).toMatchObject({ stiffness: 170, damping: 26, smooth: true })
    expect(p.webcam).toBeNull()
    expect(p.captions).toEqual([])
    expect(p.clips).toHaveLength(1)
    expect(p.clips[0]).toMatchObject({ kind: 'screen', file: 'screen.mp4', startMs: 0, durationMs: 5000, width: 3024, height: 1964, fps: 60, scaleFactor: 2 })
    expect(() => assertProject(p)).not.toThrow()
  })

  it('keeps defaults separate between projects', () => {
    const a = sampleProject()
    const b = sampleProject()
    a.look.paddingPct = 99
    if (a.look.background.kind === 'wallpaper') a.look.background.id = 'changed'
    expect(b.look.paddingPct).toBe(6)
    expect(b.look.background).toEqual({ kind: 'wallpaper', id: 'dusk' })
  })

  it('adds offset media clips, and a webcam style only with a webcam clip', () => {
    const p = buildProject({
      id: 'p',
      name: 'n',
      createdAt: 'now',
      durationMs: 1000,
      screen: { file: 'screen.mp4', width: 10, height: 10, fps: 60, scaleFactor: 1 },
      media: [
        { kind: 'mic', file: 'mic.webm', startMs: 12.5, durationMs: 900 },
        { kind: 'webcam', file: 'webcam.webm', startMs: 20, durationMs: 880, width: 1280, height: 720, fps: 30 }
      ],
      zooms: [],
      folder: '/tmp'
    })
    expect(p.clips.map((c) => [c.kind, c.startMs])).toEqual([
      ['screen', 0],
      ['mic', 12.5],
      ['webcam', 20]
    ])
    expect(p.webcam).toEqual({ shape: 'circle', corner: 'br', sizePct: 22 })
  })

  it('rejects things that are not projects', () => {
    expect(() => assertProject(null)).toThrow()
    expect(() => assertProject([])).toThrow()
    expect(() => assertProject({ ...sampleProject(), version: 2 })).toThrow()
    expect(() => assertProject({ ...sampleProject(), durationMs: -1 })).toThrow()
    expect(() => assertProject({ ...sampleProject(), clips: [{ kind: 'other', file: 'a', startMs: 0, durationMs: 0 }] })).toThrow()
  })
})

describe('media scheme', () => {
  const root = '/Users/me/Movies/Dolly'

  it('round-trips names with spaces and unicode', () => {
    const url = mediaUrlFor(root, `${root}/My Demo é.dolly`, 'backgrounds/a b.png')
    expect(url).toBe('dolly-media://project/My%20Demo%20%C3%A9.dolly/backgrounds/a%20b.png')
    expect(mediaFromUrl(root, url)).toEqual({ dir: `${root}/My Demo é.dolly`, file: 'backgrounds/a b.png' })
  })

  it.each([
    ['encoded climb', 'dolly-media://project/Demo.dolly/%2e%2e/%2e%2e/secret'],
    ['encoded slash climb', 'dolly-media://project/Demo.dolly/..%2F..%2Fsecret'],
    ['encoded backslash climb', 'dolly-media://project/Demo.dolly/..%5C..%5Csecret'],
    ['folder climb', 'dolly-media://project/..%2F..%2Fetc/passwd'],
    ['no project extension', 'dolly-media://project/Demo/screen.mp4'],
    ['no file', 'dolly-media://project/Demo.dolly'],
    ['other host', 'dolly-media://other/Demo.dolly/screen.mp4'],
    ['other scheme', 'file:///etc/passwd']
  ])('refuses %s', (_label, url) => {
    expect(() => mediaFromUrl(root, url)).toThrow()
  })

  it('parses ranges', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
  })

  it('flags ranges it cannot satisfy and ignores ones it does not understand', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=50-10', 100)).toBe('invalid')
    expect(parseRange('bytes=-0', 100)).toBe('invalid')
    expect(parseRange('bytes=-', 100)).toBe('invalid')
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('chunks=1', 100)).toBeNull()
  })

  it('knows its media types', () => {
    expect(contentTypeFor('a.MP4')).toBe('video/mp4')
    expect(contentTypeFor('a.webm')).toBe('video/webm')
    expect(contentTypeFor('a.exe')).toBe('application/octet-stream')
  })

  describe('responses', () => {
    let base: string
    let file: string
    beforeEach(async () => {
      base = await mkdtemp(join(tmpdir(), 'dolly-media-'))
      file = join(base, 'a.mp4')
      await writeFile(file, '0123456789')
    })
    afterEach(() => rm(base, { recursive: true, force: true }))

    it('sends a whole file', async () => {
      const res = await serveFile(file, null, 'GET')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('video/mp4')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      expect(res.headers.get('content-length')).toBe('10')
      expect(await res.text()).toBe('0123456789')
    })

    it('sends a range with 206', async () => {
      const res = await serveFile(file, 'bytes=2-5', 'GET')
      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
      expect(res.headers.get('content-length')).toBe('4')
      expect(await res.text()).toBe('2345')
    })

    it('answers 416 past the end', async () => {
      const res = await serveFile(file, 'bytes=50-', 'GET')
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */10')
    })

    it('sends no body for HEAD, and handles an empty file', async () => {
      const head = await serveFile(file, null, 'HEAD')
      expect(head.headers.get('content-length')).toBe('10')
      expect(await head.text()).toBe('')
      const empty = join(base, 'empty.mp4')
      await writeFile(empty, '')
      const res = await serveFile(empty, null, 'GET')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBe('0')
    })

    it('refuses a folder', async () => {
      expect((await serveFile(base, null, 'GET')).status).toBe(404)
    })
  })
})

describe('permissions', () => {
  it('needs nothing but mic and camera on Windows', () => {
    expect(needsPermission('screen', 'win32')).toBe(false)
    expect(needsPermission('input-monitoring', 'win32')).toBe(false)
    expect(needsPermission('microphone', 'win32')).toBe(true)
    expect(needsPermission('camera', 'win32')).toBe(true)
    expect(needsPermission('screen', 'darwin')).toBe(true)
    expect(needsPermission('input-monitoring', 'darwin')).toBe(true)
  })

  it('points each kind at its own settings page', () => {
    expect(settingsUrl('screen', 'darwin')).toContain('Privacy_ScreenCapture')
    expect(settingsUrl('input-monitoring', 'darwin')).toContain('Privacy_ListenEvent')
    expect(settingsUrl('microphone', 'darwin')).toContain('Privacy_Microphone')
    expect(settingsUrl('camera', 'darwin')).toContain('Privacy_Camera')
    expect(settingsUrl('microphone', 'win32')).toBe('ms-settings:privacy-microphone')
    expect(settingsUrl('camera', 'win32')).toBe('ms-settings:privacy-webcam')
    expect(settingsUrl('screen', 'win32')).toBeNull()
  })

  it('maps OS answers onto permission states', () => {
    expect(mapMediaStatus('granted')).toBe('granted')
    expect(mapMediaStatus('not-determined')).toBe('not-determined')
    expect(mapMediaStatus('denied')).toBe('denied')
    expect(mapMediaStatus('restricted')).toBe('denied')
    expect(mapMediaStatus('unknown')).toBe('denied')
    expect(mapBooleanStatus(true, false)).toBe('granted')
    expect(mapBooleanStatus(false, false)).toBe('not-determined')
    expect(mapBooleanStatus(false, true)).toBe('denied')
  })
})

describe('capture clock', () => {
  it('trusts the quickest round trip', () => {
    const offset = clockOffset([
      { sentMs: 0, receivedMs: 40, remoteMs: 1040 },
      { sentMs: 100, receivedMs: 102, remoteMs: 1101 },
      { sentMs: 200, receivedMs: 230, remoteMs: 1230 }
    ])
    expect(offset).toBe(1000)
  })

  it('refuses to guess with no samples', () => {
    expect(() => clockOffset([])).toThrow()
  })

  it('reads helper lines and ignores noise', () => {
    expect(parseHelperLine('{"type":"firstFrame","hostMs":12.5}')).toEqual({ type: 'firstFrame', hostMs: 12.5 })
    expect(parseHelperLine('{"bytes":1024,"type":"diskFree"}')).toEqual({ type: 'diskFree', bytes: 1024 })
    expect(parseHelperLine('not json')).toBeNull()
    expect(parseHelperLine('{"hostMs":1}')).toBeNull()
    expect(parseHelperLine('null')).toBeNull()
  })

  it('validates recording options', () => {
    expect(checkOptions({ displayId: '1', mic: true, webcam: false, clicks: false })).toEqual({ displayId: '1', mic: true, webcam: false, clicks: false, name: undefined })
    expect(() => checkOptions({ displayId: '1', mic: true, webcam: false })).toThrow()
    expect(() => checkOptions({ displayId: 1, mic: true, webcam: false, clicks: true })).toThrow()
    expect(() => checkOptions({ displayId: '1' })).toThrow()
    expect(() => checkOptions(null)).toThrow()
  })
})
