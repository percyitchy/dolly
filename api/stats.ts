// POST /api/stats: the numbers behind /stats. Open to anyone with the link, since they're only totals. Setting
// ANALYTICS_PASSWORD makes them private, and an address is then locked out after repeated misses.

import { timingSafeEqual } from 'node:crypto'
import { clientIp, dayOf, json, keys, ONLINE_KEY, ONLINE_WINDOW_MS, redis, redisConfig, sha256, type Command } from './_analytics'

const RANGES = new Set([7, 30, 90])
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_BODY_BYTES = 512
const MAX_FAILURES = 10
const LOCKOUT_SECONDS = 15 * 60
const GITHUB_RELEASES = 'https://api.github.com/repos/percyitchy/dolly/releases?per_page=100'
const GITHUB_TIMEOUT_MS = 3000

interface GithubTotals {
  downloads: number
  releases: number
}

function same(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)))
}

function count(value: unknown): number {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

async function githubTotals(): Promise<GithubTotals | null> {
  try {
    const response = await fetch(GITHUB_RELEASES, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dolly-stats' },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const releases = (await response.json()) as { assets?: { download_count?: number }[] }[]
    const downloads = releases.flatMap((r) => r.assets ?? []).reduce((sum, asset) => sum + count(asset.download_count), 0)
    return { downloads, releases: releases.length }
  } catch {
    return null
  }
}

const PER_DAY = 6

function dayCommands(day: string): Command[] {
  return [
    ['GET', keys.views(day)],
    ['PFCOUNT', keys.visitors(day)],
    ['GET', keys.downloads(day)],
    ['PFCOUNT', keys.downloaders(day)],
    ['GET', keys.platform(day, 'mac')],
    ['GET', keys.platform(day, 'windows')]
  ]
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  const password = process.env.ANALYTICS_PASSWORD
  const config = redisConfig()
  if (!config) return json(503, { error: 'not_configured' })

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' })
  let input: { password?: unknown; days?: unknown }
  try {
    input = JSON.parse(text)
  } catch {
    return json(400, { error: 'bad_request' })
  }
  const days = Number(input.days)
  const given = input.password ?? ''
  if (typeof given !== 'string' || !RANGES.has(days)) return json(400, { error: 'bad_request' })

  try {
    const failKey = `dolly:stats-failures:${sha256(clientIp(request))}`
    if (password) {
      const [failures] = await redis(config, [['GET', failKey]])
      if (count(failures) >= MAX_FAILURES) return json(429, { error: 'locked' })
      if (!same(given, password)) {
        await redis(config, [['INCR', failKey], ['EXPIRE', failKey, LOCKOUT_SECONDS]])
        return json(401, { error: 'wrong_password' })
      }
    }

    const now = Date.now()
    const dates = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * DAY_MS))
    const [replies, github] = await Promise.all([
      redis(config, [...dates.flatMap(dayCommands), ['ZCOUNT', ONLINE_KEY, now - ONLINE_WINDOW_MS, '+inf']]),
      githubTotals()
    ])

    const rows = dates.map((date, i) => {
      const [views, visitors, downloads, downloaders, mac, windows] = replies.slice(i * PER_DAY, (i + 1) * PER_DAY).map(count)
      return { date, views, visitors, downloads, downloaders, mac, windows }
    })
    const sum = (field: keyof (typeof rows)[number]) => rows.reduce((total, row) => total + Number(row[field]), 0)
    const visitors = sum('visitors')
    return json(200, {
      days: rows.map(({ date, views, visitors: people, downloads }) => ({ date, views, visitors: people, downloads })),
      totals: {
        visitors,
        views: sum('views'),
        downloads: sum('downloads'),
        downloaders: sum('downloaders'),
        mac: sum('mac'),
        windows: sum('windows'),
        conversion: visitors ? sum('downloaders') / visitors : 0
      },
      online: count(replies.at(-1)),
      github,
      locked: !!password
    })
  } catch {
    return json(503, { error: 'unavailable' })
  }
}

export default { fetch: handle }
