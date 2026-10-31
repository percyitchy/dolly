// POST /api/track: counts one page view or download from the website. It always answers 204 to a well-formed
// request, so analytics can never break the page. The visitor hash changes every day, and no IP is stored.

import { clientIp, dayOf, json, keys, ONLINE_KEY, ONLINE_WINDOW_MS, redis, redisConfig, RETENTION_SECONDS, sha256, type Command, type Platform } from './_analytics'

const ORIGINS = new Set(['https://getdolly.vercel.app', 'https://dolly-psi.vercel.app'])
const MAX_BODY_BYTES = 256
const BOTS = /bot|crawl|spider|slurp|preview|headless|curl|wget|python|lighthouse/i

type Event = { type: 'view' } | { type: 'download'; os: Platform }

function parseEvent(text: string): Event | null {
  try {
    const value = JSON.parse(text) as { type?: unknown; os?: unknown }
    if (value.type === 'view') return { type: 'view' }
    if (value.type === 'download' && (value.os === 'mac' || value.os === 'windows')) return { type: 'download', os: value.os }
  } catch {
    return null
  }
  return null
}

function commandsFor(event: Event, visitor: string, now: number): Command[] {
  const day = dayOf(now)
  const counted = (key: string): Command[] => [['INCR', key], ['EXPIRE', key, RETENTION_SECONDS]]
  const unique = (key: string): Command[] => [['PFADD', key, visitor], ['EXPIRE', key, RETENTION_SECONDS]]
  if (event.type === 'download') {
    return [...counted(keys.downloads(day)), ...counted(keys.platform(day, event.os)), ...unique(keys.downloaders(day))]
  }
  return [
    ...counted(keys.views(day)),
    ...unique(keys.visitors(day)),
    ['ZADD', ONLINE_KEY, now, visitor],
    ['ZREMRANGEBYSCORE', ONLINE_KEY, 0, now - ONLINE_WINDOW_MS]
  ]
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  if (!ORIGINS.has(request.headers.get('origin') ?? '')) return json(403, { error: 'forbidden' })

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' })
  const event = parseEvent(text)
  if (!event) return json(400, { error: 'bad_event' })

  const agent = request.headers.get('user-agent') ?? ''
  const config = redisConfig()
  if (!config || !agent || BOTS.test(agent)) return new Response(null, { status: 204 })

  const now = Date.now()
  const visitor = sha256(`${config.token}:${dayOf(now)}:${clientIp(request)}:${agent}`).slice(0, 32)
  await redis(config, commandsFor(event, visitor, now)).catch(() => {})
  return new Response(null, { status: 204 })
}

export default { fetch: handle }
