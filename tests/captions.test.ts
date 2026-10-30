import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionEvent } from '../src/shared/ipc'
import type { Project } from '../src/shared/project'

const state = vi.hoisted(() => ({
  plan: 'pro' as 'free' | 'pro',
  dollyRoot: '',
  ffmpeg: '',
  bin: '',
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  sent: [] as { channel: string; event: unknown }[]
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../src/main/license', () => ({ currentPlan: () => state.plan }))
vi.mock('../src/main/paths', () => ({
  defaultDollyFolder: () => state.dollyRoot,
  dollyTemp: () => join(state.dollyRoot, '..', 'temp'),
  ffmpegPath: () => state.ffmpeg,
  nativeBin: (name: string) => join(state.bin, name),
  resourcePath: (...parts: string[]) => join(state.bin, ...parts)
}))

import { generateCaptions, parseWhisperJson, register, segmentsToCaptions, sweepTemp, whisperArgs, type WhisperSegment } from '../src/main/captions'
import { isInside } from '../src/main/projects'

const seg = (fromMs: number, toMs: number, text: string): WhisperSegment => ({ fromMs, toMs, text })

// One segment per word, evenly timed, as whisper-cli gives us with -ml 1 -sow
function words(text: string, fromMs = 0, msPerWord = 300): WhisperSegment[] {
  return text.split(' ').map((word, i) => seg(fromMs + i * msPerWord, fromMs + (i + 1) * msPerWord, ` ${word}`))
}

describe('segmentsToCaptions', () => {
  it('keeps a short run of words as one line', () => {
    const captions = segmentsToCaptions(words('Hello there, welcome back.'), 0)
    expect(captions.map((c) => c.text)).toEqual(['Hello there, welcome back.'])
    expect(captions[0].startMs).toBe(0)
    expect(captions[0].endMs).toBe(1200)
  })

  it('applies the clip offset so captions land on the capture clock', () => {
    const [caption] = segmentsToCaptions(words('One two three four.', 1000), 2500)
    expect(caption.startMs).toBe(3500)
    expect(caption.endMs).toBe(4700)
  })

  it('never exceeds the line length and never loses a word', () => {
    const text = 'the quick brown fox jumps over the lazy dog and then keeps running through the forest until the sun goes down behind the hills'
    const captions = segmentsToCaptions(words(text), 0)
    expect(captions.length).toBeGreaterThan(2)
    for (const caption of captions) expect(caption.text.length).toBeLessThanOrEqual(42)
    expect(captions.map((c) => c.text).join(' ')).toBe(text)
  })

  it('fills the line when there is no punctuation to break on', () => {
    const lines = segmentsToCaptions(words('When the recording stops and the video is ready the editor opens with every zoom already placed'), 0)
    expect(lines[0].text).toBe('When the recording stops and the video is')
  })

  it('prefers to break a full line at punctuation in its back half', () => {
    const lines = segmentsToCaptions(words('When the recording stops today, the video is ready and waiting for you'), 0)
    expect(lines[0].text).toBe('When the recording stops today,')
  })

  it('ignores punctuation too early in the line to break on', () => {
    const lines = segmentsToCaptions(words('Well, the recording stops and the video is ready and waiting for you'), 0)
    expect(lines[0].text).toBe('Well, the recording stops and the video is')
  })

  it('ends a line at the end of a sentence', () => {
    const text = 'This is the first full sentence here. This is the second sentence and it keeps going for a while.'
    const lines = segmentsToCaptions(words(text), 0).map((c) => c.text)
    expect(lines[0]).toBe('This is the first full sentence here.')
    expect(lines[1].startsWith('This is the second')).toBe(true)
  })

  it('lets very short sentences share a line', () => {
    expect(segmentsToCaptions(words('Okay. Now we start.'), 0).map((c) => c.text)).toEqual(['Okay. Now we start.'])
  })

  it('takes each line time from its word timing', () => {
    const captions = segmentsToCaptions(words('word '.repeat(20).trim(), 500, 100), 0)
    expect(captions[0].startMs).toBe(500)
    const wordsInFirst = captions[0].text.split(' ').length
    expect(captions[1].startMs).toBe(500 + wordsInFirst * 100)
  })

  it('starts a new line after a pause, however little is on the current one', () => {
    const captions = segmentsToCaptions([...words('Click here'), ...words('then wait', 5000)], 0)
    expect(captions.map((c) => c.text)).toEqual(['Click here', 'then wait'])
    expect(captions[1].startMs).toBe(5000)
  })

  it('keeps a line going across a short pause', () => {
    const captions = segmentsToCaptions([...words('Click here'), ...words('then wait', 1000)], 0)
    expect(captions.map((c) => c.text)).toEqual(['Click here then wait'])
  })

  it('leaves a gap empty instead of holding the last line over it', () => {
    const captions = segmentsToCaptions([...words('First part of the talk.'), ...words('Second part.', 20000)], 0)
    expect(captions[0].endMs).toBe(1500)
    expect(captions[1].startMs).toBe(20000)
  })

  it('sees a pause even though the word before it claims the whole gap', () => {
    const stretched = [seg(0, 300, ' Open'), seg(300, 600, ' the'), seg(600, 8000, ' dashboard.'), seg(8000, 8400, ' Now'), seg(8400, 8800, ' click.')]
    const captions = segmentsToCaptions(stretched, 0)
    expect(captions.map((c) => c.text)).toEqual(['Open the dashboard.', 'Now click.'])
    expect(captions[0].endMs).toBe(1600)
    expect(captions[1].startMs).toBe(8000)
  })

  it('keeps Russian words and punctuation whole', () => {
    const captions = segmentsToCaptions([seg(0, 220, ' Привет,'), seg(300, 520, ' мир.')], 0)
    expect(captions[0].text).toBe('Привет, мир.')
  })

  it('removes replacement characters left by broken UTF-8', () => {
    expect(segmentsToCaptions([seg(0, 1000, ' Hello� world')], 0)[0].text).toBe('Hello world')
  })

  it('drops non-speech markers', () => {
    const noise = [seg(0, 1000, ' [BLANK_AUDIO]'), seg(1000, 2000, ' (music)'), seg(2000, 3000, ' ♪♪'), seg(3000, 4000, ' [ Silence ]'), seg(4000, 5000, ' *applause*')]
    expect(segmentsToCaptions(noise, 0)).toEqual([])
  })

  it('keeps a dash between words, and drops a line of only punctuation', () => {
    expect(segmentsToCaptions(words('This — that'), 0)[0].text).toBe('This — that')
    expect(segmentsToCaptions([seg(0, 1000, ' ...')], 0)).toEqual([])
  })

  it('shares time out by length when a long segment arrives whole', () => {
    const captions = segmentsToCaptions([seg(0, 10000, ` ${'alpha beta gamma delta '.repeat(6).trim()}`)], 0)
    expect(captions.length).toBeGreaterThan(1)
    expect(captions[0].startMs).toBe(0)
    expect(captions[1].startMs).toBeGreaterThan(0)
    expect(captions[captions.length - 1].endMs).toBeLessThanOrEqual(10000)
  })

  it('hard-splits a single oversized word, as in languages without spaces', () => {
    const captions = segmentsToCaptions([seg(0, 10010, '字'.repeat(100))], 0)
    expect(captions.map((c) => c.text.length)).toEqual([42, 42, 16])
    expect(captions[1].startMs).toBe(4204)
  })

  it('never overlaps, and holds a very short line for a readable time', () => {
    const text = 'One sentence of a fair length here. Another one right after it.'
    const captions = segmentsToCaptions([...words(text, 0, 50), ...words('Done.', 5000, 100)], 0)
    for (let i = 1; i < captions.length; i++) expect(captions[i].startMs).toBeGreaterThanOrEqual(captions[i - 1].endMs)
    expect(captions[captions.length - 1].endMs).toBe(5800)
  })

  it('closes tiny gaps between neighbouring lines so they do not flicker', () => {
    const text = 'This sentence is long enough to stand alone.'
    const captions = segmentsToCaptions([...words(text, 0, 200), ...words('Second line here.', 1800, 200)], 0)
    expect(captions[0].endMs).toBe(captions[1].startMs)
  })

  it('clamps to the end of the audio and drops anything past it', () => {
    const captions = segmentsToCaptions([...words('Inside the clip.', 1000), ...words('Past the end.', 9000)], 500, 2500)
    expect(captions).toHaveLength(1)
    expect(captions[0].endMs).toBe(2500)
  })

  it('handles a clip that starts before the capture clock', () => {
    const captions = segmentsToCaptions([...words('Gone already.', 0, 100), ...words('Still here.', 2000, 300)], -1000)
    expect(captions.map((c) => c.text)).toEqual(['Still here.'])
    expect(captions[0].startMs).toBe(1000)
  })

  it('survives timestamps that run backwards', () => {
    const captions = segmentsToCaptions([seg(900, 1000, ' one'), seg(200, 300, ' two'), seg(1100, 1200, ' three')], 0)
    expect(captions[0].text).toBe('one two three')
    expect(captions[0].startMs).toBe(900)
    expect(captions[0].endMs).toBe(1700)
  })

  it('gives every caption a unique id', () => {
    const captions = segmentsToCaptions([...words('First words here.', 0), ...words('Second words.', 5000)], 0)
    expect(new Set(captions.map((c) => c.id)).size).toBe(2)
  })

  it('returns nothing for no segments', () => {
    expect(segmentsToCaptions([], 1000, 5000)).toEqual([])
  })
})

describe('parseWhisperJson', () => {
  const sample = (text: string) => `{
\t"result": {
\t\t"language": "en"
\t},
\t"transcription": [
\t\t{
\t\t\t"timestamps": {
\t\t\t\t"from": "00:00:00,100",
\t\t\t\t"to": "00:00:00,900"
\t\t\t},
\t\t\t"offsets": {
\t\t\t\t"from": 100,
\t\t\t\t"to": 900
\t\t\t},
\t\t\t"text": "${text}"
\t\t}
\t]
}`

  it('reads the text and times of each segment', () => {
    expect(parseWhisperJson(sample(' Hi'))).toEqual([{ fromMs: 100, toMs: 900, text: ' Hi' }])
  })

  it('copes with raw control characters, which whisper-cli leaves unescaped', () => {
    expect(parseWhisperJson(sample(' a\nb\tc'))[0].text).toBe(' a b c')
  })

  it('keeps escaped quotes and backslashes', () => {
    expect(parseWhisperJson(sample(' \\"hi\\" \\\\ there'))[0].text).toBe(' "hi" \\ there')
  })

  it('treats an output with no transcription as empty', () => {
    expect(parseWhisperJson('{"result": {"language": "en"}}')).toEqual([])
  })
})

describe('isInside', () => {
  const root = resolve('/dolly')

  it('accepts a folder inside', () => {
    expect(isInside(root, join(root, 'a.dolly'))).toBe(true)
    expect(isInside(root, join(root, '..odd.dolly'))).toBe(true)
  })

  it('rejects the folder itself, parents, siblings and traversal', () => {
    expect(isInside(root, root)).toBe(false)
    expect(isInside(root, resolve('/'))).toBe(false)
    expect(isInside(root, resolve('/dolly-evil/a.dolly'))).toBe(false)
    expect(isInside(root, join(root, '..', `etc${sep}passwd`))).toBe(false)
  })
})

const fromMain = { sender: {} }

describe('sweepTemp', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dolly-sweep-'))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const folder = (name: string) => mkdirSync(join(root, name))

  it('clears what a dead process left and keeps a running one', async () => {
    folder('captions-111-aaaaaa')
    folder('captions-222-bbbbbb')
    folder('captions-oldname')
    writeFileSync(join(root, 'stray.wav'), 'voice')
    await sweepTemp(root, (pid) => pid === 222)
    expect(readdirSync(root)).toEqual(['captions-222-bbbbbb'])
  })

  it('knows this process is running', async () => {
    folder(`captions-${process.pid}-aaaaaa`)
    await sweepTemp(root)
    expect(readdirSync(root)).toHaveLength(1)
  })

  it('is fine with no temp folder', async () => {
    await expect(sweepTemp(join(root, 'nothing-here'))).resolves.toBeUndefined()
  })
})

// These use shell scripts as stand-ins for ffmpeg and whisper-cli, which Windows can't run
const unixIt = it.skipIf(process.platform === 'win32')

describe('captions:generate', () => {
  let sandbox: string
  let events: CaptionEvent[]

  const project = (overrides: Partial<Project> = {}): Project => ({
    version: 1,
    id: 'p1',
    name: 'Test',
    createdAt: '2026-10-30T00:00:00.000Z',
    durationMs: 5000,
    clips: [{ id: 'm', kind: 'mic', file: 'mic.webm', startMs: 1500, durationMs: 5000 }],
    zooms: [],
    look: { background: { kind: 'wallpaper', id: 'dusk' }, paddingPct: 6, cornerRadiusPct: 1.2, shadow: 0.5 },
    cursor: { smooth: true, stiffness: 170, damping: 26, scale: 1, clickRipple: true },
    webcam: null,
    captions: [],
    output: { shapes: ['16:9'], format: 'mp4', resolution: '1080p', fps: 30, folder: '' },
    ...overrides
  })

  function makeProject(value: Project = project(), name = 'demo.dolly'): string {
    const dir = join(state.dollyRoot, name)
    mkdirSync(dir)
    writeFileSync(join(dir, 'project.json'), JSON.stringify(value))
    writeFileSync(join(dir, 'mic.webm'), 'audio')
    return dir
  }

  // Stand-ins for the two programs, so this suite runs on any machine without the native build
  function fakeTools(whisperScript: string): void {
    const ffmpeg = join(sandbox, 'fake-ffmpeg')
    writeFileSync(ffmpeg, `#!/bin/sh\necho "$@" > "${sandbox}/ffmpeg-args"\nhead -c 80044 /dev/zero > audio.wav\n`, { mode: 0o755 })
    state.ffmpeg = ffmpeg
    state.bin = join(sandbox, 'bin')
    mkdirSync(state.bin)
    writeFileSync(join(state.bin, 'whisper-cli'), `#!/bin/sh\necho "$@" > "${sandbox}/whisper-args"\n${whisperScript}\n`, { mode: 0o755 })
  }

  const transcript = JSON.stringify({
    transcription: [
      { offsets: { from: 0, to: 500 }, text: ' Hello' },
      { offsets: { from: 500, to: 1000 }, text: ' world.' }
    ]
  })

  const writesTranscript = `cat > transcript.json <<'JSON'\n${transcript}\nJSON\necho 'whisper_print_progress_callback: progress =  50%' >&2\nsleep 0.2\necho 'whisper_print_progress_callback: progress = 100%' >&2`

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dolly-captions-')))
    state.dollyRoot = join(sandbox, 'Dolly')
    mkdirSync(state.dollyRoot)
    state.plan = 'pro'
    state.ffmpeg = join(sandbox, 'no-ffmpeg')
    state.bin = join(sandbox, 'no-bin')
    events = []
  })

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

  const failure = () => events.find((event) => event.type === 'failed')

  it('refuses on the Free plan', async () => {
    state.plan = 'free'
    await generateCaptions(makeProject(), (event) => events.push(event))
    expect(events).toEqual([{ type: 'failed', message: 'Captions are a Pro feature.' }])
  })

  it('fails plainly when there is no mic clip', async () => {
    await generateCaptions(makeProject(project({ clips: [] })), (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'This recording has no microphone audio, so there is nothing to caption.' })
  })

  it('refuses a project outside the Dolly folder', async () => {
    const outside = join(sandbox, 'outside.dolly')
    mkdirSync(outside)
    writeFileSync(join(outside, 'project.json'), JSON.stringify(project()))
    await generateCaptions(outside, (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'That project is not in the Dolly folder.' })
  })

  it('refuses a symlink that leads out of the Dolly folder', async () => {
    const outside = join(sandbox, 'outside.dolly')
    mkdirSync(outside)
    symlinkSync(outside, join(state.dollyRoot, 'link.dolly'))
    await generateCaptions(join(state.dollyRoot, 'link.dolly'), (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'That project is not in the Dolly folder.' })
  })

  it('refuses a traversal path and the Dolly folder itself', async () => {
    await generateCaptions(join(state.dollyRoot, '..'), (event) => events.push(event))
    await generateCaptions(state.dollyRoot, (event) => events.push(event))
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(2)
  })

  it('refuses input that is not a path', async () => {
    await generateCaptions(42, (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'That project could not be found.' })
  })

  it('refuses a mic file that points outside the project', async () => {
    writeFileSync(join(sandbox, 'secret.wav'), 'x')
    const value = project({ clips: [{ id: 'm', kind: 'mic', file: '../../secret.wav', startMs: 0, durationMs: 1 }] })
    await generateCaptions(makeProject(value), (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'This project could not be read.' })
  })

  it('refuses a mic file that links outside the project', async () => {
    writeFileSync(join(sandbox, 'secret.wav'), 'x')
    const dir = makeProject()
    rmSync(join(dir, 'mic.webm'))
    symlinkSync(join(sandbox, 'secret.wav'), join(dir, 'mic.webm'))
    await generateCaptions(dir, (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'The microphone recording is not in the project folder.' })
  })

  it('takes only a project folder directly in the Dolly folder', async () => {
    const nested = join(state.dollyRoot, 'folder')
    mkdirSync(join(nested, 'deep.dolly'), { recursive: true })
    writeFileSync(join(nested, 'deep.dolly', 'project.json'), JSON.stringify(project()))
    await generateCaptions(join(nested, 'deep.dolly'), (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'That project is not in the Dolly folder.' })
  })

  it('refuses a project.json of the wrong shape', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ version: 1, clips: [{ kind: 'mic', file: 'mic.webm' }] }))
    await generateCaptions(dir, (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'This project could not be read.' })
  })

  it('reports a missing mic file', async () => {
    const dir = makeProject()
    rmSync(join(dir, 'mic.webm'))
    await generateCaptions(dir, (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'The microphone recording for this project is missing.' })
  })

  it('says so when the engine is missing, and leaves no temp files', async () => {
    fakeTools('exit 0')
    rmSync(join(state.bin, 'whisper-cli'))
    await generateCaptions(makeProject(), (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'The captions engine is missing from this copy of Dolly.' })
    expect(readdirSync(join(sandbox, 'temp'))).toEqual([])
  })

  unixIt('saves captions on the capture clock, keeps the rest of the project and cleans up', async () => {
    fakeTools(writesTranscript)
    const dir = makeProject()
    await generateCaptions(dir, (event) => events.push(event))

    expect(failure()).toBeUndefined()
    const saved = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as Project
    expect(saved.captions).toHaveLength(1)
    expect(saved.captions[0]).toMatchObject({ startMs: 1500, endMs: 2500, text: 'Hello world.' })
    expect({ ...saved, captions: [] }).toEqual(project())
    expect(readdirSync(dir).sort()).toEqual(['mic.webm', 'project.json'])
    expect(readdirSync(join(sandbox, 'temp'))).toEqual([])
  })

  unixIt('reports rising progress and then done', async () => {
    fakeTools(writesTranscript)
    const dir = makeProject()
    await generateCaptions(dir, (event) => events.push(event))
    const pcts = events.flatMap((event) => (event.type === 'progress' ? [event.pct] : []))
    expect(pcts).toEqual([0, 5, 50, 95, 100])
    expect(events.at(-1)).toEqual({ type: 'done', projectDir: dir })
  })

  unixIt('asks whisper for word segments, voice detection, auto language and JSON, and ffmpeg for local 16 kHz mono', async () => {
    fakeTools(writesTranscript)
    await generateCaptions(makeProject(), (event) => events.push(event))
    const whisper = readFileSync(join(sandbox, 'whisper-args'), 'utf8')
    expect(whisper).toContain(`-m ${join(state.bin, 'models', 'ggml-base.bin')}`)
    expect(whisper).toContain(`--vad -vm ${join(state.bin, 'models', 'ggml-silero-v6.2.0.bin')}`)
    expect(whisper).toContain('-f audio.wav')
    expect(whisper).toContain('-l auto')
    expect(whisper).toContain('-oj')
    expect(whisper).toContain('-ml 1 -sow')
    const ffmpeg = readFileSync(join(sandbox, 'ffmpeg-args'), 'utf8')
    expect(ffmpeg).toContain('-protocol_whitelist file')
    expect(ffmpeg).toContain('-ac 1 -ar 16000')
  })

  unixIt('keeps edits saved while whisper was running', async () => {
    const dir = makeProject()
    const edited = { ...project(), name: 'Renamed mid-run' }
    fakeTools(`cat > "${join(dir, 'project.json')}" <<'JSON'\n${JSON.stringify(edited)}\nJSON\n${writesTranscript}`)
    await generateCaptions(dir, (event) => events.push(event))
    const saved = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as Project
    expect(saved.name).toBe('Renamed mid-run')
    expect(saved.captions).toHaveLength(1)
  })

  unixIt('does not wipe existing captions when no speech is found', async () => {
    fakeTools(`echo '{"transcription": []}' > transcript.json`)
    const existing = [{ id: 'c', startMs: 0, endMs: 1000, text: 'Keep me' }]
    const dir = makeProject(project({ captions: existing }))
    await generateCaptions(dir, (event) => events.push(event))
    expect(failure()).toEqual({ type: 'failed', message: 'No speech was found in the microphone recording.' })
    expect((JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as Project).captions).toEqual(existing)
  })

  unixIt('fails plainly when whisper crashes, without leaking its output', async () => {
    fakeTools(`echo 'secret stderr detail' >&2\nexit 3`)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await generateCaptions(makeProject(), (event) => events.push(event))
    expect(error).toHaveBeenCalled()
    error.mockRestore()
    expect(failure()).toEqual({ type: 'failed', message: 'Captions could not be generated. Your project has not been changed.' })
    expect(readdirSync(join(sandbox, 'temp'))).toEqual([])
  })

  unixIt('removes variables that would make whisper-cli load a library', async () => {
    process.env.ANEFORGE_DYLIB = '/tmp/evil.dylib'
    fakeTools(`env > "${sandbox}/whisper-env"\n${writesTranscript}`)
    await generateCaptions(makeProject(), (event) => events.push(event))
    delete process.env.ANEFORGE_DYLIB
    expect(readFileSync(join(sandbox, 'whisper-env'), 'utf8')).not.toContain('ANEFORGE')
  })

  describe('handler', () => {
    beforeEach(() => {
      state.handlers.clear()
      state.sent = []
      register({ mainWindow: () => ({ webContents: fromMain.sender }) as never, send: (channel, event) => state.sent.push({ channel, event }) })
    })

    unixIt('sends events on the captions channel', async () => {
      fakeTools(writesTranscript)
      const dir = makeProject()
      await state.handlers.get('captions:generate')?.(fromMain, dir)
      expect(state.sent.every((sent) => sent.channel === 'captions:event')).toBe(true)
      expect(state.sent.at(-1)?.event).toEqual({ type: 'done', projectDir: dir })
    })

    unixIt('joins a repeat request and refuses a second project while one runs', async () => {
      fakeTools(writesTranscript)
      const dir = makeProject()
      const other = makeProject(project(), 'other.dolly')
      const handler = state.handlers.get('captions:generate')
      const first = handler?.(fromMain, dir)
      const second = handler?.(fromMain, dir)
      expect(() => handler?.(fromMain, other)).toThrow('still running')
      await Promise.all([first, second])
      expect(state.sent.filter((sent) => (sent.event as CaptionEvent).type === 'done')).toHaveLength(1)
    })
  })
})

describe('caption language', () => {
  const language = (value?: unknown) => {
    const args = whisperArgs('model', 'vad', value)
    return args[args.indexOf('-l') + 1]
  }

  it('passes a chosen language to whisper', () => {
    expect(language('en')).toBe('en')
    expect(language('ru')).toBe('ru')
  })

  it('falls back to detection for anything unknown', () => {
    expect(language()).toBe('auto')
    expect(language('xx')).toBe('auto')
    expect(language('en --help')).toBe('auto')
    expect(language(42)).toBe('auto')
  })
})
