// The real handler over real sockets: a client talks HTTP to the handler, and the handler talks HTTP to a mock Whop.

import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import validate from '../api/validate'

const KEY = 'A1B2C3-D4E5F6-G7H8I9'
const API_KEY = 'test-whop-api-key'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout

interface Membership {
  id: string
  license_key: string
  status: string
  product: { id: string }
  metadata: Record<string, unknown> | null
}

let membership: Membership
let forcedStatus: number | null
let whopRequests: string[]
let whopUrl: string
let handlerUrl: string
let servers: Server[]

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString()
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

// Behaves like the reference says: PATCH replaces metadata outright, the harshest reading of Whop's docs
async function mockWhop(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request)
  whopRequests.push(`${request.method} ${request.url}`)
  if (forcedStatus) return send(response, forcedStatus, { error: 'forced' })
  if (request.headers.authorization !== `Bearer ${API_KEY}`) return send(response, 401, { error: 'unauthorized' })

  const id = decodeURIComponent(request.url?.replace('/api/v1/memberships/', '') ?? '')
  if (request.method === 'GET') {
    return id === membership.license_key || id === membership.id
      ? send(response, 200, { ...membership, user: { email: 'buyer@example.com' } })
      : send(response, 404, { error: 'not found' })
  }
  if (request.method === 'PATCH' && id === membership.id) {
    membership.metadata = JSON.parse(body).metadata
    return send(response, 200, membership)
  }
  send(response, 404, { error: 'not found' })
}

// What Vercel's Node runtime does with a fetch export: real request in, Web Request through, real response out
async function vercelAdapter(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const result = await validate.fetch(
    new Request(`http://${request.headers.host}${request.url}`, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: hasBody ? await readBody(request) : undefined
    })
  )
  response.writeHead(result.status, Object.fromEntries(result.headers))
  response.end(await result.text())
}

async function listen(listener: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<string> {
  const server = createServer((request, response) => void listener(request, response))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function activate(deviceId: string, key = KEY): Promise<Response> {
  return realFetch(`${handlerUrl}/api/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, deviceId })
  })
}

beforeAll(async () => {
  servers = []
  whopUrl = await listen(mockWhop)
  handlerUrl = await listen(vercelAdapter)
  // The handler keeps its real Whop URL. Only the host is swapped, under it, for the mock
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => realFetch(input.replace('https://api.whop.com', whopUrl), init))
  // Binding waits for rival requests, and one client has none. Only those waits go, so sockets keep their timers
  vi.stubGlobal('setTimeout', (run: () => void, ms: number) => realSetTimeout(run, ms >= 1500 && ms <= 2000 ? 0 : ms))
  vi.stubEnv('WHOP_API_KEY', API_KEY)
  vi.stubEnv('WHOP_PRODUCT_ID', 'prod_test')
  vi.stubEnv('LICENSE_SIGNING_KEY', privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
})

afterAll(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
})

beforeEach(() => {
  forcedStatus = null
  whopRequests = []
  membership = {
    id: 'mem_abc123',
    license_key: KEY,
    status: 'completed',
    product: { id: 'prod_test' },
    metadata: { source: 'landing-page' }
  }
})

describe('POST /api/validate over HTTP', () => {
  it('walks through 3 devices, refuses a 4th and lets a listed one back in', async () => {
    const devices = ['1111111111111111', '2222222222222222', '3333333333333333']
    for (const device of devices) {
      const response = await activate(device)
      expect(response.status).toBe(200)
      const { valid, token } = await response.json()
      expect(valid).toBe(true)
      const [payload, signature] = token.split('.')
      expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
    }
    expect(membership.metadata).toEqual({ source: 'landing-page', hwid: devices.join(',') })

    expect(await (await activate('4444444444444444')).json()).toEqual({ valid: false, reason: 'device_limit' })
    expect(membership.metadata?.hwid).toBe(devices.join(','))

    whopRequests = []
    expect((await (await activate(devices[1])).json()).valid).toBe(true)
    expect(whopRequests).toEqual([`GET /api/v1/memberships/${KEY}`])
  })

  it('reports each failure', async () => {
    expect(await (await activate('1111111111111111', 'ZZZZZZ-ZZZZZZ-ZZZZZZ')).json()).toEqual({ valid: false, reason: 'invalid_key' })

    membership.status = 'canceled'
    expect(await (await activate('1111111111111111')).json()).toEqual({ valid: false, reason: 'inactive' })

    membership.status = 'active'
    membership.product.id = 'prod_other'
    expect(await (await activate('1111111111111111')).json()).toEqual({ valid: false, reason: 'wrong_product' })
  })

  it.each([429, 500])('answers 503 when Whop answers %i', async (status) => {
    forcedStatus = status
    const response = await activate('1111111111111111')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  })

  it('answers 503 when Whop is down', async () => {
    const original = whopUrl
    whopUrl = 'http://127.0.0.1:1'
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await activate('1111111111111111')).status).toBe(503)
    quiet.mockRestore()
    whopUrl = original
  })

  it('refuses anything but POST', async () => {
    const response = await realFetch(`${handlerUrl}/api/validate`)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('rejects broken JSON without reaching Whop', async () => {
    const response = await realFetch(`${handlerUrl}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"A1B2'
    })
    expect(response.status).toBe(400)
    expect(whopRequests).toEqual([])
  })
})
