// Pro activation. One POST to the license server, then a signed token checked offline at every start.

import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, win32 } from 'node:path'
import { app, net } from 'electron'
import { handleFromMain, type Register } from './context'
import { openExternal } from './network-guard'
import { licenseFile } from './paths'
import { DEVICE_ID_SALT, LICENSE_PUBLIC_KEY, VALIDATE_ENDPOINT, WHOP_URL } from '../shared/config'
import type { Plan } from '../shared/entitlements'
import type { ActivateResult, LicenseFailure, LicenseStatus } from '../shared/ipc'

const REQUEST_TIMEOUT_MS = 15_000 // Binding a new device takes the server up to 9 s, plus a cold start
const COMMAND_TIMEOUT_MS = 5_000
const MAX_RESPONSE_CHARS = 4096
const SERVER_REASONS: readonly string[] = ['invalid_key', 'inactive', 'wrong_product', 'device_limit']
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'

interface TokenPayload {
  keyHash: string
  deviceId: string
  iat: number
}

let plan: Plan = 'free'
let cachedDeviceId: string | null = null

// The current plan, for main-process checks such as the export job
export function currentPlan(): Plan {
  return plan
}

export function parseMachineId(platform: NodeJS.Platform, output: string): string | null {
  const pattern = platform === 'win32' ? /MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i : /"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i
  return pattern.exec(output)?.[1]?.toLowerCase() ?? null
}

// SystemRoot comes from whatever launched Dolly, so a packaged build doesn't believe it. Windows can only sit in
// \Windows on some drive, and C: is checked first, where a normal user can't write to that folder
export function regExePath(packaged: boolean, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string {
  const on = (root: string) => win32.join(root, 'System32', 'reg.exe')
  if (!packaged) return on(env.SystemRoot ?? 'C:\\Windows')
  const found = [...DRIVE_LETTERS].map((drive) => on(`${drive}:\\Windows`)).find(exists)
  return found ?? on('C:\\Windows')
}

function readMachineId(): string {
  const options = { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true } as const
  let id: string | null = null
  if (process.platform === 'darwin') {
    id = parseMachineId('darwin', execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], options))
  } else if (process.platform === 'win32') {
    const args = ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']
    id = parseMachineId('win32', execFileSync(regExePath(app.isPackaged), args, options))
  }
  if (!id) throw new Error('No machine ID on this system')
  return id
}

export function deriveDeviceId(machineId: string): string {
  return createHash('sha256').update(`${DEVICE_ID_SALT}:${machineId}`).digest('hex').slice(0, 16)
}

export function getDeviceId(): string {
  cachedDeviceId ??= deriveDeviceId(readMachineId())
  return cachedDeviceId
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function publicKeyFrom(base64: string): ReturnType<typeof createPublicKey> | null {
  const raw = Buffer.from(base64, 'base64')
  if (raw.length !== 32) return null
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

// Buffer.from ignores junk in base64url, so an edited string could decode to the same bytes
function decodeStrict(part: string): Buffer | null {
  const bytes = Buffer.from(part, 'base64url')
  return part.length > 0 && bytes.toString('base64url') === part ? bytes : null
}

function isPayload(value: unknown): value is TokenPayload {
  if (typeof value !== 'object' || value === null) return false
  const { keyHash, deviceId, iat } = value as Record<string, unknown>
  return typeof keyHash === 'string' && typeof deviceId === 'string' && typeof iat === 'number'
}

// The payload of a token signed for this device, or null. Fails closed on anything unexpected
export function verifyToken(token: unknown, deviceId: string, publicKey = LICENSE_PUBLIC_KEY): TokenPayload | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, encodedSignature] = parts
  try {
    const key = publicKeyFrom(publicKey)
    const payloadBytes = decodeStrict(encoded)
    const signature = decodeStrict(encodedSignature)
    if (!key || !payloadBytes || !signature) return null
    if (!verify(null, Buffer.from(encoded), key, signature)) return null
    const payload: unknown = JSON.parse(payloadBytes.toString('utf8'))
    return isPayload(payload) && payload.deviceId === deviceId ? payload : null
  } catch {
    return null
  }
}

// Reads the saved token. Missing, edited or copied all mean Free
export function loadLicense(): Plan {
  plan = 'free'
  try {
    const saved: unknown = JSON.parse(readFileSync(licenseFile(), 'utf8'))
    const { token, keyHash } = saved as Record<string, unknown>
    const payload = verifyToken(token, getDeviceId())
    if (payload && payload.keyHash === keyHash) plan = 'pro'
  } catch {
    plan = 'free'
  }
  return plan
}

function saveLicense(token: string, keyHash: string): void {
  const file = licenseFile()
  const temporary = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temporary, JSON.stringify({ token, keyHash }), { mode: 0o600 })
  renameSync(temporary, file)
}

async function askServer(key: string, deviceId: string): Promise<unknown> {
  const response = await net.fetch(VALIDATE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, deviceId }),
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (response.status === 429) return { valid: false, reason: 'rate_limited' }
  // 400 is how the server turns down a malformed key. Anything else that isn't 200 says nothing about the key
  if (response.status !== 200 && response.status !== 400) return null
  const text = await response.text()
  return text.length > MAX_RESPONSE_CHARS ? null : JSON.parse(text)
}

export async function activate(rawKey: unknown): Promise<ActivateResult> {
  const key = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!key) return { ok: false, reason: 'invalid_key' }

  const failed = (reason: LicenseFailure): ActivateResult => ({ ok: false, reason })
  let deviceId: string
  try {
    deviceId = getDeviceId()
  } catch {
    return failed('device_id')
  }

  let answer: Record<string, unknown> | null
  try {
    answer = (await askServer(key, deviceId)) as Record<string, unknown> | null
  } catch {
    return failed('network')
  }
  if (answer?.reason === 'rate_limited') return failed('rate_limited')
  if (answer?.valid === false && SERVER_REASONS.includes(answer.reason as string)) {
    return failed(answer.reason as LicenseFailure)
  }
  if (answer?.valid !== true) return failed('network')

  // A token this build can't verify would be worthless after a restart, so nothing is saved
  const keyHash = hashKey(key)
  const payload = verifyToken(answer.token, deviceId)
  if (!payload || payload.keyHash !== keyHash) return failed('network')

  try {
    saveLicense(answer.token as string, keyHash)
  } catch {
    return failed('save')
  }
  plan = 'pro'
  return { ok: true }
}

export function deactivateLocal(): void {
  rmSync(licenseFile(), { force: true })
  plan = 'free'
}

export async function openStore(): Promise<void> {
  await openExternal(WHOP_URL)
}

export const register: Register = (ctx) => {
  loadLicense()
  handleFromMain(ctx, 'license:status', (): LicenseStatus => ({ plan: currentPlan() }))
  handleFromMain(ctx, 'license:activate', (key: unknown) => activate(key))
  handleFromMain(ctx, 'license:deactivateLocal', () => deactivateLocal())
  handleFromMain(ctx, 'license:openStore', () => openStore())
}
