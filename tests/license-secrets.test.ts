// A7: no Whop API key or signing key in the source, the app or the installer contents.
// Scans the built output whenever it exists. Point DOLLY_SCAN_PATH at anything else, such as an unpacked app.

import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const self = fileURLToPath(import.meta.url)

const SOURCE_ROOTS = ['api', 'src', 'scripts', 'tests', '.github', 'vercel.json', '.vercelignore', 'package.json', 'electron-builder.yml']
const BUILT_ROOTS = ['out', 'dist', 'release', process.env.DOLLY_SCAN_PATH ?? '']
const SKIP_DIRS = new Set(['node_modules', '.git', '.build'])
const SKIP_FILES = /\.(dmg|exe|zip|blockmap|7z|png|jpg|mp4|mov|bin)$/i

const SECRET_PATTERNS: [string, RegExp][] = [
  ['an Ed25519 private key', /MC4CAQAwBQYDK2VwBCI[A-Za-z0-9+/]{20,}/],
  ['a PEM private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['a Whop API key', /\bapik_[A-Za-z0-9_-]{16,}/],
  ['a hard-coded bearer token', /Bearer\s+[A-Za-z0-9_.-]{24,}/],
  ['a secret assigned a value', /\b(?:WHOP_API_KEY|LICENSE_SIGNING_KEY)\b["'`]?\s*[=:]\s*["'`]?[A-Za-z0-9+/_.-]{16,}/]
]
const SERVER_ONLY_NAMES = /\b(?:WHOP_API_KEY|LICENSE_SIGNING_KEY)\b/

function walk(path: string): string[] {
  if (!existsSync(path)) return []
  if (!statSync(path).isDirectory()) return SKIP_FILES.test(path) ? [] : [path]
  return readdirSync(path).flatMap((name) => (SKIP_DIRS.has(name) ? [] : walk(join(path, name))))
}

function secretsIn(text: string): string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
}

// latin1 keeps every byte, so this also reads an asar archive or other binary
function scan(paths: string[]): string[] {
  return paths.flatMap((path) => secretsIn(readFileSync(path, 'latin1')).map((name) => `${name} in ${path}`))
}

describe('the scanner', () => {
  it('finds a real signing key and a Whop-shaped API key', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const fake = `apik_${'x'.repeat(30)}`
    expect(secretsIn(`const k = '${der}'`)).toContain('an Ed25519 private key')
    expect(secretsIn(pem)).toContain('a PEM private key')
    expect(secretsIn(`headers: { Authorization: 'Bearer ${fake}' }`)).toContain('a Whop API key')
    expect(secretsIn(`WHOP_API_KEY=${fake}`)).toContain('a secret assigned a value')
    expect(secretsIn(`"LICENSE_SIGNING_KEY": "${der}"`)).toContain('a secret assigned a value')
  })

  it('leaves the real source shape alone', () => {
    expect(secretsIn('const { WHOP_API_KEY: apiKey } = process.env')).toEqual([])
    expect(secretsIn('Authorization: `Bearer ${apiKey}`')).toEqual([])
  })
})

describe('A7', () => {
  it('finds no secret in the source', () => {
    const files = SOURCE_ROOTS.flatMap((path) => walk(join(root, path))).filter((path) => path !== self)
    expect(files.length).toBeGreaterThan(10)
    expect(scan(files)).toEqual([])
  })

  it('keeps the server env names out of everything that ships in the app', () => {
    const files = walk(join(root, 'src'))
    expect(files.filter((path) => SERVER_ONLY_NAMES.test(readFileSync(path, 'utf8')))).toEqual([])
  })

  it('stops env files reaching git', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/)).toContain('.env*')
    expect(walk(root).filter((path) => basename(path).startsWith('.env'))).toEqual([])
  })

  it('finds no secret in the built output', () => {
    const files = BUILT_ROOTS.filter(Boolean).flatMap((path) => walk(resolve(root, path)))
    expect(scan(files)).toEqual([])
    const named = files.filter((path) => SERVER_ONLY_NAMES.test(readFileSync(path, 'latin1')))
    expect(named).toEqual([])
  })
})
