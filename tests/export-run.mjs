#!/usr/bin/env node
// Runs the real export pipeline on one project, with no UI and with Pro on. For acceptance runs:
//   node tests/export-run.mjs <project dir> [--out <folder>] [--shape 16:9] [--resolution 1080p] [--fps 60]
//                             [--threads 4]
// Prints one JSON line with the exported file and its speed.

import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    shape: { type: 'string', default: '16:9' },
    resolution: { type: 'string', default: '1080p' },
    fps: { type: 'string', default: '60' },
    threads: { type: 'string' }
  }
})
const projectDir = positionals[0] && resolve(positionals[0])
if (!projectDir) {
  console.error('Usage: node tests/export-run.mjs <project dir> [--out <folder>]')
  process.exit(2)
}

await promisify(execFile)(join(ROOT, 'node_modules/.bin/electron-vite'), ['build', '-c', 'tests/export.vite.config.ts', '-l', 'warn'], { cwd: ROOT })

const work = await mkdtemp(join(tmpdir(), 'dolly-export-run-'))
const result = join(work, 'result.json')
const config = join(work, 'config.json')
await writeFile(
  config,
  JSON.stringify({
    result,
    jobs: [
      {
        name: 'run',
        projectDir,
        plan: 'pro',
        threads: values.threads ? Number(values.threads) : undefined,
        specStride: 1000000,
        output: {
          shapes: [values.shape],
          format: 'mp4',
          resolution: values.resolution,
          fps: Number(values.fps),
          folder: resolve(values.out ?? projectDir)
        }
      }
    ]
  })
)

const child = spawn(ELECTRON, [join(ROOT, 'dist/export-test/main/index.js')], {
  env: { ...process.env, DOLLY_EXPORT_TEST_CONFIG: config },
  stdio: ['ignore', 'ignore', 'inherit']
})
const code = await new Promise((done) => child.once('close', done))
const { results } = JSON.parse(await readFile(result, 'utf8').catch(() => '{"results":[{}]}'))
const { error, stats } = results[0]
await rm(work, { recursive: true, force: true })
if (code !== 0 || error || !stats?.[0]) {
  console.error(error ?? `Electron exited with ${code}`)
  process.exit(1)
}
const s = stats[0]
console.log(JSON.stringify({ file: s.file, frames: s.frames, seconds: s.renderMs / 1000, fps: s.frames / (s.renderMs / 1000) }))
