// Builds the macOS ffmpeg from pinned sources, because ffmpeg-static's macOS binary is built with
// --enable-nonfree and says it can't be redistributed. Windows keeps ffmpeg-static's GPL build.

import { existsSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') process.exit(0)

const root = dirname(fileURLToPath(import.meta.url))
const FFMPEG = { url: 'https://github.com/FFmpeg/FFmpeg.git', commit: '3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587', tag: 'n7.1.5' }
const X264 = { url: 'https://code.videolan.org/videolan/x264.git', commit: 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55', tag: 'stable' }
const JOBS = '-j4'
const MIN_MACOS = '13.0'

const src = join(root, 'src')
const prefix = join(root, 'build')
const bin = join(root, '..', 'bin', `${process.platform}-${process.arch}`)
const output = join(bin, 'ffmpeg')
const stamp = join(bin, 'ffmpeg.build')
const buildId = `${FFMPEG.commit} ${X264.commit}`

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed`)
}

// Fetches exactly one commit, so a moved tag can't change what gets built
function checkout(name, { url, commit }) {
  const dir = join(src, name)
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' })
  if (existsSync(dir) && head.stdout?.trim() === commit) return dir
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  run('git', ['init', '-q'], dir)
  run('git', ['fetch', '-q', '--depth', '1', url, commit], dir)
  run('git', ['checkout', '-q', 'FETCH_HEAD'], dir)
  return dir
}

function buildX264() {
  const dir = checkout('x264', X264)
  run('./configure', [
    `--prefix=${prefix}`,
    '--enable-static',
    '--enable-pic',
    '--disable-cli',
    '--disable-opencl',
    '--disable-avs',
    '--disable-swscale',
    '--disable-lavf',
    '--disable-ffms',
    '--disable-gpac',
    '--disable-lsmash',
    '--bit-depth=8',
    `--extra-cflags=-mmacosx-version-min=${MIN_MACOS}`,
    `--extra-ldflags=-mmacosx-version-min=${MIN_MACOS}`
  ], dir)
  run('make', [JOBS], dir)
  run('make', ['install'], dir)
}

// Only what Dolly's ffmpeg commands use: see export.ts, capture.ts and captions.ts
const COMPONENTS = {
  protocol: ['file', 'pipe'],
  demuxer: ['mov', 'matroska', 'rawvideo', 'wav'],
  muxer: ['mp4', 'mov', 'gif', 'rawvideo', 'framecrc', 'wav', 'webm', 'matroska', 'null'],
  decoder: ['h264', 'vp8', 'vp9', 'av1', 'opus', 'vorbis', 'aac', 'pcm_s16le', 'rawvideo'],
  encoder: ['libx264', 'aac', 'gif', 'rawvideo', 'pcm_s16le', 'wrapped_avframe'],
  parser: ['h264', 'vp8', 'vp9', 'av1', 'opus', 'aac', 'vorbis'],
  bsf: ['aac_adtstoasc', 'extract_extradata', 'h264_mp4toannexb', 'vp9_superframe'],
  filter: ['scale', 'format', 'aformat', 'aresample', 'asetpts', 'setpts', 'adelay', 'atrim', 'trim', 'apad', 'palettegen', 'paletteuse', 'null', 'anull', 'fps']
}

function buildFfmpeg() {
  const dir = checkout('ffmpeg', FFMPEG)
  const flags = Object.entries(COMPONENTS).map(([kind, names]) => `--enable-${kind}=${names.join(',')}`)
  const env = { ...process.env, PKG_CONFIG_PATH: join(prefix, 'lib/pkgconfig') }
  run('./configure', [
    `--prefix=${prefix}`,
    '--disable-everything',
    '--disable-autodetect',
    '--disable-network',
    '--disable-doc',
    '--disable-debug',
    '--disable-ffplay',
    '--disable-ffprobe',
    '--disable-shared',
    '--enable-static',
    '--enable-gpl',
    '--enable-libx264',
    '--enable-ffmpeg',
    ...flags,
    `--extra-cflags=-mmacosx-version-min=${MIN_MACOS}`,
    `--extra-ldflags=-mmacosx-version-min=${MIN_MACOS}`
  ], dir, env)
  run('make', [JOBS], dir, env)
  mkdirSync(bin, { recursive: true })
  copyFileSync(join(dir, 'ffmpeg'), output)
  copyFileSync(join(dir, 'COPYING.GPLv2'), join(bin, 'ffmpeg.LICENSE'))
}

function assertRedistributable() {
  const license = spawnSync(output, ['-hide_banner', '-L'], { encoding: 'utf8' })
  const text = `${license.stdout}${license.stderr}`
  if (license.status !== 0 || /nonfree|not legally redistributable/i.test(text)) throw new Error('ffmpeg is not redistributable')
  const links = spawnSync('otool', ['-L', output], { encoding: 'utf8' }).stdout
  if (/homebrew|\/usr\/local/.test(links)) throw new Error('ffmpeg links a non-system library')
}

if (existsSync(output) && existsSync(stamp) && readFileSync(stamp, 'utf8') === buildId) {
  assertRedistributable()
  process.exit(0)
}

rmSync(prefix, { recursive: true, force: true })
buildX264()
buildFfmpeg()
assertRedistributable()
writeFileSync(stamp, buildId)
