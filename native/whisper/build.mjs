// Builds whisper-cli and fetches the base model into native/bin/<platform>-<arch>.
// The download happens here at build time only. The app itself never touches the network.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { constants, chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const REPO = 'https://github.com/ggml-org/whisper.cpp.git'
const TAG = 'v1.9.5'
const COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037' // What the tag pointed to when pinned. A moved tag fails the build
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
const MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
// Silero voice detection. Without it whisper stretches word times across every pause. It's the same file as the
// published ggml-silero-v6.2.0.bin and it ships inside the pinned checkout, so it needs no download
const VAD_SOURCE = 'for-tests-silero-v6.2.0-ggml.bin'
const VAD_NAME = 'ggml-silero-v6.2.0.bin'
const VAD_SHA256 = '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'
const DOWNLOAD_ATTEMPTS = 3
const BUILD_JOBS = Math.min(4, availableParallelism()) // More than this cooks a laptop for no real gain on a build this small
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, 'src')
const buildDir = join(here, '.build')
const modelsDir = join(here, 'models')
const stampFile = join(buildDir, 'dolly-stamp.json')
const binDir = join(here, '..', 'bin', `${process.platform}-${process.arch}`)
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
const exe = isWin ? '.exe' : ''

// GGML_NATIVE stays off: -mcpu=native on this M4 or a CI runner would produce a binary that can crash on other Macs and PCs.
// OpenMP stays off because on MSVC it pulls in vcomp140.dll
const commonFlags = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_IS_DEV=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_CURL=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DWHISPER_COMMON_FFMPEG=OFF',
  '-DWHISPER_COREML=OFF',
  '-DWHISPER_OPENVINO=OFF',
  '-DGGML_NATIVE=OFF',
  '-DGGML_OPENMP=OFF',
  '-DGGML_CCACHE=OFF',
  '-DGGML_BACKEND_DL=OFF'
]
const macFlags = [
  '-DGGML_METAL=ON',
  '-DGGML_METAL_EMBED_LIBRARY=ON',
  '-DGGML_METAL_NDEBUG=ON',
  '-DGGML_ACCELERATE=ON',
  '-DCMAKE_OSX_ARCHITECTURES=arm64',
  '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3'
]
// Static CRT, so whisper-cli.exe needs no Visual C++ redistributable. The policy line is needed because
// whisper.cpp declares CMake 3.5, which predates CMAKE_MSVC_RUNTIME_LIBRARY
const winFlags = [
  '-DGGML_METAL=OFF',
  '-DGGML_BLAS=OFF',
  '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
  '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'
]
const flags = [...commonFlags, ...(isMac ? macFlags : []), ...(isWin ? winFlags : [])]

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function findCmake() {
  for (const candidate of ['cmake', '/opt/homebrew/bin/cmake', '/usr/local/bin/cmake']) {
    if (spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0) return candidate
  }
  throw new Error('cmake not found. Install it first, for example with: brew install cmake')
}

function sourceCommit() {
  if (!existsSync(join(srcDir, '.git'))) return null
  const result = spawnSync('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

async function ensureSource() {
  if (sourceCommit() === COMMIT) return
  await rm(srcDir, { recursive: true, force: true })
  run('git', ['clone', '--depth', '1', '--branch', TAG, '--config', 'advice.detachedHead=false', '--config', 'core.autocrlf=false', REPO, srcDir])
  const commit = sourceCommit()
  if (commit !== COMMIT) throw new Error(`${TAG} resolves to ${commit}, expected ${COMMIT}`)
}

async function readStamp() {
  try {
    return await readFile(stampFile, 'utf8')
  } catch {
    return null
  }
}

async function findBuiltBinary() {
  const name = `whisper-cli${exe}`
  for (const dir of [join(buildDir, 'bin', 'Release'), join(buildDir, 'bin')]) {
    if (existsSync(join(dir, name))) return join(dir, name)
  }
  throw new Error(`Built ${name} not found under ${join(buildDir, 'bin')}`)
}

async function buildBinary() {
  const wanted = JSON.stringify({ commit: COMMIT, flags })
  const target = join(binDir, `whisper-cli${exe}`)
  const stale = (await readStamp()) !== wanted
  if (stale) await rm(buildDir, { recursive: true, force: true })

  if (stale || !existsSync(target)) {
    if (stale) {
      await ensureSource()
      const cmake = findCmake()
      run(cmake, ['-S', srcDir, '-B', buildDir, ...flags])
      run(cmake, ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli', '--parallel', String(BUILD_JOBS)])
    }
    const built = await findBuiltBinary()
    await mkdir(binDir, { recursive: true })
    await rm(target, { force: true })
    await copyFile(built, target)
    await chmod(target, 0o755)
    // Static on both platforms today, but anything that does land beside the exe has to ship with it
    if (isWin) {
      for (const file of await readdir(dirname(built))) {
        if (file.toLowerCase().endsWith('.dll')) await copyFile(join(dirname(built), file), join(binDir, file))
      }
    }
    await writeFile(stampFile, wanted)
  } else {
    console.log(`whisper-cli ${TAG} already built`)
  }

  if (existsSync(join(srcDir, 'LICENSE'))) await copyFile(join(srcDir, 'LICENSE'), join(binDir, 'whisper.cpp.LICENSE'))
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function hasFile(path, expected) {
  return existsSync(path) && (await sha256(path)) === expected
}

async function downloadOnce(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok || !response.body) throw new Error(`${url} returned ${response.status}`)

  const part = `${destination}.part`
  const total = Number(response.headers.get('content-length') ?? 0)
  const hash = createHash('sha256')
  let received = 0
  let lastLog = 0
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk)
      received += chunk.length
      if (received - lastLog >= 32 * 1024 * 1024) {
        lastLog = received
        console.log(`  ${Math.round(received / 1048576)} MB${total ? ` of ${Math.round(total / 1048576)} MB` : ''}`)
      }
      done(null, chunk)
    }
  })

  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(part))
    const actual = hash.digest('hex')
    if (actual !== MODEL_SHA256) throw new Error(`Model SHA-256 mismatch: got ${actual}, expected ${MODEL_SHA256}`)
    await rename(part, destination)
  } finally {
    await rm(part, { force: true })
  }
}

async function ensureModel() {
  const cached = join(modelsDir, 'ggml-base.bin')
  if (await hasFile(cached, MODEL_SHA256)) {
    console.log('ggml-base.bin already downloaded and verified')
  } else {
    await mkdir(modelsDir, { recursive: true })
    await rm(cached, { force: true })
    for (let attempt = 1; ; attempt++) {
      console.log(`Downloading ggml-base.bin, attempt ${attempt} of ${DOWNLOAD_ATTEMPTS}`)
      try {
        await downloadOnce(MODEL_URL, cached)
        break
      } catch (error) {
        if (attempt === DOWNLOAD_ATTEMPTS) throw error
        console.log(`  failed: ${error.message}`)
      }
    }
  }

  const target = join(binDir, 'models', 'ggml-base.bin')
  if (await hasFile(target, MODEL_SHA256)) return
  await mkdir(dirname(target), { recursive: true })
  await rm(target, { force: true })
  await copyFile(cached, target, constants.COPYFILE_FICLONE)
}

async function ensureVadModel() {
  const target = join(binDir, 'models', VAD_NAME)
  if (await hasFile(target, VAD_SHA256)) return
  await ensureSource()
  const source = join(srcDir, 'models', VAD_SOURCE)
  if (!(await hasFile(source, VAD_SHA256))) throw new Error(`${VAD_SOURCE} is missing or has the wrong SHA-256`)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

async function report() {
  const binary = await stat(join(binDir, `whisper-cli${exe}`))
  const model = await stat(join(binDir, 'models', 'ggml-base.bin'))
  const vad = await stat(join(binDir, 'models', VAD_NAME))
  const mb = (file) => `${(file.size / 1048576).toFixed(1)} MB`
  console.log(`whisper-cli ${mb(binary)}, ggml-base.bin ${mb(model)}, ${VAD_NAME} ${mb(vad)}, in ${binDir}`)
}

await buildBinary()
await ensureModel()
await ensureVadModel()
await report()
