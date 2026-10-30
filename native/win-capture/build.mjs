// Builds the capture helper with CMake into native/bin/<platform>-<arch>. Windows only
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'win32') process.exit(0)

const here = dirname(fileURLToPath(import.meta.url))
const build = join(here, '.build')
const outDir = resolve(here, '..', 'bin', `${process.platform}-${process.arch}`)
mkdirSync(outDir, { recursive: true })

function run(args) {
  const result = spawnSync('cmake', args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const arch = process.arch === 'arm64' ? 'ARM64' : 'x64'
run(['-S', here, '-B', build, '-A', arch])
run(['--build', build, '--config', 'Release'])
const out = join(outDir, 'dolly-capture.exe')
copyFileSync(join(build, 'Release', 'dolly-capture.exe'), out)
console.log(`Built ${out}`)
