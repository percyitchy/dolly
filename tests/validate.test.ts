import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import validate from '../api/validate'
import { MAX_DEVICES } from '../src/shared/config'

const KEY = 'A1B2C3-D4E5F6-G7H8I9'
const DEVICE = 'aaaaaaaaaaaaaaaa'
const WHOP = 'https://api.whop.com/api/v1'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const realSetTimeout = globalThis.setTimeout
const realSetImmediate = globalThis.setImmediate

interface Call {
  url: string
  method: string
  headers: Headers
  body: unknown
}

type Reply = Response | (() => Response | Promise<Response>)

let calls: Call[]
let getReply: Reply
let patchReply: Reply
let patched: unknown // What the last PATCH saved, which every later GET shows

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem_abc123',
    status: 'active',
    license_key: KEY,
    metadata: null,
    product: { id: 'prod_test', title: 'Dolly' },
    user: { id: 'user_1', email: 'buyer@example.com', name: 'Buyer' },
    manage_url: 'https://whop.com/manage/secret',
    ...overrides
  }
}

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return validate.fetch(
    new Request('https://dolly.test/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  )
}

const activate = (deviceId = DEVICE) => post({ key: KEY, deviceId })

function resolve(reply: Reply): Response | Promise<Response> {
  return typeof reply === 'function' ? reply() : reply.clone()
}

async function getResponse(): Promise<Response> {
  const reply = await resolve(getReply)
  return patched === undefined ? reply : jsonReply({ ...(await reply.json()), metadata: patched })
}

async function patchResponse(call: Call): Promise<Response> {
  const reply = await resolve(patchReply)
  if (reply.ok) patched = (call.body as { metadata: unknown }).metadata
  return reply
}

function patches(): Call[] {
  return calls.filter((call) => call.method === 'PATCH')
}

beforeEach(() => {
  calls = []
  patched = undefined
  getReply = jsonReply(member())
  patchReply = jsonReply(member())
  vi.stubGlobal('setTimeout', (run: () => void) => realSetTimeout(run, 0))
  vi.stubEnv('WHOP_API_KEY', 'test-whop-api-key')
  vi.stubEnv('WHOP_PRODUCT_ID', 'prod_test')
  vi.stubEnv('LICENSE_SIGNING_KEY', privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const call = {
        url: String(input),
        method,
        headers: new Headers(init.headers),
        body: init.body ? JSON.parse(String(init.body)) : undefined
      }
      calls.push(call)
      return method === 'PATCH' ? patchResponse(call) : getResponse()
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('a good key', () => {
  it('binds a new device and returns only valid and a token', async () => {
    const response = await activate()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(['token', 'valid'])
    expect(body.valid).toBe(true)
    expect(patches()).toHaveLength(1)
    expect(patches()[0].url).toBe(`${WHOP}/memberships/mem_abc123`)
    expect(patches()[0].body).toEqual({ metadata: { hwid: DEVICE } })
  })

  it.each(['active', 'trialing', 'completed', 'canceling'])('accepts status %s', async (status) => {
    getReply = jsonReply(member({ status }))
    expect((await (await activate()).json()).valid).toBe(true)
  })

  it('looks up the key with the bearer token and an encoded path', async () => {
    await activate()
    expect(calls[0].url).toBe(`${WHOP}/memberships/${encodeURIComponent(KEY)}`)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].headers.get('authorization')).toBe('Bearer test-whop-api-key')
  })

  it('signs keyHash, deviceId and iat with Ed25519', async () => {
    const { token } = await (await activate()).json()
    const [payload, signature] = token.split('.')
    expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(Object.keys(claims).sort()).toEqual(['deviceId', 'iat', 'keyHash'])
    expect(claims.keyHash).toBe(createHash('sha256').update(KEY).digest('hex'))
    expect(claims.deviceId).toBe(DEVICE)
    expect(Math.abs(claims.iat - Date.now() / 1000)).toBeLessThan(5)
  })

  it('verifies with a public key rebuilt from the raw bytes the app stores', async () => {
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    const rebuilt = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
    const { token } = await (await activate()).json()
    const [payload, signature] = token.split('.')
    expect(verify(null, Buffer.from(payload), rebuilt, Buffer.from(signature, 'base64url'))).toBe(true)
  })

  it('never returns the email or anything else Whop sent', async () => {
    const text = await (await activate()).text()
    for (const leak of ['buyer@example.com', 'mem_abc123', 'manage', 'prod_test', KEY]) expect(text).not.toContain(leak)
  })
})

describe('failure reasons', () => {
  async function reason(): Promise<string> {
    const response = await activate()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(['reason', 'valid'])
    expect(body.valid).toBe(false)
    return body.reason
  }

  it('maps 404 to invalid_key', async () => {
    getReply = jsonReply({ error: 'not found' }, 404)
    expect(await reason()).toBe('invalid_key')
    expect(patches()).toHaveLength(0)
  })

  it.each(['past_due', 'canceled', 'expired', 'unresolved', 'drafted', 'something_new'])(
    'maps status %s to inactive',
    async (status) => {
      getReply = jsonReply(member({ status }))
      expect(await reason()).toBe('inactive')
    }
  )

  it('maps a missing status to inactive', async () => {
    getReply = jsonReply(member({ status: undefined }))
    expect(await reason()).toBe('inactive')
  })

  it.each([
    ['another product', { id: 'prod_other' }],
    ['no product', null],
    ['a product with no id', {}]
  ])('maps %s to wrong_product', async (_, product) => {
    getReply = jsonReply(member({ product }))
    expect(await reason()).toBe('wrong_product')
    expect(patches()).toHaveLength(0)
  })
})

describe('device list', () => {
  const stored = (count: number) => Array.from({ length: count }, (_, i) => String(i + 1).repeat(16)).join(',')

  it('uses the same limit as the app', () => {
    expect(MAX_DEVICES).toBe(3)
  })

  it('adds a second and a third device', async () => {
    for (const count of [1, 2]) {
      calls = []
      patched = undefined
      getReply = jsonReply(member({ metadata: { hwid: stored(count) } }))
      expect((await (await activate()).json()).valid).toBe(true)
      expect(patches()[0].body).toEqual({ metadata: { hwid: `${stored(count)},${DEVICE}` } })
    }
  })

  it('refuses a 4th device without touching Whop', async () => {
    getReply = jsonReply(member({ metadata: { hwid: stored(3) } }))
    expect(await (await activate()).json()).toEqual({ valid: false, reason: 'device_limit' })
    expect(patches()).toHaveLength(0)
  })

  it('passes a listed device with no PATCH, even at the limit', async () => {
    getReply = jsonReply(member({ metadata: { hwid: `${stored(2)},${DEVICE}` } }))
    expect((await (await activate()).json()).valid).toBe(true)
    expect(patches()).toHaveLength(0)
  })

  it('tolerates spaces and empty entries in the stored list', async () => {
    getReply = jsonReply(member({ metadata: { hwid: ` ${DEVICE} , ,` } }))
    expect((await (await activate()).json()).valid).toBe(true)
    expect(patches()).toHaveLength(0)
  })

  it('counts a reset, empty list as free slots', async () => {
    getReply = jsonReply(member({ metadata: {} }))
    expect((await (await activate()).json()).valid).toBe(true)
    expect(patches()[0].body).toEqual({ metadata: { hwid: DEVICE } })
  })

  it('sends the whole metadata object on PATCH', async () => {
    const metadata = { hwid: stored(1), note: 'keep me', nested: { a: 1 }, flag: true }
    getReply = jsonReply(member({ metadata }))
    await activate()
    expect(patches()[0].body).toEqual({
      metadata: { note: 'keep me', nested: { a: 1 }, flag: true, hwid: `${stored(1)},${DEVICE}` }
    })
  })
})

describe('concurrent activations', () => {
  const device = (i: number) => String(i + 1).repeat(16)

  // A made-up clock, so a race across many seconds takes no real time. Everything that can run does, then the
  // clock jumps to the next timer
  function virtualTime() {
    let now = 1_800_000_000_000
    const timers: { at: number; run: () => void }[] = []
    vi.stubGlobal('setTimeout', (run: () => void, ms = 0) => timers.push({ at: now + Math.round(ms), run })) // Date.now() is whole
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const idle = async () => {
      for (let i = 0; i < 8; i++) await new Promise((done) => realSetImmediate(done))
    }
    return {
      now: () => now,
      async run<T>(work: Promise<T>): Promise<T> {
        let finished = false
        const result = work.finally(() => (finished = true))
        await idle()
        while (!finished) {
          const next = timers.sort((a, b) => a.at - b.at).shift()
          if (next) {
            now = next.at
            next.run()
          }
          await idle()
        }
        return result
      }
    }
  }

  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

  // Mulberry32, so a failing seed can be run again
  function seeded(seed: number): () => number {
    let state = seed
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
    }
  }

  // Whop's behaviour as far as it matters here: every read and write takes a moment, and a PATCH replaces the
  // whole metadata object, so the last one to land wins
  function lastWriteWins(start: unknown = null, slowest = 20, writes: [number, number] = [0, slowest]) {
    const whop = { metadata: start, reads: 0, writes: 0 }
    vi.stubGlobal('fetch', async (_: string, init: RequestInit = {}) => {
      if (init.method === 'PATCH') {
        await wait(writes[0] + Math.random() * (writes[1] - writes[0]))
        whop.writes++
        whop.metadata = JSON.parse(String(init.body)).metadata
        return jsonReply(member({ metadata: whop.metadata }))
      }
      await wait(Math.random() * slowest)
      whop.reads++
      const seen = whop.metadata
      await wait(Math.random() * slowest)
      return jsonReply(member({ metadata: seen }))
    })
    return whop
  }

  const deviceOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).deviceId as string
  const listOf = (metadata: unknown) => ((metadata as { hwid?: string } | null)?.hwid ?? '').split(',').filter(Boolean)

  async function answer(id: string) {
    const response = await activate(id)
    return { id, status: response.status, ...(await response.json()) }
  }

  const race = (devices: string[]) => Promise.all(devices.map(answer))

  // Requests that arrive one after another, each up to gapMs behind the last, and how long each one took
  async function staggered(devices: string[], gapMs: number, clock: ReturnType<typeof virtualTime>) {
    let arrival = 0
    return Promise.all(
      devices.map(async (id) => {
        arrival += Math.random() * gapMs
        await wait(arrival)
        const started = clock.now()
        const result = await answer(id)
        return { ...result, tookMs: clock.now() - started }
      })
    )
  }

  it('gives 8 racing devices at most 3 tokens, each for a stored device', async () => {
    const clock = virtualTime()
    const whop = lastWriteWins({ note: 'keep me' })
    const answers = await clock.run(race(Array.from({ length: 8 }, (_, i) => device(i))))

    const winners = answers.filter((a) => a.valid).map((a) => deviceOf(a.token))
    const stored = listOf(whop.metadata)
    expect(winners.length).toBeLessThanOrEqual(3)
    expect(stored.length).toBeLessThanOrEqual(3)
    expect(stored.sort()).toEqual(expect.arrayContaining(winners.sort()))
    expect(answers.filter((a) => !a.valid).every((a) => a.status === 503 || a.reason === 'device_limit')).toBe(true)
    expect(whop.metadata).toMatchObject({ note: 'keep me' })
  })

  it('binds every device when the race is within the limit', async () => {
    const clock = virtualTime()
    const whop = lastWriteWins()
    const answers = await clock.run(race([device(0), device(1), device(2)]))
    expect(answers.every((a) => a.valid)).toBe(true)
    expect(listOf(whop.metadata).sort()).toEqual([device(0), device(1), device(2)])
  })

  it('counts one device racing itself once', async () => {
    const clock = virtualTime()
    const whop = lastWriteWins()
    const answers = await clock.run(race(Array(8).fill(device(0))))
    expect(answers.every((a) => a.valid)).toBe(true)
    expect(listOf(whop.metadata)).toEqual([device(0)])
  })

  describe('with staggered requests and slow writes', () => {
    const WRITE_MS: [number, number] = [200, 3000]
    const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1)

    it.each([0, 100, 300, 700, 1500])('never signs more than 3 of 8 devices arriving up to %i ms apart', async (gapMs) => {
      let most = 0
      let dropped = 0
      for (const seed of SEEDS) {
        vi.spyOn(Math, 'random').mockImplementation(seeded(seed * 1000 + gapMs))
        const clock = virtualTime()
        const whop = lastWriteWins(null, 120, WRITE_MS)
        const answers = await clock.run(staggered(Array.from({ length: 8 }, (_, i) => device(i)), gapMs, clock))
        const winners = answers.filter((a) => a.valid).map((a) => deviceOf(a.token))
        most = Math.max(most, winners.length)
        if (!winners.every((id) => listOf(whop.metadata).includes(id))) dropped++
        expect(answers.filter((a) => !a.valid).every((a) => a.status === 503 || a.reason === 'device_limit')).toBe(true)
        // The budget's 9 s, and this fake Whop ignores the abort that would cut its last read short
        expect(Math.max(...answers.map((a) => a.tookMs))).toBeLessThan(9500)
      }
      expect(most).toBeLessThanOrEqual(3)
      // Whop has no compare-and-set, so this is narrow rather than closed: a write can still land after the last read
      expect(dropped).toBeLessThan(SEEDS.length / 10)
    })

    it('lets a device that got a 503 back in on its next try', async () => {
      for (const seed of SEEDS.slice(0, 20)) {
        vi.spyOn(Math, 'random').mockImplementation(seeded(seed))
        const clock = virtualTime()
        const whop = lastWriteWins(null, 120, WRITE_MS)
        const devices = [device(0), device(1), device(2)]
        const answers = await clock.run(staggered(devices, 300, clock))
        expect(answers.every((a) => a.valid || a.status === 503)).toBe(true)
        for (const { id, valid } of answers) {
          if (!valid) expect((await clock.run(answer(id))).valid).toBe(true)
        }
        expect(listOf(whop.metadata).sort()).toEqual(devices)
      }
    })
  })

  // Each GET gets the next answer, and the last one repeats. PATCHes succeed and change nothing
  function reads(...answers: (string | null | Response)[]) {
    let at = 0
    vi.stubGlobal('fetch', async (_: string, init: RequestInit = {}) => {
      if (init.method === 'PATCH') return jsonReply(member())
      const answer = answers[Math.min(at++, answers.length - 1)]
      return answer instanceof Response ? answer.clone() : jsonReply(member({ metadata: answer === null ? null : { hwid: answer } }))
    })
  }

  const quietly = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  const others = (count: number) => Array.from({ length: count }, (_, i) => device(i)).join(',')

  it('reads the list back twice before signing a new device', async () => {
    await activate()
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET', 'GET'])
  })

  it('waits 1.5 to 2 s before each read', async () => {
    const waits: number[] = []
    vi.stubGlobal('setTimeout', (run: () => void, ms: number) => {
      waits.push(ms)
      return realSetTimeout(run, 0)
    })
    await activate()
    expect(waits).toHaveLength(2)
    for (const ms of waits) {
      expect(ms).toBeGreaterThanOrEqual(1500)
      expect(ms).toBeLessThanOrEqual(2000)
    }
  })

  it('makes a listed device wait for nothing and asks Whop once', async () => {
    const waits = vi.fn()
    vi.stubGlobal('setTimeout', waits)
    getReply = jsonReply(member({ metadata: { hwid: DEVICE } }))
    expect((await (await activate()).json()).valid).toBe(true)
    expect(waits).not.toHaveBeenCalled()
    expect(calls.map((call) => call.method)).toEqual(['GET'])
  })

  it('never signs when the second read loses the device', async () => {
    quietly()
    reads(null, DEVICE, null)
    const response = await activate()
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('token')
  })

  it('refuses a device the second read shows has lost the last free slot', async () => {
    reads(others(2), `${others(2)},${DEVICE}`, others(3))
    expect(await (await activate()).json()).toEqual({ valid: false, reason: 'device_limit' })
  })

  it('keeps reading while the list is still changing', async () => {
    let got = 0
    const lists = [null, DEVICE, `${DEVICE},${device(0)}`, `${DEVICE},${device(0)}`]
    vi.stubGlobal('fetch', async (_: string, init: RequestInit = {}) => {
      if (init.method === 'PATCH') return jsonReply(member())
      const hwid = lists[Math.min(got++, lists.length - 1)]
      return jsonReply(member({ metadata: hwid === null ? null : { hwid } }))
    })
    expect((await (await activate()).json()).valid).toBe(true)
    expect(got).toBe(4)
  })

  it('gives up with a 503 rather than run past its budget', async () => {
    quietly()
    const clock = virtualTime()
    const whop = lastWriteWins(null, 120, [3000, 3000])
    const started = clock.now()
    let writes = 0 // A list that never stops changing, as if rivals never finish
    const keepWriting = async () => {
      while (clock.now() - started < 12000) {
        await wait(500)
        whop.metadata = { hwid: `${DEVICE},${writes++}` }
      }
    }
    const [response] = await clock.run(Promise.all([activate(), keepWriting()]))
    expect(response.status).toBe(503)
  })

  it('refuses a device that lost the last free slot', async () => {
    reads(others(2), others(3))
    expect(await (await activate()).json()).toEqual({ valid: false, reason: 'device_limit' })
  })

  it('never signs when the list is over the limit, even with this device in it', async () => {
    quietly()
    reads(others(1), `${others(3)},${DEVICE}`)
    const response = await activate()
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('token')
  })

  it('never signs when the write never shows up in a read', async () => {
    quietly()
    reads(null)
    const response = await activate()
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('token')
  })

  it('answers 503 when the confirming read fails', async () => {
    quietly()
    reads(null, jsonReply({ error: 'nope' }, 500))
    expect((await activate()).status).toBe(503)
  })
})

describe('Whop trouble', () => {
  async function expectUnavailable(): Promise<void> {
    const response = await activate()
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).not.toContain('invalid_key')
    expect(text).not.toContain('token')
  }

  it.each([429, 500, 502, 503, 504, 401, 403, 400])('turns a %i lookup into 503', async (status) => {
    getReply = jsonReply({ error: 'nope' }, status)
    await expectUnavailable()
  })

  it.each([429, 500, 503, 403, 404])('issues no token when the PATCH gets a %i', async (status) => {
    patchReply = jsonReply({ error: 'nope' }, status)
    await expectUnavailable()
  })

  it('turns a dropped connection into 503', async () => {
    getReply = () => Promise.reject(new TypeError('fetch failed'))
    await expectUnavailable()
  })

  it('turns a timeout into 503', async () => {
    getReply = () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError'))
    await expectUnavailable()
  })

  it('turns an unreadable body into 503', async () => {
    getReply = () => new Response('<html>gateway</html>', { status: 200 })
    await expectUnavailable()
  })

  it('refuses to PATCH a membership ID of the wrong shape', async () => {
    getReply = jsonReply(member({ id: '../users/me' }))
    await expectUnavailable()
    expect(patches()).toHaveLength(0)
  })
})

describe('input', () => {
  const good = { key: KEY, deviceId: DEVICE }

  it.each([
    ['missing key', { deviceId: DEVICE }],
    ['missing deviceId', { key: KEY }],
    ['empty body object', {}],
    ['extra field', { ...good, admin: true }],
    ['key as number', { key: 12345678, deviceId: DEVICE }],
    ['key as object', { key: { a: 1 }, deviceId: DEVICE }],
    ['empty key', { key: '', deviceId: DEVICE }],
    ['short key', { key: 'ABC-123', deviceId: DEVICE }],
    ['long key', { key: 'A'.repeat(129), deviceId: DEVICE }],
    ['key with a slash', { key: 'AAAA/../BBBB', deviceId: DEVICE }],
    ['key with a query', { key: 'AAAAAAAA?expand=all', deviceId: DEVICE }],
    ['key with a space', { key: 'AAAA BBBB', deviceId: DEVICE }],
    ['key with a newline', { key: 'AAAABBBB\n', deviceId: DEVICE }],
    ['key with a percent sign', { key: 'AAAA%2fBBBB', deviceId: DEVICE }],
    ['a membership ID as the key', { key: 'mem_abcdefgh1234', deviceId: DEVICE }],
    ['a membership ID in capitals', { key: 'MEM_abcdefgh1234', deviceId: DEVICE }],
    ['short deviceId', { key: KEY, deviceId: 'abc' }],
    ['long deviceId', { key: KEY, deviceId: 'a'.repeat(17) }],
    ['uppercase deviceId', { key: KEY, deviceId: 'A'.repeat(16) }],
    ['deviceId that is not hex', { key: KEY, deviceId: 'g'.repeat(16) }],
    ['deviceId with a comma', { key: KEY, deviceId: 'aaaaaaa,aaaaaaaa' }]
  ])('rejects %s with no Whop call', async (_, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ valid: false, reason: 'invalid_key' })
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['broken JSON', '{"key":'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a string', '"hello"'],
    ['an empty body', ''],
    ['a body over the limit', JSON.stringify({ key: KEY, deviceId: DEVICE, pad: 'x'.repeat(2000) })]
  ])('rejects %s with no Whop call', async (_, body) => {
    expect((await post(body)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it.each(['WHOP_abc_123-XYZ', 'abcd.efgh~1234', '-AAAABBBB', 'member_abcdefgh'])('accepts the URL-safe key %s', async (key) => {
    expect((await post({ key, deviceId: DEVICE })).status).toBe(200)
    expect(calls[0].url).toBe(`${WHOP}/memberships/${encodeURIComponent(key)}`)
  })

  it('rejects a non-JSON content type', async () => {
    expect((await post(good, { 'Content-Type': 'text/plain' })).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('accepts a JSON content type with a charset', async () => {
    expect((await post(good, { 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(200)
  })

  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])('answers %s with 405', async (method) => {
    const response = await validate.fetch(new Request('https://dolly.test/api/validate', { method }))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(calls).toHaveLength(0)
  })
})

describe('server setup', () => {
  it.each(['WHOP_API_KEY', 'WHOP_PRODUCT_ID', 'LICENSE_SIGNING_KEY'])('returns 503 with no Whop call when %s is unset', async (name) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv(name, '')
    expect((await activate()).status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('returns 503 before spending a device slot when the signing key is unusable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('LICENSE_SIGNING_KEY', 'bm90IGEga2V5')
    expect((await activate()).status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('refuses a signing key that is not Ed25519', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    vi.stubEnv('LICENSE_SIGNING_KEY', rsa.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
    expect((await activate()).status).toBe(503)
    expect(calls).toHaveLength(0)
  })
})

describe('logging', () => {
  it('never logs the key, device ID or API key on any path', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )
    const scenarios: Reply[] = [
      jsonReply(member()),
      jsonReply({}, 404),
      jsonReply({}, 429),
      jsonReply({}, 500),
      () => Promise.reject(new TypeError(`fetch failed ${WHOP}/memberships/${KEY}`)),
      () => new Response('not json', { status: 200 })
    ]
    for (const reply of scenarios) {
      getReply = reply
      await activate()
    }
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
    for (const secret of [KEY, DEVICE, 'test-whop-api-key']) expect(logged).not.toContain(secret)
  })
})

describe('deployment config', () => {
  const root = new URL('..', import.meta.url)

  it('deploys only the function and the landing page', () => {
    const config = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8'))
    expect(config.framework).toBeNull()
    expect(config.buildCommand).toBe('')
    expect(config.installCommand).toBe('')
    expect(Object.keys(config.functions).sort()).toEqual(['api/stats.ts', 'api/track.ts', 'api/validate.ts'])
    const ignore = readFileSync(new URL('.vercelignore', root), 'utf8').split('\n').filter((line) => line && !line.startsWith('#'))
    expect(ignore).toEqual(['/*', '!api', '!public', '!vercel.json'])
  })

  it('has only the three functions in api', () => {
    const functions = readdirSync(new URL('api/', root)).filter((file) => !file.startsWith('.') && !file.startsWith('_'))
    expect(functions.sort()).toEqual(['stats.ts', 'track.ts', 'validate.ts'])
  })
})
