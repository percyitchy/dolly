// Real run for acceptance check A14, macOS only: node tests/captions-accuracy.mjs
// Speaks a known script with `say`, converts it with the app's ffmpeg, runs the built whisper-cli
// with network denied by sandbox-exec, and measures word accuracy against the script.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGET = 0.9
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(root, 'native/bin', `${process.platform}-${process.arch}`)
const whisper = join(binDir, 'whisper-cli')
const model = join(binDir, 'models/ggml-base.bin')
const vadModel = join(binDir, 'models/ggml-silero-v6.2.0.bin')
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')

const DENY_NETWORK = '(version 1)(allow default)(deny network*)'

export const SCRIPTS = [
  {
    name: 'English, Samantha',
    voice: 'Samantha',
    language: 'en',
    text: `Welcome to this short walkthrough of the new dashboard. First, open the settings page and choose the
      account you want to review. Next, click the export button in the top corner and wait a few seconds for the
      report to finish. When the file is ready, you can share it with your team or save it to a folder on your
      computer. If anything looks wrong, go back to the previous step and try again. That is everything you need
      to know to get started today. Thanks for watching, and good luck with your first project.`
  },
  {
    name: 'English, Daniel',
    voice: 'Daniel',
    language: 'en',
    text: `In this video I will show you how to fix a slow build. Start by looking at the largest files in the
      project, because they usually take the most time to compile. Then remove anything you no longer use and
      split the rest into smaller pieces. After that, run the build again and compare the numbers with the old
      result. Most people see a big improvement after the first pass, and the second pass is usually much easier
      than the first one was.`
  },
  {
    name: 'Russian, Milena',
    voice: 'Milena',
    language: 'ru',
    text: `Здравствуйте, сегодня я покажу вам, как быстро записать видео с экрана. Сначала откройте настройки и
      выберите нужный монитор. Затем нажмите на красную кнопку и подождите три секунды. Когда запись начнётся,
      спокойно расскажите о том, что вы делаете на экране. После этого остановите запись и посмотрите результат.
      Программа сама добавит плавное приближение на каждый щелчок мыши. Если вам всё нравится, сохраните файл на
      компьютер и отправьте его своим коллегам. Спасибо за внимание и удачи в работе.`
  }
]

export function normalise(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

// Word error rate by edit distance. Accuracy is 1 minus that rate
export function wordAccuracy(reference, hypothesis) {
  const ref = normalise(reference)
  const hyp = normalise(hypothesis)
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const current = [i]
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return { accuracy: Math.max(0, 1 - previous[hyp.length] / ref.length), words: ref.length, errors: previous[hyp.length] }
}

function mustRun(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr}`)
  return result
}

const PAUSES_MS = [3000, 4000, 2000, 6000, 3000, 5000, 2000, 4000]

// Each sentence spoken on its own with silence between, because a recording is rarely wall-to-wall talking.
// Sentences, not a fixed time, so a pause never lands in the middle of a word
function speakWithPauses(script, stem) {
  const sentences = script.text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+/g).map((sentence) => sentence.trim())
  const inputs = []
  const parts = []
  sentences.forEach((sentence, i) => {
    const aiff = `${stem}-${i}.aiff`
    mustRun('say', ['-v', script.voice, '-o', aiff, sentence])
    inputs.push('-i', aiff)
    parts.push(`[${i}:a]aresample=16000,aformat=channel_layouts=mono,adelay=${PAUSES_MS[i % PAUSES_MS.length]}:all=1[p${i}]`)
  })
  const labels = sentences.map((_, i) => `[p${i}]`).join('')
  const filter = `${parts.join(';')};${labels}concat=n=${sentences.length}:v=0:a=1[o]`
  mustRun(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[o]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', `${stem}.wav`])
}

function transcribe(script, dir, paused) {
  const stem = join(dir, `${script.voice}${paused ? '-paused' : ''}`)
  if (paused) {
    speakWithPauses(script, stem)
  } else {
    mustRun('say', ['-v', script.voice, '-o', `${stem}.aiff`, script.text.replace(/\s+/g, ' ')])
    mustRun(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', `${stem}.aiff`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', `${stem}.wav`])
  }
  const audioSeconds = (statSync(`${stem}.wav`).size - 44) / 32000
  // The same flags as whisperArgs in src/main/captions.ts
  const args = ['-p', DENY_NETWORK, whisper, '-m', model, '--vad', '-vm', vadModel, '-vp', '200', '-f', `${stem}.wav`, '-l', 'auto', '-oj', '-of', stem, '-ml', '1', '-sow', '-sns', '-np', '-t', '4']
  const started = performance.now()
  mustRun('/usr/bin/sandbox-exec', args)
  const seconds = (performance.now() - started) / 1000
  const json = JSON.parse(readFileSync(`${stem}.json`, 'utf8'))
  const text = json.transcription.map((segment) => segment.text).join(' ')
  return { audioSeconds, seconds, text, language: json.result.language, ...wordAccuracy(script.text, text) }
}

function proveSandboxBlocksNetwork() {
  const blocked = spawnSync('/usr/bin/sandbox-exec', ['-p', DENY_NETWORK, '/usr/bin/curl', '-sS', '-m', '5', '-o', '/dev/null', 'https://example.com'], { encoding: 'utf8' })
  const open = spawnSync('/usr/bin/curl', ['-sS', '-m', '10', '-o', '/dev/null', 'https://example.com'], { encoding: 'utf8' })
  console.log(`Sandbox check: curl denied exit ${blocked.status} (${blocked.stderr.trim()}), curl without sandbox exit ${open.status}`)
  if (blocked.status === 0) throw new Error('The sandbox did not block the network, so this run proves nothing')
}

function main() {
  if (process.platform !== 'darwin') throw new Error('This check needs macOS: it uses say and sandbox-exec')
  if (!existsSync(whisper) || !existsSync(model) || !existsSync(vadModel)) throw new Error('Run node native/whisper/build.mjs first')
  proveSandboxBlocksNetwork()

  const dir = mkdtempSync(join(tmpdir(), 'dolly-accuracy-'))
  const results = []
  try {
    for (const script of SCRIPTS) {
      for (const paused of [false, true]) {
        const result = transcribe(script, dir, paused)
        const pct = (result.accuracy * 100).toFixed(1)
        const speed = (result.audioSeconds / result.seconds).toFixed(1)
        console.log(`\n${script.name}${paused ? ', with pauses' : ''}: ${pct}% of ${result.words} words (${result.errors} errors), detected ${result.language}`)
        console.log(`  ${result.audioSeconds.toFixed(1)} s audio in ${result.seconds.toFixed(2)} s, ${speed}x real time`)
        console.log(`  Heard: ${result.text.replace(/\s+/g, ' ').trim()}`)
        results.push({ script, result })
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = results.filter(({ script, result }) => result.accuracy < TARGET || result.language !== script.language)
  if (failed.length > 0) {
    console.error(`\nBelow ${TARGET * 100}% or wrong language: ${failed.map(({ script }) => script.name).join(', ')}`)
    process.exit(1)
  }
  console.log(`\nAll scripts at ${TARGET * 100}% or better, with network denied`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
