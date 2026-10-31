// Shared by /api/track and /api/stats. The underscore keeps Vercel from serving this file as a function.
// Counts visits to the website only. The Dolly app sends nothing here, and no IP address or cookie is stored.

import { createHash } from 'node:crypto'

const REDIS_TIMEOUT_MS = 3000

export const RETENTION_SECONDS = 400 * 24 * 60 * 60
export const ONLINE_WINDOW_MS = 5 * 60 * 1000
export const ONLINE_KEY = 'dolly:online'

export const keys = {
  views: (day: string) => `dolly:views:${day}`,
  visitors: (day: string) => `dolly:visitors:${day}`,
  downloads: (day: string) => `dolly:downloads:${day}`,
  downloaders: (day: string) => `dolly:downloaders:${day}`,
  platform: (day: string, os: Platform) => `dolly:downloads:${day}:${os}`
}

export type Platform = 'mac' | 'windows'
export type Command = (string | number)[]

interface RedisConfig {
  url: string
  token: string
}

// Vercel's storage integration names these KV_REST_API_*, and a direct Upstash setup names them UPSTASH_*
export function redisConfig(): RedisConfig | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url, token } : null
}

export async function redis(config: RedisConfig, commands: Command[]): Promise<unknown[]> {
  const response = await fetch(`${config.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error('The analytics database is unavailable')
  const replies = (await response.json()) as { result?: unknown; error?: string }[]
  return replies.map((reply) => {
    if (reply.error) throw new Error('The analytics database refused a command')
    return reply.result
  })
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? ''
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  })
}
