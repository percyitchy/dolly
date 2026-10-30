// The real handler, ffmpeg, whisper-cli and model, on speech from `say`, written the way Chromium writes a mic clip.
// Only electron and the plan are stand-ins. Runs on macOS once native/whisper/build.mjs has been run.
// To prove it needs no network: sandbox-exec -p '(version 1)(allow default)(deny network*)' ./node_modules/.bin/vitest run tests/captions.e2e.test.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { CaptionEvent } from '../src/shared/ipc'
import type { Caption, Project } from '../src/shared/project'
import { SCRIPTS, wordAccuracy } from './captions-accuracy.mjs'

const home = vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dolly-e2e-')))
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  process.env.TMPDIR = dir // dollyTemp() would otherwise be shared with anything else running on this machine
  return dir
})

const root = join(__dirname, '..')

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => join(__dirname, '..'), on: () => {} },
  ipcMain: { handle: () => {} }
}))
vi.mock('../src/main/license', () => ({ currentPlan: () => 'pro' }))

import { generateCaptions } from '../src/main/captions'
import { defaultDollyFolder, dollyTemp } from '../src/main/paths'

const ffmpeg = ffmpegStatic as unknown as string
const bin = join(root, 'native/bin', `${process.platform}-${process.arch}`)
const built = ['whisper-cli', 'models/ggml-base.bin', 'models/ggml-silero-v6.2.0.bin'].every((file) => existsSync(join(bin, file)))
const hasVoice = (voice: string) => process.platform === 'darwin' && spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout.includes(voice)
const script = (name: string) => SCRIPTS.find((s) => s.name.startsWith(name))!

function tool(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`)
}

function speak(text: string, voice: string, path: string): void {
  tool('say', ['-v', voice, '-o', path, text.replace(/\s+/g, ' ')])
}

// A filter graph picks what's in the clip. Opus in WebM at 48 kHz stereo is what MediaRecorder gives us
function encodeMic(inputs: string[], filter: string, out: string): void {
  tool(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[o]', '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', out])
}

async function runProject(name: string, startMs: number, make: (micPath: string, dir: string) => void) {
  const dir = join(defaultDollyFolder(), `${name}.dolly`)
  mkdirSync(dir, { recursive: true })
  make(join(dir, 'mic.webm'), dir)
  const project = {
    version: 1,
    id: name,
    name,
    createdAt: '2026-10-30T00:00:00.000Z',
    durationMs: 60000,
    clips: [
      { id: 's', kind: 'screen', file: 'screen.mp4', startMs: 0, durationMs: 60000 },
      { id: 'm', kind: 'mic', file: 'mic.webm', startMs, durationMs: 60000 }
    ],
    zooms: [],
    look: { background: { kind: 'wallpaper', id: 'dusk' } },
    cursor: {},
    output: {},
    captions: []
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project))

  const events: CaptionEvent[] = []
  await generateCaptions(dir, (event) => events.push(event))

  return {
    dir,
    events,
    tempLeft: existsSync(dollyTemp()) ? readdirSync(dollyTemp()) : [],
    saved: JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as Project
  }
}

function audioMs(path: string): number {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' })
  const [, h, m, s] = probe.stderr.match(/time=(\d+):(\d+):([\d.]+)/g)?.at(-1)?.match(/time=(\d+):(\d+):([\d.]+)/) ?? []
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000
}

const textOf = (captions: Caption[]) => captions.map((caption) => caption.text).join(' ')

function expectCleanLines(captions: Caption[]): void {
  captions.forEach((caption, i) => {
    expect(caption.text.length).toBeLessThanOrEqual(42)
    expect(caption.endMs).toBeGreaterThan(caption.startMs)
    if (i > 0) expect(caption.startMs).toBeGreaterThanOrEqual(captions[i - 1].endMs)
  })
}

describe.runIf(built && hasVoice('Samantha'))('captions, real run', () => {
  afterAll(async () => rmSync(await home, { recursive: true, force: true }))

  // Plain whisper fails this: it pins the first segment to 0, so the first line lands at the clip offset, 2 s early
  it('captions English speech with the clip offset and a 2 s lead-in', { timeout: 120000 }, async () => {
    const english = script('English, Samantha')
    const result = await runProject('english', 1500, (mic, dir) => {
      const aiff = join(dir, 'speech.aiff')
      speak(english.text, english.voice, aiff)
      encodeMic(['-i', aiff], '[0:a]adelay=2000:all=1[o]', mic)
      rmSync(aiff)
    })

    expect(result.events.at(-1)).toEqual({ type: 'done', projectDir: result.dir })
    const { captions } = result.saved
    expect(wordAccuracy(english.text, textOf(captions)).accuracy).toBeGreaterThanOrEqual(0.9)
    expectCleanLines(captions)
    expect(captions[0].startMs).toBeGreaterThanOrEqual(1500 + 2000 - 300)
    expect(captions[0].startMs).toBeLessThanOrEqual(1500 + 2000 + 500)
    expect(result.tempLeft).toEqual([])
    expect(readdirSync(result.dir).sort()).toEqual(['mic.webm', 'project.json'])
  })

  it.runIf(hasVoice('Milena'))('captions Russian speech', { timeout: 120000 }, async () => {
    const russian = script('Russian')
    const result = await runProject('russian', 0, (mic, dir) => {
      const aiff = join(dir, 'speech.aiff')
      speak(russian.text, russian.voice, aiff)
      encodeMic(['-i', aiff], '[0:a]anull[o]', mic)
      rmSync(aiff)
    })

    const { captions } = result.saved
    expect(wordAccuracy(russian.text, textOf(captions)).accuracy).toBeGreaterThanOrEqual(0.9)
    expectCleanLines(captions)
    expect(textOf(captions)).not.toContain('�')
    expect(textOf(captions)).toMatch(/[а-я]/)
  })

  // The regression that matters most: plain whisper puts lines up to 9 s early around pauses like these
  const pauseCases = [
    ['English', 'Samantha', ['Welcome to this short walkthrough of the new dashboard.', 'First, open the settings page and choose the account you want to review.', 'Next, click the export button in the top corner and wait a few seconds.', 'When the file is ready, you can share it with your team.']],
    ['Russian', 'Milena', ['Здравствуйте, сегодня я покажу вам новую программу.', 'Сначала откройте настройки и выберите нужный монитор.', 'Затем нажмите на красную кнопку и подождите немного.', 'Когда запись начнётся, спокойно расскажите о своей работе.']]
  ] as const

  it.each(pauseCases.filter(([, voice]) => hasVoice(voice)))('times lines correctly around pauses in %s', { timeout: 120000 }, async (name, voice, sentences) => {
    const offset = 700
    const gaps = [4000, 2000, 8000, 5000]
    const starts: number[] = []

    const result = await runProject(`pauses-${name}`, offset, (mic, dir) => {
      const inputs: string[] = []
      const parts: string[] = []
      let cursor = offset
      sentences.forEach((sentence, i) => {
        const aiff = join(dir, `${i}.aiff`)
        speak(sentence, voice, aiff)
        inputs.push('-i', aiff)
        parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${gaps[i]}:all=1[p${i}]`)
        cursor += gaps[i]
        starts.push(cursor)
        cursor += audioMs(aiff)
      })
      const labels = sentences.map((_, i) => `[p${i}]`).join('')
      encodeMic(inputs, `${parts.join(';')};${labels}concat=n=${sentences.length}:v=0:a=1[o]`, mic)
      sentences.forEach((_, i) => rmSync(join(dir, `${i}.aiff`)))
    })

    const { captions } = result.saved
    expectCleanLines(captions)
    expect(wordAccuracy(sentences.join(' '), textOf(captions)).accuracy).toBeGreaterThanOrEqual(0.9)
    const startErrors = starts.map((start) => {
      const nearest = captions.reduce((best, c) => (Math.abs(c.startMs - start) < Math.abs(best.startMs - start) ? c : best))
      return nearest.startMs - start
    })
    console.info(`${name} sentence start errors, ms: ${startErrors.join(', ')}`)
    startErrors.forEach((error, i) => expect(Math.abs(error), `sentence ${i} of ${name}`).toBeLessThanOrEqual(500))
    // Nothing on screen during any pause
    starts.forEach((start, i) => {
      const quietFrom = start - gaps[i] + 1000
      const quietTo = start - 400
      const shown = captions.filter((c) => c.startMs < quietTo && c.endMs > quietFrom)
      expect(shown, `pause before sentence ${i} of ${name}`).toEqual([])
    })
  })

  it('reports no speech for a silent recording and leaves the project alone', { timeout: 60000 }, async () => {
    const result = await runProject('silent', 0, (mic) => encodeMic(['-f', 'lavfi', '-t', '10', '-i', 'anullsrc=r=48000:cl=stereo'], '[0:a]anull[o]', mic))
    expect(result.events.at(-1)).toEqual({ type: 'failed', message: 'No speech was found in the microphone recording.' })
    expect(result.saved.captions).toEqual([])
    expect(result.tempLeft).toEqual([])
  })
})
