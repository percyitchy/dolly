// Compiles the capture helper with swiftc into native/bin/<platform>-<arch>. Command Line Tools are enough
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') process.exit(0)

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'bin', `${process.platform}-${process.arch}`)
mkdirSync(outDir, { recursive: true })

const swiftArch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim()
const out = join(outDir, 'dolly-capture')

const run = spawnSync(
  'swiftc',
  [
    '-O',
    '-swift-version', '5',
    '-target', `${swiftArch}-apple-macos13.0`,
    '-sdk', sdk,
    '-framework', 'ScreenCaptureKit',
    '-framework', 'AVFoundation',
    '-framework', 'CoreMedia',
    '-framework', 'CoreVideo',
    '-framework', 'CoreGraphics',
    '-framework', 'VideoToolbox',
    '-o', out,
    join(here, 'main.swift')
  ],
  { stdio: 'inherit' }
)
if (run.status !== 0) process.exit(run.status ?? 1)
console.log(`Built ${out}`)
