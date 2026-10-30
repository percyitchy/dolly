// M5, L1: a packaged build ignores the environment when it finds its programs, and ffmpeg only opens local inputs.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ packaged: false }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    },
    getAppPath: () => '/repo',
    getPath: () => '/tmp'
  }
}))
vi.mock('ffmpeg-static', () => ({ default: process.env.FFMPEG_BIN ?? '/repo/node_modules/ffmpeg-static/ffmpeg' }))

const platform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value })
}

async function paths() {
  vi.resetModules()
  return import('../src/main/paths')
}

beforeEach(() => {
  h.packaged = false
  Object.defineProperty(process, 'resourcesPath', { value: '/App/Resources', configurable: true })
  vi.stubEnv('FFMPEG_BIN', '/tmp/evil')
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://evil.test')
})

afterEach(() => {
  setPlatform(platform)
  vi.unstubAllEnvs()
})

describe('ffmpegPath', () => {
  it('uses the bundled build on a packaged Mac, whatever FFMPEG_BIN says', async () => {
    h.packaged = true
    setPlatform('darwin')
    expect((await paths()).ffmpegPath()).toBe(join('/App/Resources', 'bin', 'ffmpeg'))
  })

  it('works the Windows path out itself in a packaged build', async () => {
    h.packaged = true
    setPlatform('win32')
    expect((await paths()).ffmpegPath()).toBe(join('/App/Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))
  })

  it('still lets ffmpeg-static decide in dev', async () => {
    setPlatform('linux')
    expect((await paths()).ffmpegPath()).toBe('/tmp/evil')
  })
})

describe('devRendererUrl', () => {
  it('is the env variable in dev', async () => {
    expect((await paths()).devRendererUrl()).toBe('http://evil.test')
  })

  it('is nothing in a packaged build, even with the variable set', async () => {
    h.packaged = true
    expect((await paths()).devRendererUrl()).toBeUndefined()
  })
})

describe('pageUrl', () => {
  it('is the dev server in dev', async () => {
    expect((await paths()).pageUrl('recorder.html')).toBe('http://evil.test/recorder.html')
  })

  it('is an encoded file URL in a packaged build, even with the variable set', async () => {
    h.packaged = true
    const url = (await paths()).pageUrl('recorder.html')
    expect(url).toMatch(/^file:\/\/.*\/renderer\/recorder\.html$/)
  })
})

describe('ffmpeg inputs', () => {
  const sources = ['src/main/capture.ts', 'src/main/export.ts'].map((file) => [file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')])

  it('names only file and pipe', async () => {
    expect((await paths()).ffmpegInput('pipe:0')).toEqual(['-protocol_whitelist', 'file,pipe', '-i', 'pipe:0'])
  })

  it.each(sources)('%s opens every input through ffmpegInput', (_, code) => {
    expect(code).not.toMatch(/['"]-i['"]/)
    expect(code).toMatch(/ffmpegInput\(/)
  })
})
