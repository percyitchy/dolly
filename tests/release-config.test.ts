// H1, H2, L5, L6: what a release build and its workflow promise. The packaged result itself needs a full
// electron-builder run, which the workflow's own checks cover.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const builder = read('electron-builder.yml')
const workflow = read('.github/workflows/release.yml')
const [, macJob, windowsJob] = /^(.*)^ {2}windows:\n(.*)^ {2}release:\n/ms.exec(workflow) ?? []

describe('electron-builder.yml', () => {
  it.each([
    ['runAsNode', 'false'],
    ['enableNodeOptionsEnvironmentVariable', 'false'],
    ['enableNodeCliInspectArguments', 'false'],
    ['enableEmbeddedAsarIntegrityValidation', 'true'],
    ['onlyLoadAppFromAsar', 'true']
  ])('sets the %s fuse to %s', (fuse, value) => {
    expect(builder).toMatch(new RegExp(`^electronFuses:\\n(?:  .*\\n)*?  ${fuse}: ${value}$`, 'm'))
  })

  it('turns the hardened runtime on', () => {
    expect(builder).toMatch(/^ {2}hardenedRuntime: true$/m)
  })

  it('keeps what the hardened runtime needs for Electron, the mic and the camera', () => {
    const plist = read('build/entitlements.mac.plist')
    for (const key of ['cs.allow-jit', 'cs.disable-library-validation', 'device.audio-input', 'device.camera']) {
      expect(plist).toContain(`com.apple.security.${key}`)
    }
  })
})

describe('uiohook-napi per platform', () => {
  const section = (name: string) => new RegExp(`^${name}:\\n((?:(?: .*)?\\n)+)`, 'm').exec(builder)?.[1] ?? ''

  it('leaves it and its loader out of the macOS package', () => {
    expect(section('mac')).toContain("- '!**/node_modules/uiohook-napi{,/**}'")
    expect(section('mac')).toContain("- '!**/node_modules/node-gyp-build{,/**}'")
  })

  it('keeps it in the Windows package, with the Windows prebuild', () => {
    expect(section('win')).toContain("- '!**/node_modules/uiohook-napi/prebuilds/!(win32-x64)/**'")
    expect(section('win')).not.toContain("- '!**/node_modules/uiohook-napi{,/**}'")
    expect(builder).toContain("- '**/node_modules/uiohook-napi/prebuilds/**'")
  })

  it('checks both packaged apps', () => {
    expect(macJob).toMatch(/test ! -e "\$app\/Contents\/Resources\/app\.asar\.unpacked\/node_modules\/uiohook-napi"/)
    expect(macJob).toMatch(/asar list "\$app\/Contents\/Resources\/app\.asar" \| grep -q 'node_modules\/uiohook-napi'/)
    expect(windowsJob).toMatch(/test -f "\$app\/resources\/app\.asar\.unpacked\/node_modules\/uiohook-napi\/prebuilds\/win32-x64\/uiohook-napi\.node"/)
  })

  it('only reaches uiohook-napi through one dynamic import, behind the hook source', () => {
    const input = read('src/main/input.ts')
    expect(input.match(/uiohook-napi'/g)).toHaveLength(1)
    expect(input).toMatch(/await import\('uiohook-napi'\)/)
    expect(input).toMatch(/if \(source\.kind === 'tap'\) return/)
    for (const file of ['src/main/capture.ts', 'src/main/permissions.ts', 'src/main/index.ts']) expect(read(file)).not.toContain('uiohook')
  })
})

describe('release.yml', () => {
  it('splits into the two build jobs', () => {
    expect(macJob).toContain('runs-on: macos-latest')
    expect(windowsJob).toContain('runs-on: windows-latest')
  })

  const placeholderStep = (job: string) => /- name: Check the release config has no placeholders\n\s+if: startsWith\(github\.ref, 'refs\/tags\/'\)\n\s+run: \|\n((?:\s{10}.*\n)+)/.exec(job)?.[1].replace(/^ {10}/gm, '')

  it.each([
    ['mac', () => macJob],
    ['windows', () => windowsJob]
  ])('%s refuses a build with placeholders', (_, job) => {
    const script = placeholderStep(job())
    expect(script).toBeTruthy()
    const dir = mkdtempSync(join(tmpdir(), 'dolly-config-'))
    mkdirSync(join(dir, 'src/shared'), { recursive: true })
    const run = (config: string) => {
      writeFileSync(join(dir, 'src/shared/config.ts'), config)
      return spawnSync('bash', ['-e', '-c', script as string], { cwd: dir, encoding: 'utf8' }).status
    }
    expect(run("export const LICENSE_PUBLIC_KEY = 'REPLACE_ME'\n")).toBe(1)
    expect(run("export const LICENSE_PUBLIC_KEY = 'abc'\n")).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('has no ! pipeline, which only a last line could fail on under bash -e', () => {
    expect(workflow).not.toMatch(/^\s*! /m)
    const old = (dir: string) => spawnSync('bash', ['-e', '-c', '! echo bad | grep -q bad\necho carried on'], { cwd: dir, encoding: 'utf8' }).stdout
    expect(old(tmpdir())).toContain('carried on') // Why: the failed check above didn't stop anything
  })

  describe('the checks on what must not be in the macOS app', () => {
    const blocks = [...macJob.matchAll(/^ {10}(if .*\| grep -qi? .*; then\n(?: {12}.*\n)+ {10}fi)$/gm)].map((match) => match[1].replace(/^ {10}/gm, ''))

    function run(asarList: string, ffmpegList: string) {
      const dir = mkdtempSync(join(tmpdir(), 'dolly-checks-'))
      const fake = (path: string, text: string) => {
        mkdirSync(join(dir, path, '..'), { recursive: true })
        writeFileSync(join(dir, path), `#!/bin/sh\necho '${text}'\n`, { mode: 0o755 })
      }
      fake('node_modules/.bin/asar', asarList)
      fake('Dolly.app/Contents/Resources/bin/ffmpeg', ffmpegList)
      const result = spawnSync('bash', ['-e', '-c', `app=Dolly.app\n${blocks.join('\n')}\necho all clear`], { cwd: dir, encoding: 'utf8' })
      rmSync(dir, { recursive: true, force: true })
      return { status: result.status, stdout: result.stdout }
    }

    it('finds both checks', () => {
      expect(blocks).toHaveLength(2)
    })

    it('passes a clean app', () => {
      expect(run('/out/main/index.js', ' T.. = libx264')).toEqual({ status: 0, stdout: 'all clear\n' })
    })

    it('stops on uiohook-napi in the archive, with a check still to come', () => {
      const { status, stdout } = run('/node_modules/uiohook-napi/index.js', ' T.. = libx264')
      expect(status).toBe(1)
      expect(stdout).not.toContain('all clear')
    })

    it('stops on a nonfree ffmpeg', () => {
      const { status, stdout } = run('/out/main/index.js', 'This version of ffmpeg has nonfree parts compiled in')
      expect(status).toBe(1)
      expect(stdout).not.toContain('all clear')
    })
  })

  it('checks placeholders before spending time on a build', () => {
    expect(macJob.indexOf('no placeholders')).toBeLessThan(macJob.indexOf('npm ci'))
    expect(windowsJob.indexOf('no placeholders')).toBeLessThan(windowsJob.indexOf('npm ci'))
  })

  it.each([
    ['mac', () => macJob, 'release/mac-arm64/Dolly.app/Contents/Resources'],
    ['windows', () => windowsJob, 'release/win-unpacked/resources']
  ])('%s scans the packaged app and the unpacked archive for secrets', (_, job, resources) => {
    const text = job()
    expect(text).toContain(`resources=${resources}`)
    expect(text).toMatch(/asar extract "\$resources\/app\.asar" "\$RUNNER_TEMP\/app-asar"/)
    expect(text).toMatch(/DOLLY_SCAN_PATH="\$RUNNER_TEMP\/app-asar" npx vitest run tests\/license-secrets\.test\.ts/)
    expect(text).toMatch(/DOLLY_SCAN_PATH="\$resources" npx vitest run tests\/license-secrets\.test\.ts/)
    expect(text.indexOf('electron-builder --')).toBeLessThan(text.indexOf('Scan the packaged app'))
  })

  it('pins the Windows ffmpeg binary to the version in package.json', () => {
    const pkg = JSON.parse(read('node_modules/ffmpeg-static/package.json'))
    expect(pkg['ffmpeg-static']['binary-release-tag']).toBe('b6.1.1')
    expect(windowsJob).toMatch(/'[0-9a-f]{64} {2}node_modules\/ffmpeg-static\/ffmpeg\.exe' \| sha256sum --check --strict/)
    expect(windowsJob.indexOf('npm ci')).toBeLessThan(windowsJob.indexOf('sha256sum'))
  })
})
