// POST /api/validate: checks a Whop license key, binds it to a device and returns a signed token.
// See SPEC section 6. Keys, device IDs and Whop responses never go in a log line.

import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto'

const WHOP_API = 'https://api.whop.com/api/v1'
const MAX_DEVICES = 3
const MAX_BODY_BYTES = 1024
const MAX_KEY_LENGTH = 128
const MIN_KEY_LENGTH = 8
const WHOP_TIMEOUT_MS = 6000
// canceling means the member turned renewal off, and they keep access until the period ends
const GOOD_STATUSES = new Set(['active', 'trialing', 'completed', 'canceling'])
const BIND_ATTEMPTS = 3
const CONFIRM_READS = 2 // Together their settles outlast a slow rival's PATCH, which can take 3 s
const SETTLE_MS = 1600 // Lets a rival request's PATCH land before this one reads the list back
const JITTER_MS = 400 // Spreads rivals out, so the next round doesn't collide again
const CONFIRM_MS = CONFIRM_READS * (SETTLE_MS + JITTER_MS)
// A whole request. vercel.json allows 15 s and the app gives up after 15 s, and a Vercel cold start comes on top
const BUDGET_MS = 9000

// Whop doesn't document the key format, so any URL-safe characters pass. The same Whop path
// also accepts mem_ IDs, and a membership ID must not work as a license key
const KEY_PATTERN = /^[A-Za-z0-9._~-]+$/
const MEMBERSHIP_PREFIX = /^mem_/i
const DEVICE_PATTERN = /^[0-9a-f]{16}$/
const MEMBERSHIP_PATTERN = /^mem_[A-Za-z0-9]+$/

type Reason = 'invalid_key' | 'inactive' | 'wrong_product' | 'device_limit'

interface Input {
  key: string
  deviceId: string
}

interface Env {
  apiKey: string
  productId: string
  signingKey: KeyObject
}

// Whop couldn't give a real answer, so the app must not call the key invalid
class WhopUnavailable extends Error {}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  })
}

function failure(reason: Reason, status = 200): Response {
  return json(status, { valid: false, reason })
}

function unavailable(): Response {
  return json(503, { error: 'unavailable' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readInput(request: Request): Promise<Input | null> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(contentType)) return null
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null

  let body: unknown
  try {
    const text = await request.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null
    body = JSON.parse(text)
  } catch {
    return null
  }

  if (!isRecord(body) || Object.keys(body).length !== 2) return null
  const { key, deviceId } = body
  if (typeof key !== 'string' || typeof deviceId !== 'string') return null
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) return null
  if (MEMBERSHIP_PREFIX.test(key)) return null
  if (!DEVICE_PATTERN.test(deviceId)) return null
  return { key, deviceId }
}

function readEnv(): Env | null {
  const { WHOP_API_KEY: apiKey, WHOP_PRODUCT_ID: productId, LICENSE_SIGNING_KEY: signing } = process.env
  if (!apiKey || !productId || !signing) return null
  try {
    const signingKey = createPrivateKey({ key: Buffer.from(signing, 'base64'), format: 'der', type: 'pkcs8' })
    return signingKey.asymmetricKeyType === 'ed25519' ? { apiKey, productId, signingKey } : null
  } catch {
    return null
  }
}

async function callWhop(apiKey: string, path: string, init: RequestInit, deadline: number): Promise<Response> {
  try {
    return await fetch(`${WHOP_API}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(0, Math.min(WHOP_TIMEOUT_MS, deadline - Date.now()))),
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, ...init.headers }
    })
  } catch {
    throw new WhopUnavailable('request failed')
  }
}

async function getMembership(apiKey: string, key: string, deadline: number): Promise<Record<string, unknown> | null> {
  const response = await callWhop(apiKey, `/memberships/${encodeURIComponent(key)}`, { method: 'GET' }, deadline)
  if (response.status === 404) return null
  if (!response.ok) throw new WhopUnavailable(`status ${response.status}`)
  const membership: unknown = await response.json().catch(() => null)
  if (!isRecord(membership)) throw new WhopUnavailable('bad body')
  return membership
}

async function saveDevices(
  apiKey: string,
  membershipId: unknown,
  metadata: Record<string, unknown>,
  devices: string[],
  deadline: number
): Promise<void> {
  if (typeof membershipId !== 'string' || !MEMBERSHIP_PATTERN.test(membershipId)) {
    throw new WhopUnavailable('bad membership id')
  }
  // Whop's guide says this merges and its API reference says it replaces. Sending every key is right under both
  const response = await callWhop(
    apiKey,
    `/memberships/${encodeURIComponent(membershipId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { ...metadata, hwid: devices.join(',') } })
    },
    deadline
  )
  if (!response.ok) throw new WhopUnavailable(`status ${response.status}`)
}

function metadataOf(membership: Record<string, unknown>): Record<string, unknown> {
  return isRecord(membership.metadata) ? membership.metadata : {}
}

function readDevices(metadata: Record<string, unknown>): string[] {
  if (typeof metadata.hwid !== 'string') return []
  return metadata.hwid
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

function signToken(key: string, deviceId: string, signingKey: KeyObject): string {
  const keyHash = createHash('sha256').update(key).digest('hex')
  const iat = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ keyHash, deviceId, iat })).toString('base64url')
  const signature = sign(null, Buffer.from(payload), signingKey).toString('base64url')
  return `${payload}.${signature}`
}

async function settle(deadline: number): Promise<void> {
  const ms = SETTLE_MS + Math.random() * JITTER_MS
  if (Date.now() + ms >= deadline) throw new WhopUnavailable('out of time')
  await new Promise((done) => setTimeout(done, ms))
}

// Whop has no compare-and-set, so requests that read the same free slot overwrite each other, last write wins.
// A new device only counts once two reads in a row, each after a settle, show the same list with it in, within
// the limit. That narrows the window rather than closing it: a rival's PATCH that lands after the last read can
// still drop a device that already has its token. Null means it's bound
async function bindDevice(apiKey: string, key: string, deviceId: string, start: Record<string, unknown>, deadline: number): Promise<Reason | null> {
  let metadata = metadataOf(start)
  for (let attempt = 0; attempt < BIND_ATTEMPTS && Date.now() + CONFIRM_MS < deadline; attempt++) {
    const devices = readDevices(metadata)
    if (!devices.includes(deviceId)) {
      if (devices.length >= MAX_DEVICES) return 'device_limit'
      await saveDevices(apiKey, start.id, metadata, [...devices, deviceId], deadline)
    }
    let confirmed = 0
    let last = ''
    while (confirmed < CONFIRM_READS) {
      await settle(deadline)
      const fresh = await getMembership(apiKey, key, deadline)
      if (!fresh) throw new WhopUnavailable('membership gone')
      metadata = metadataOf(fresh)
      const listed = readDevices(metadata)
      if (!listed.includes(deviceId) && listed.length >= MAX_DEVICES) return 'device_limit'
      if (!listed.includes(deviceId) || listed.length > MAX_DEVICES) break
      // A list that changed means rivals are still writing, and the next write could drop this device
      confirmed = listed.join() === last ? confirmed + 1 : 1
      last = listed.join()
    }
    if (confirmed === CONFIRM_READS) return null
  }
  throw new WhopUnavailable('device list did not settle')
}

async function check({ key, deviceId }: Input, env: Env): Promise<Response> {
  const deadline = Date.now() + BUDGET_MS
  const membership = await getMembership(env.apiKey, key, deadline)
  if (!membership) return failure('invalid_key')

  if (typeof membership.status !== 'string' || !GOOD_STATUSES.has(membership.status)) return failure('inactive')

  const product = membership.product
  if (!isRecord(product) || product.id !== env.productId) return failure('wrong_product')

  if (!readDevices(metadataOf(membership)).includes(deviceId)) {
    const refused = await bindDevice(env.apiKey, key, deviceId, membership, deadline)
    if (refused) return failure(refused)
  }

  return json(200, { valid: true, token: signToken(key, deviceId, env.signingKey) })
}

async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' })

  const input = await readInput(request)
  if (!input) return failure('invalid_key', 400)

  const env = readEnv()
  if (!env) {
    console.error('validate: server env is missing or unusable')
    return unavailable()
  }

  try {
    return await check(input, env)
  } catch (error) {
    // Only our own label: a raw fetch error can carry the URL, and the URL holds the key
    console.error('validate:', error instanceof WhopUnavailable ? `whop ${error.message}` : 'unexpected error')
    return unavailable()
  }
}

// Vercel's Node runtime hands a Web Request only to this shape. A bare default function gets (req, res)
export default { fetch: handler }
