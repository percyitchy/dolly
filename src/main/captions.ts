// captions:generate. Transcribes the mic clip on this machine with whisper-cli and saves the lines
// into project.json. Nothing here touches the network.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { can } from '../shared/entitlements'
import { CAPTION_LANGUAGES, CHANNELS, type CaptionEvent } from '../shared/ipc'
import type { Caption, Ms, Project } from '../shared/project'
import { handleFromMain, type Register } from './context'
import { currentPlan } from './license'
import { defaultDollyFolder, dollyTemp, ffmpegPath, nativeBin, resourcePath } from './paths'
import { assertProject, assertProjectDir, PROJECT_FILE, realProjectFile } from './projects'

const MAX_LINE_CHARS = 42
const MIN_CUT_CHARS = 21 // A line is only cut back to punctuation in its second half
const MIN_SENTENCE_CHARS = 16 // Shorter sentences can share a line, which also keeps "Mr." or "OK." whole
const PAUSE_SPLIT_MS = 800
const MIN_LINE_MS = 800
const CLOSE_GAP_MS = 250 // Lines closer than this touch, so the caption doesn't flicker off
const WORD_BASE_MS = 200 // These two give the longest a word can plausibly take to say
const WORD_MS_PER_CHAR = 80

const SENTENCE_END = /[.!?…。！？]["'»”)\]]*$/
const CLAUSE_END = /[,;:，、；：—–.!?…。！？]["'»”)\]]*$/
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]/g

const WORK_PREFIX = 'captions-'
const WAV = 'audio.wav'
const TRANSCRIPT = 'transcript' // whisper-cli adds .json
const WAV_BYTES_PER_MS = 32 // 16 kHz, 16-bit, mono
const WAV_HEADER_BYTES = 44
const MAX_THREADS = 4 // Metal does the heavy part on macOS, and this keeps the fans down either way
const VAD_PAD_MS = 200 // Keeps soft word starts, and a line that errs early rather than late
const FFMPEG_DONE_PCT = 5
const WHISPER_DONE_PCT = 95

export interface WhisperSegment {
  fromMs: Ms
  toMs: Ms
  text: string
}

interface TimedText {
  text: string
  fromMs: Ms
  toMs: Ms
}

// A failure whose message is fit to show the user as it stands
class CaptionError extends Error {}

// whisper-cli only escapes quotes and backslashes, so a token holding a newline or tab breaks JSON.parse
export function parseWhisperJson(raw: string): WhisperSegment[] {
  const cleaned = raw.replace(/"(?:[^"\\]|\\.)*"/gs, (text) => text.replace(/[\u0000-\u001f]/g, ' '))
  const parsed = JSON.parse(cleaned) as { transcription?: { offsets: { from: number; to: number }; text: string }[] }
  return (parsed.transcription ?? []).map((segment) => ({
    fromMs: segment.offsets.from,
    toMs: segment.offsets.to,
    text: segment.text
  }))
}

function isNonSpeech(text: string): boolean {
  const bare = text.replace(NON_SPEECH, '')
  return bare !== text && !/[\p{L}\p{N}]/u.test(bare)
}

// We ask whisper for one segment per word. Anything longer shares its time out by length
function segmentWords(segment: WhisperSegment): TimedText[] {
  const parts = segment.text.replace(/�/g, '').trim().split(/\s+/).filter(Boolean)
  const units = parts.reduce((sum, part) => sum + part.length + 1, 0)
  const msPerUnit = units > 0 ? (segment.toMs - segment.fromMs) / units : 0
  let cursor = segment.fromMs
  return parts.map((text) => {
    const fromMs = cursor
    cursor += (text.length + 1) * msPerUnit
    return { text, fromMs, toMs: cursor }
  })
}

function keepInOrder(words: TimedText[]): TimedText[] {
  let floor = -Infinity
  return words.map((word) => {
    const fromMs = Math.max(word.fromMs, floor)
    const toMs = Math.max(word.toMs, fromMs)
    floor = toMs
    return { ...word, fromMs, toMs }
  })
}

// Word starts are reliable, ends are not. A word ends where the next one starts, so the last word before a pause
// claims the whole pause, which would hide it from wrapWords and hold the line on screen through the silence
function capWordEnd(word: TimedText): TimedText {
  return { ...word, toMs: Math.min(word.toMs, word.fromMs + WORD_BASE_MS + word.text.length * WORD_MS_PER_CHAR) }
}

// Languages written without spaces arrive as one huge word
function splitOversizedWord(word: TimedText): TimedText[] {
  const chars = Array.from(word.text)
  if (word.text.length <= MAX_LINE_CHARS) return [word]
  const msPerChar = (word.toMs - word.fromMs) / chars.length
  const pieces: TimedText[] = []
  for (let i = 0; i < chars.length; i += MAX_LINE_CHARS) {
    const end = Math.min(i + MAX_LINE_CHARS, chars.length)
    pieces.push({
      text: chars.slice(i, end).join(''),
      fromMs: word.fromMs + i * msPerChar,
      toMs: word.fromMs + end * msPerChar
    })
  }
  return pieces
}

function lengthOf(words: TimedText[]): number {
  return words.reduce((sum, word, i) => sum + word.text.length + (i > 0 ? 1 : 0), 0)
}

// Where to end a full line: after its last punctuation in the back half, or else right at the end
function cutPoint(line: TimedText[]): number {
  for (let i = line.length - 1; i > 0; i--) {
    if (CLAUSE_END.test(line[i - 1].text) && lengthOf(line.slice(0, i)) >= MIN_CUT_CHARS) return i
  }
  return line.length
}

function wrapWords(words: TimedText[]): TimedText[][] {
  const lines: TimedText[][] = []
  let line: TimedText[] = []
  for (const word of words) {
    const last = line.at(-1)
    if (last && word.fromMs - last.toMs > PAUSE_SPLIT_MS) {
      lines.push(line)
      line = []
    }
    while (line.length > 0 && lengthOf([...line, word]) > MAX_LINE_CHARS) {
      const cut = cutPoint(line)
      lines.push(line.slice(0, cut))
      line = line.slice(cut)
    }
    line.push(word)
    if (SENTENCE_END.test(word.text) && lengthOf(line) >= MIN_SENTENCE_CHARS) {
      lines.push(line)
      line = []
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

// Whisper output to Caption objects on the capture clock. offsetMs is the clip's startMs and limitMs is
// where its audio ends, also on the capture clock
export function segmentsToCaptions(segments: WhisperSegment[], offsetMs: Ms, limitMs: Ms = Infinity): Caption[] {
  const spoken = segments.filter((segment) => !isNonSpeech(segment.text)).flatMap(segmentWords)
  const words = keepInOrder(spoken).flatMap(splitOversizedWord).map(capWordEnd)
  const lines = wrapWords(words)
    .map((line) => ({
      text: line.map((word) => word.text).join(' '),
      fromMs: Math.max(0, line[0].fromMs + offsetMs),
      toMs: line[line.length - 1].toMs + offsetMs
    }))
    .filter((line) => /[\p{L}\p{N}]/u.test(line.text) && line.fromMs < limitMs && line.toMs > 0)

  const captions: Caption[] = []
  lines.forEach((line, i) => {
    const next = lines[i + 1]?.fromMs ?? limitMs
    let endMs = Math.max(line.toMs, line.fromMs + MIN_LINE_MS)
    if (next - endMs < CLOSE_GAP_MS) endMs = next
    const startMs = Math.round(line.fromMs)
    endMs = Math.round(Math.min(endMs, next))
    if (endMs > startMs) captions.push({ id: randomUUID(), startMs, endMs, text: line.text })
  })
  return captions
}

async function checkedProjectDir(projectDir: unknown): Promise<string> {
  try {
    return await assertProjectDir(projectDir)
  } catch (error) {
    if (typeof projectDir !== 'string' || projectDir === '' || isMissing(error)) throw new CaptionError('That project could not be found.')
    throw new CaptionError('That project is not in the Dolly folder.')
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function checkedMicPath(dir: string, file: string): Promise<string> {
  try {
    return await realProjectFile(defaultDollyFolder(), dir, file)
  } catch (error) {
    if (isMissing(error)) throw new CaptionError('The microphone recording for this project is missing.')
    throw new CaptionError('The microphone recording is not in the project folder.')
  }
}

async function readProject(dir: string): Promise<Project> {
  try {
    return assertProject(JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')))
  } catch {
    throw new CaptionError('This project could not be read.')
  }
}

// Reads the file fresh, because the editor may have saved other changes while whisper ran
async function saveCaptions(dir: string, captions: Caption[]): Promise<void> {
  const project = await readProject(dir)
  const target = join(dir, PROJECT_FILE)
  const partial = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(partial, JSON.stringify({ ...project, captions }, null, 2))
    await rename(partial, target)
  } finally {
    await rm(partial, { force: true })
  }
}

let running: ChildProcess | null = null
let tempDir: string | null = null

// Our Dolly build has no use for these. ANEFORGE_DYLIB would make whisper-cli load whatever library it names
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ANEFORGE|GGML|WHISPER)_/.test(name)))
}

function runTool(command: string, args: string[], cwd: string, onStderr?: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    running = child
    let tail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      tail = (tail + text).slice(-2000)
      onStderr?.(text)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      running = null
      if (code === 0) resolve()
      else reject(new Error(`${basename(command)} exited with ${code}: ${tail.trim()}`))
    })
  })
}

// The protocol list stops a crafted media file, such as a playlist, from pointing ffmpeg at a URL
function ffmpegArgs(input: string): string[] {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file',
    '-i', input,
    '-vn', '-sn', '-dn', '-map_metadata', '-1',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-fflags', '+bitexact', '-f', 'wav', '-y', WAV
  ]
}

// One segment per word (-ml 1 -sow) with voice detection on. Without detection whisper starts a segment at the end of
// the last one and stretches its words over any pause, which puts lines seconds early. Only segment times get mapped
// back past the removed silence, not token times, hence a segment per word.
// The WAV and the output use relative names on purpose: whisper-cli opens those with narrow paths on Windows, which
// fail under a non-ASCII user folder. The two model paths go through its wide-path code
export function whisperArgs(model: string, vadModel: string, language: unknown = 'auto'): string[] {
  const known = CAPTION_LANGUAGES.some((l) => l.code === language)
  const threads = Math.min(MAX_THREADS, availableParallelism())
  return [
    '-m', model,
    '--vad', '-vm', vadModel, '-vp', String(VAD_PAD_MS),
    '-f', WAV, '-l', known ? (language as string) : 'auto', '-oj', '-of', TRANSCRIPT,
    '-ml', '1', '-sow', '-sns', '-np', '-pp', '-t', String(threads)
  ]
}

function whisperProgress(text: string): number | null {
  const matches = [...text.matchAll(/progress\s*=\s*(\d+)%/g)]
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null
}

function failureMessage(error: unknown): string {
  if (error instanceof CaptionError) return error.message
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'The captions engine is missing from this copy of Dolly.'
  return 'Captions could not be generated. Your project has not been changed.'
}

async function transcribe(
  dir: string,
  micFile: string,
  startMs: Ms,
  language: unknown,
  send: (event: CaptionEvent) => void
): Promise<Caption[]> {
  const micPath = await checkedMicPath(dir, micFile)
  await mkdir(dollyTemp(), { recursive: true })
  const workDir = await mkdtemp(join(dollyTemp(), `${WORK_PREFIX}${process.pid}-`))
  tempDir = workDir
  try {
    await runTool(ffmpegPath(), ffmpegArgs(micPath), workDir)
    send({ type: 'progress', pct: FFMPEG_DONE_PCT })

    let shown = FFMPEG_DONE_PCT
    const args = whisperArgs(resourcePath('models', 'ggml-base.bin'), resourcePath('models', 'ggml-silero-v6.2.0.bin'), language)
    await runTool(nativeBin('whisper-cli'), args, workDir, (text) => {
      const progress = whisperProgress(text)
      if (progress === null) return
      const pct = Math.round(FFMPEG_DONE_PCT + (progress / 100) * (WHISPER_DONE_PCT - FFMPEG_DONE_PCT))
      if (pct > shown) send({ type: 'progress', pct: (shown = pct) })
    })

    const segments = parseWhisperJson(await readFile(join(workDir, `${TRANSCRIPT}.json`), 'utf8'))
    const audioMs = ((await stat(join(workDir, WAV))).size - WAV_HEADER_BYTES) / WAV_BYTES_PER_MS
    return segmentsToCaptions(segments, startMs, startMs + audioMs)
  } finally {
    tempDir = null
    await rm(workDir, { recursive: true, force: true })
  }
}

export async function generateCaptions(
  projectDir: unknown,
  send: (event: CaptionEvent) => void,
  language: unknown = 'auto'
): Promise<void> {
  try {
    if (!can(currentPlan(), 'captions')) throw new CaptionError('Captions are a Pro feature.')
    const dir = await checkedProjectDir(projectDir)
    const project = await readProject(dir)
    const mic = project.clips.find((clip) => clip.kind === 'mic')
    if (!mic) throw new CaptionError('This recording has no microphone audio, so there is nothing to caption.')

    send({ type: 'progress', pct: 0 })
    const captions = await transcribe(dir, mic.file, mic.startMs, language, send)
    if (captions.length === 0) throw new CaptionError('No speech was found in the microphone recording.')

    await saveCaptions(dir, captions)
    send({ type: 'progress', pct: 100 })
    send({ type: 'done', projectDir: projectDir as string })
  } catch (error) {
    if (!(error instanceof CaptionError)) console.error('Captions failed:', error)
    send({ type: 'failed', message: failureMessage(error) })
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' // Alive, and someone else's
  }
}

// A crash can't clean up, and what's left in the temp folder is a copy of the user's voice. A work folder carries
// its owner's process ID, so one that belongs to another running Dolly stays
export async function sweepTemp(root: string = dollyTemp(), running: (pid: number) => boolean = isRunning): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[])
  await Promise.all(
    names.map(async (name) => {
      const owner = new RegExp(`^${WORK_PREFIX}(\\d+)-`).exec(name)?.[1]
      if (owner && running(Number(owner))) return
      await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
    })
  )
}

export const register: Register = (ctx) => {
  let job: { dir: unknown; done: Promise<void> } | null = null

  handleFromMain(ctx, 'captions:generate', (projectDir: unknown, language: unknown) => {
    if (job && job.dir !== projectDir) throw new Error('Captions are still running for another recording.')
    if (job) return job.done
    const done = generateCaptions(projectDir, (event) => ctx.send(CHANNELS.captionEvent, event), language).finally(() => {
      job = null
    })
    job = { dir: projectDir, done }
    return done
  })

  // Don't leave whisper running, or the temp copy of the user's voice on disk
  app.on('will-quit', () => {
    running?.kill()
    if (!tempDir) return
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // The OS temp folder clears this later
    }
  })
}
