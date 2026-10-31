import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import stats from '../api/stats'
import track from '../api/track'

const ORIGIN = 'https://getdolly.vercel.app'
const AGENT = 'Mozilla/5.0 (Macintosh) Chrome/140 Safari/537'
const IP = '203.0.113.9'

type Command = (string | number)[]

// A small in-memory Redis that speaks Upstash's pipeline format. HyperLogLogs are plain sets here
function fakeRedis() {
  const values = new Map<string, number>()
  const sets = new Map<string, Set<string>>()
  const scores = new Map<string, Map<string, number>>()
  const seen: Command[] = []
  const run = ([name, key, ...rest]: Command): unknown => {
    const k = String(key)
    if (name === 'INCR') return values.set(k, (values.get(k) ?? 0) + 1).get(k)
    if (name === 'GET') return values.has(k) ? String(values.get(k)) : null
    if (name === 'EXPIRE') return 1
    if (name === 'PFADD') return sets.set(k, (sets.get(k) ?? new Set()).add(String(rest[0]))).size
    if (name === 'PFCOUNT') return sets.get(k)?.size ?? 0
    if (name === 'ZADD') return scores.set(k, (scores.get(k) ?? new Map()).set(String(rest[1]), Number(rest[0]))).size
    if (name === 'ZREMRANGEBYSCORE') return 0
    if (name === 'ZCOUNT') return [...(scores.get(k)?.values() ?? [])].filter((score) => score >= Number(rest[0])).length
    throw new Error(`Unknown command ${name}`)
  }
  return {
    seen,
    handler: async (body: string) => {
      const commands = JSON.parse(body) as Command[]
      seen.push(...commands)
      return commands.map((command) => ({ result: run(command) }))
    }
  }
}

let db: ReturnType<typeof fakeRedis>
let githubReply: Response | Error

beforeEach(() => {
  db = fakeRedis()
  githubReply = new Response(JSON.stringify([{ assets: [{ download_count: 7 }, { download_count: 5 }] }]), { status: 200 })
  vi.stubEnv('KV_REST_API_URL', 'https://redis.test')
  vi.stubEnv('KV_REST_API_TOKEN', 'token')
  vi.stubEnv('ANALYTICS_PASSWORD', 'open-sesame')
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (String(url).startsWith('https://redis.test')) return new Response(JSON.stringify(await db.handler(String(init.body))))
    if (githubReply instanceof Error) throw githubReply
    return githubReply
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const trackRequest = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  track.fetch(
    new Request('https://getdolly.vercel.app/api/track', {
      method,
      headers: { origin: ORIGIN, 'user-agent': AGENT, 'x-forwarded-for': IP, ...headers },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
    })
  )

const statsRequest = (password: unknown = 'open-sesame', days: unknown = 30, ip = IP) =>
  stats.fetch(
    new Request('https://getdolly.vercel.app/api/stats', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      body: JSON.stringify({ password, days })
    })
  )

describe('/api/track', () => {
  it('counts a view, a visitor and who is online', async () => {
    expect((await trackRequest({ type: 'view' })).status).toBe(204)
    const names = db.seen.map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining(['INCR', 'PFADD', 'ZADD']))
  })

  it('counts a download by platform', async () => {
    expect((await trackRequest({ type: 'download', os: 'mac' })).status).toBe(204)
    expect(db.seen.some(([name, key]) => name === 'INCR' && String(key).endsWith(':mac'))).toBe(true)
  })

  it('never stores the IP address or the browser string', async () => {
    await trackRequest({ type: 'view' })
    const stored = JSON.stringify(db.seen)
    expect(stored).not.toContain(IP)
    expect(stored).not.toContain('Chrome')
  })

  it('gives the same visitor a new hash on a new day', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-01T10:00:00Z'), toFake: ['Date'] })
    await trackRequest({ type: 'view' })
    vi.setSystemTime(Date.parse('2026-11-02T10:00:00Z'))
    await trackRequest({ type: 'view' })
    vi.useRealTimers()
    const hashes = db.seen.filter(([name]) => name === 'PFADD').map(([, , hash]) => hash)
    expect(hashes).toHaveLength(2)
    expect(hashes[0]).not.toBe(hashes[1])
  })

  it('refuses other sites, other methods and bad events', async () => {
    expect((await trackRequest({ type: 'view' }, { origin: 'https://evil.test' })).status).toBe(403)
    expect((await trackRequest(null, {}, 'GET')).status).toBe(405)
    expect((await trackRequest({ type: 'nope' })).status).toBe(400)
    expect((await trackRequest({ type: 'download', os: 'linux' })).status).toBe(400)
    expect((await trackRequest('not json')).status).toBe(400)
    expect((await trackRequest({ type: 'view', pad: 'x'.repeat(400) })).status).toBe(413)
    expect(db.seen).toEqual([])
  })

  it('ignores bots', async () => {
    expect((await trackRequest({ type: 'view' }, { 'user-agent': 'Googlebot/2.1' })).status).toBe(204)
    expect(db.seen).toEqual([])
  })

  it('stays quiet with no database, or a broken one', async () => {
    vi.stubEnv('KV_REST_API_URL', '')
    expect((await trackRequest({ type: 'view' })).status).toBe(204)
    vi.stubEnv('KV_REST_API_URL', 'https://redis.test')
    vi.stubGlobal('fetch', async () => new Response('down', { status: 500 }))
    expect((await trackRequest({ type: 'view' })).status).toBe(204)
  })
})

describe('/api/stats', () => {
  it('adds up the days and works out conversion', async () => {
    await trackRequest({ type: 'view' })
    await trackRequest({ type: 'view' })
    await trackRequest({ type: 'view' }, { 'x-forwarded-for': '203.0.113.10' })
    await trackRequest({ type: 'download', os: 'mac' })
    await trackRequest({ type: 'download', os: 'windows' })

    const response = await statsRequest()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.days).toHaveLength(30)
    expect(body.totals).toMatchObject({ visitors: 2, views: 3, downloads: 2, downloaders: 1, mac: 1, windows: 1, conversion: 0.5 })
    expect(body.online).toBe(2)
    expect(body.github).toEqual({ downloads: 12, releases: 1 })
  })

  it('still answers when GitHub does not', async () => {
    githubReply = new Error('offline')
    const body = await (await statsRequest()).json()
    expect(body.github).toBeNull()
  })

  it('refuses a wrong password and locks out after repeated tries', async () => {
    for (let i = 0; i < 10; i++) expect((await statsRequest('nope')).status).toBe(401)
    expect((await statsRequest('nope')).status).toBe(429)
    expect((await statsRequest()).status).toBe(429)
    expect((await statsRequest('open-sesame', 30, '203.0.113.77')).status).toBe(200)
  })

  it('takes only the three ranges', async () => {
    expect((await statsRequest('open-sesame', 8)).status).toBe(400)
    expect((await statsRequest('open-sesame', 100000)).status).toBe(400)
    expect((await statsRequest(5)).status).toBe(400)
  })

  it('says so when it is not set up', async () => {
    vi.stubEnv('ANALYTICS_PASSWORD', '')
    expect((await statsRequest()).status).toBe(503)
  })
})
