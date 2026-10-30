// The app side of licensing, against the real api/validate handler with Whop mocked underneath it.

import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import validate from '../api/validate'

const h = await vi.hoisted(async () => {
  const { generateKeyPairSync: generate } = await import('node:crypto')
  const { publicKey, privateKey } = generate('ed25519')
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    signingKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    dir: '',
    machineId: '',
    netFetch: (() => Promise.reject(new Error('unset'))) as (url: string, init: RequestInit) => Promise<Response>,
    openExternal: vi.fn(async () => {}),
    handlers: new Map<string, (...args: unknown[]) => unknown>()
  }
})

vi.mock('electron', () => ({
  app: { commandLine: { appendSwitch: () => {} } },
  session: {},
  shell: { openExternal: h.openExternal },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(channel, handler) },
  net: { fetch: (url: string, init: RequestInit) => h.netFetch(url, init) }
}))

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: () => `| "IOPlatformUUID" = "${h.machineId}"\n    MachineGuid    REG_SZ    ${h.machineId}\n`
}))

vi.mock('../src/main/paths', () => ({ licenseFile: () => join(h.dir, 'license.json') }))

vi.mock('../src/shared/config', async (original) => ({
  ...(await original<typeof import('../src/shared/config')>()),
  LICENSE_PUBLIC_KEY: h.publicKey,
  VALIDATE_ENDPOINT: 'https://license.test/api/validate'
}))

const KEY = 'A1B2C3-D4E5F6-G7H8I9'
const realSetTimeout = globalThis.setTimeout
const MACHINE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const MACHINE_B = 'bbbbbbbb-0000-4000-8000-000000000002'

let membership: Record<string, unknown> | null
let whopFailure: number | null

const licensePath = () => join(h.dir, 'license.json')
const savedFile = () => JSON.parse(readFileSync(licensePath(), 'utf8'))

// A fresh process on a given machine: new module state, new device ID
async function launch(machineId = MACHINE_A) {
  h.machineId = machineId
  vi.resetModules()
  const license = await import('../src/main/license')
  license.loadLicense()
  return license
}

function offline(): void {
  h.netFetch = () => {
    throw new Error('No network call was expected')
  }
}

beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'dolly-license-'))
  h.handlers.clear()
  h.openExternal.mockClear()
  whopFailure = null
  membership = { id: 'mem_abc123', status: 'active', product: { id: 'prod_test' }, metadata: null }
  vi.stubEnv('WHOP_API_KEY', 'test-whop-api-key')
  vi.stubEnv('WHOP_PRODUCT_ID', 'prod_test')
  vi.stubEnv('LICENSE_SIGNING_KEY', h.signingKey)

  h.netFetch = (url, init) => validate.fetch(new Request(url, init))
  vi.stubGlobal('setTimeout', (run: () => void) => realSetTimeout(run, 0)) // The handler's settle time
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    if (whopFailure) return new Response('{}', { status: whopFailure })
    if (!membership) return new Response('{}', { status: 404 })
    if (init.method === 'PATCH') membership.metadata = JSON.parse(String(init.body)).metadata
    return Response.json(membership)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(h.dir, { recursive: true, force: true })
})

describe('deviceId', () => {
  it('reads the macOS and Windows machine IDs', async () => {
    const { parseMachineId } = await launch()
    const ioreg = '+-o Mac  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "AAAAAAAA-1111-4222-8333-444444444444"\n'
    const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    bbbbbbbb-1111-4222-8333-444444444444\r\n\r\n'
    expect(parseMachineId('darwin', ioreg)).toBe('aaaaaaaa-1111-4222-8333-444444444444')
    expect(parseMachineId('win32', reg)).toBe('bbbbbbbb-1111-4222-8333-444444444444')
    expect(parseMachineId('darwin', 'nothing here')).toBeNull()
    expect(parseMachineId('win32', 'nothing here')).toBeNull()
  })

  it('trusts SystemRoot to find reg.exe only in dev', async () => {
    const { regExePath } = await launch()
    const env = { SystemRoot: 'D:\\Evil' }
    const has = (...paths: string[]) => (path: string) => paths.includes(path)
    expect(regExePath(false, env)).toBe(win32.join('D:\\Evil', 'System32', 'reg.exe'))
    expect(regExePath(true, env, () => true)).toBe('C:\\Windows\\System32\\reg.exe')
    expect(regExePath(true, env, has('D:\\Evil\\System32\\reg.exe'))).toBe('C:\\Windows\\System32\\reg.exe')
    expect(regExePath(true, env, has('E:\\Windows\\System32\\reg.exe'))).toBe('E:\\Windows\\System32\\reg.exe')
  })

  it('is a salted SHA-256 cut to 16 hex characters', async () => {
    const { deriveDeviceId } = await launch()
    const id = deriveDeviceId(MACHINE_A)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(id).toBe(deriveDeviceId(MACHINE_A))
    expect(id).not.toBe(deriveDeviceId(MACHINE_B))
    expect(id).not.toBe(createHash('sha256').update(MACHINE_A).digest('hex').slice(0, 16))
  })
})

describe('activate (A5)', () => {
  it('starts on Free', async () => {
    expect((await launch()).currentPlan()).toBe('free')
  })

  it('unlocks Pro and saves only the token and a hash of the key', async () => {
    const license = await launch()
    expect(await license.activate(`  ${KEY}\n`)).toEqual({ ok: true })
    expect(license.currentPlan()).toBe('pro')
    const saved = savedFile()
    expect(Object.keys(saved).sort()).toEqual(['keyHash', 'token'])
    expect(saved.keyHash).toBe(license.hashKey(KEY))
    expect(readFileSync(licensePath(), 'utf8')).not.toContain(KEY)
    expect(existsSync(`${licensePath()}.tmp`)).toBe(false)
  })

  it('posts to the endpoint once, with no redirects and a timeout', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    h.netFetch = (url, init) => {
      seen.push({ url, init })
      return validate.fetch(new Request(url, init))
    }
    await (await launch()).activate(KEY)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://license.test/api/validate')
    expect(seen[0].init.method).toBe('POST')
    expect(seen[0].init.redirect).toBe('error')
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('stays Pro after a restart with no network', async () => {
    await (await launch()).activate(KEY)
    offline()
    expect((await launch()).currentPlan()).toBe('pro')
  })

  it.each([
    ['invalid_key', () => (membership = null)],
    ['inactive', () => (membership!.status = 'canceled')],
    ['wrong_product', () => (membership!.product = { id: 'prod_other' })],
    ['device_limit', () => (membership!.metadata = { hwid: '1111111111111111,2222222222222222,3333333333333333' })]
  ])('keeps Pro locked on %s', async (reason, arrange) => {
    arrange()
    const license = await launch()
    expect(await license.activate(KEY)).toEqual({ ok: false, reason })
    expect(license.currentPlan()).toBe('free')
    expect(existsSync(licensePath())).toBe(false)
  })

  it('rejects an empty or non-string key without a network call', async () => {
    const license = await launch()
    offline()
    for (const key of ['', '   ', undefined, 42, {}]) {
      expect(await license.activate(key)).toEqual({ ok: false, reason: 'invalid_key' })
    }
  })

  it('reports a malformed key the server turned down as invalid_key', async () => {
    expect(await (await launch()).activate('not/a/key')).toEqual({ ok: false, reason: 'invalid_key' })
  })

  it('refuses a 4th device and lets a listed device back in', async () => {
    const machines = [MACHINE_A, MACHINE_B, 'cccccccc-0000-4000-8000-000000000003']
    for (const machine of machines) expect(await (await launch(machine)).activate(KEY)).toEqual({ ok: true })

    const fourth = await launch('dddddddd-0000-4000-8000-000000000004')
    expect(await fourth.activate(KEY)).toEqual({ ok: false, reason: 'device_limit' })
    expect(fourth.currentPlan()).toBe('free')

    rmSync(licensePath(), { force: true })
    const listed = await launch(MACHINE_B)
    expect(await listed.activate(KEY)).toEqual({ ok: true })
    expect(listed.currentPlan()).toBe('pro')
  })
})

describe('network trouble', () => {
  async function expectNetworkFailure(arrange: () => void): Promise<void> {
    const license = await launch()
    arrange()
    expect(await license.activate(KEY)).toEqual({ ok: false, reason: 'network' })
    expect(license.currentPlan()).toBe('free')
    expect(existsSync(licensePath())).toBe(false)
  }

  it('calls a connection failure network', () =>
    expectNetworkFailure(() => {
      h.netFetch = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
    }))

  it('calls a timeout network', () =>
    expectNetworkFailure(() => {
      h.netFetch = () => Promise.reject(new DOMException('timed out', 'TimeoutError'))
    }))

  it('calls Whop rate limiting network', () =>
    expectNetworkFailure(() => {
      whopFailure = 429
    }))

  it('calls a Whop outage network', () =>
    expectNetworkFailure(() => {
      whopFailure = 500
    }))

  it('calls an HTML error page network', () =>
    expectNetworkFailure(() => {
      h.netFetch = async () => new Response('<html>', { status: 200 })
    }))

  it('calls a 404 from anywhere but the server network', () =>
    expectNetworkFailure(() => {
      h.netFetch = async () => new Response('{"valid":false,"reason":"invalid_key"}', { status: 404 })
    }))

  it('calls an unknown reason network', () =>
    expectNetworkFailure(() => {
      h.netFetch = async () => Response.json({ valid: false, reason: 'surprise' })
    }))

  it('calls an unusually large answer network', () =>
    expectNetworkFailure(() => {
      h.netFetch = async () => new Response(`{"valid":true,"token":"${'a'.repeat(5000)}"}`)
    }))

  it('does not trust a token signed by another key', () =>
    expectNetworkFailure(() => {
      h.netFetch = async () => {
        const stranger = generateKeyPairSync('ed25519').privateKey
        const payload = Buffer.from('{}').toString('base64url')
        const { sign } = await import('node:crypto')
        return Response.json({ valid: true, token: `${payload}.${sign(null, Buffer.from(payload), stranger).toString('base64url')}` })
      }
    }))

  it('does not trust a token issued for another device', async () => {
    const other = await launch(MACHINE_B)
    await other.activate(KEY)
    const foreign = savedFile().token
    rmSync(licensePath())
    await expectNetworkFailure(() => {
      h.netFetch = async () => Response.json({ valid: true, token: foreign })
    })
  })

  it('does not trust a token for a different key', async () => {
    const license = await launch()
    await license.activate('ANOTHER-GOOD-KEY1')
    const foreign = savedFile().token
    rmSync(licensePath())
    await expectNetworkFailure(() => {
      h.netFetch = async () => Response.json({ valid: true, token: foreign })
    })
  })

  it('leaves an existing license alone', async () => {
    const license = await launch()
    await license.activate(KEY)
    const before = readFileSync(licensePath(), 'utf8')
    h.netFetch = () => Promise.reject(new Error('offline'))
    expect(await license.activate('ANOTHER-GOOD-KEY1')).toEqual({ ok: false, reason: 'network' })
    expect(license.currentPlan()).toBe('pro')
    expect(readFileSync(licensePath(), 'utf8')).toBe(before)
  })

  it('leaves an existing license alone when a new key is refused', async () => {
    const license = await launch()
    await license.activate(KEY)
    membership = null
    expect(await license.activate('ANOTHER-GOOD-KEY1')).toEqual({ ok: false, reason: 'invalid_key' })
    expect(license.currentPlan()).toBe('pro')
  })
})

describe('trouble that is not the network', () => {
  it('says so when the machine ID cannot be read', async () => {
    h.machineId = 'not a uuid'
    vi.resetModules()
    const license = await import('../src/main/license')
    offline()
    expect(await license.activate(KEY)).toEqual({ ok: false, reason: 'device_id' })
  })

  it('says so when the license cannot be written', async () => {
    const license = await launch()
    rmSync(h.dir, { recursive: true, force: true })
    writeFileSync(h.dir, 'a file where the folder should be')
    expect(await license.activate(KEY)).toEqual({ ok: false, reason: 'save' })
    expect(license.currentPlan()).toBe('free')
    rmSync(h.dir)
    mkdirSync(h.dir)
  })

  it('says so when the server is rate limiting', async () => {
    const license = await launch()
    h.netFetch = async () => new Response('Too Many Requests', { status: 429 })
    expect(await license.activate(KEY)).toEqual({ ok: false, reason: 'rate_limited' })
    expect(license.currentPlan()).toBe('free')
  })

  it('does not let a body claim a limit the status never showed', async () => {
    const license = await launch()
    h.netFetch = async () => Response.json({ valid: false, reason: 'surprise' })
    expect(await license.activate(KEY)).toEqual({ ok: false, reason: 'network' })
  })
})

describe('offline check (A6)', () => {
  async function activated() {
    await (await launch()).activate(KEY)
    offline()
    return savedFile() as { token: string; keyHash: string }
  }

  const write = (content: unknown) => writeFileSync(licensePath(), typeof content === 'string' ? content : JSON.stringify(content))

  it('fails every single-character edit of the token', async () => {
    const saved = await activated()
    const { token } = saved
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '.') continue
      const swapped = token[i] === 'A' ? 'B' : 'A'
      write({ ...saved, token: token.slice(0, i) + swapped + token.slice(i + 1) })
      expect((await launch()).currentPlan(), `edit at ${i}`).toBe('free')
    }
  })

  it('fails a signature edited in bits that base64url would ignore', async () => {
    const saved = await activated()
    const stem = saved.token.slice(0, -1)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    for (const last of alphabet.replace(saved.token.slice(-1), '')) {
      write({ ...saved, token: stem + last })
      expect((await launch()).currentPlan(), `last character ${last}`).toBe('free')
    }
  })

  it('fails a forged payload with the old signature', async () => {
    const saved = await activated()
    const [, signature] = saved.token.split('.')
    const forged = Buffer.from(JSON.stringify({ keyHash: saved.keyHash, deviceId: 'ffffffffffffffff', iat: 1 })).toString('base64url')
    write({ ...saved, token: `${forged}.${signature}` })
    expect((await launch()).currentPlan()).toBe('free')
  })

  it('fails an edited key hash', async () => {
    const saved = await activated()
    write({ ...saved, keyHash: '0'.repeat(64) })
    expect((await launch()).currentPlan()).toBe('free')
  })

  it('fails a file copied to another device', async () => {
    await activated()
    expect((await launch(MACHINE_A)).currentPlan()).toBe('pro')
    expect((await launch(MACHINE_B)).currentPlan()).toBe('free')
  })

  it.each([
    ['plain text', 'pro'],
    ['empty', ''],
    ['null', 'null'],
    ['a flag', { pro: true, plan: 'pro' }],
    ['a token with no signature', { token: 'abc', keyHash: 'abc' }],
    ['a token with three parts', { token: 'a.b.c', keyHash: 'abc' }],
    ['a number for a token', { token: 7, keyHash: 7 }]
  ])('fails a file holding %s', async (_, content) => {
    write(content)
    expect((await launch()).currentPlan()).toBe('free')
  })

  it('verifies nothing against the placeholder public key', async () => {
    const saved = await activated()
    const { verifyToken } = await launch()
    const deviceId = JSON.parse(Buffer.from(saved.token.split('.')[0], 'base64url').toString()).deviceId
    expect(verifyToken(saved.token, deviceId)).not.toBeNull()
    expect(verifyToken(saved.token, deviceId, 'REPLACE_ME')).toBeNull()
    expect(verifyToken(saved.token, deviceId, '')).toBeNull()
  })
})

describe('deactivateLocal', () => {
  it('deletes the file and goes back to Free', async () => {
    const license = await launch()
    await license.activate(KEY)
    license.deactivateLocal()
    expect(existsSync(licensePath())).toBe(false)
    expect(license.currentPlan()).toBe('free')
    expect((await launch()).currentPlan()).toBe('free')
  })

  it('is fine with no file', async () => {
    const license = await launch()
    license.deactivateLocal()
    expect(license.currentPlan()).toBe('free')
  })
})

describe('IPC handlers', () => {
  it('registers every license channel in ipc.ts', async () => {
    const license = await launch()
    const sender = {}
    const event = { sender }
    license.register({ mainWindow: () => ({ webContents: sender }) as never, send: () => {} })
    expect([...h.handlers.keys()].sort()).toEqual([
      'license:activate',
      'license:deactivateLocal',
      'license:openStore',
      'license:status'
    ])
    expect(await h.handlers.get('license:status')?.(event)).toEqual({ plan: 'free' })
    expect(await h.handlers.get('license:activate')?.(event, KEY)).toEqual({ ok: true })
    expect(await h.handlers.get('license:status')?.(event)).toEqual({ plan: 'pro' })
    await h.handlers.get('license:deactivateLocal')?.(event)
    expect(await h.handlers.get('license:status')?.(event)).toEqual({ plan: 'free' })
  })

  it('checks the saved token as soon as it registers', async () => {
    await (await launch()).activate(KEY)
    vi.resetModules()
    const license = await import('../src/main/license')
    expect(license.currentPlan()).toBe('free')
    license.register({ mainWindow: () => null, send: () => {} })
    expect(license.currentPlan()).toBe('pro')
  })

  it('opens the store page in the browser and nothing else', async () => {
    const { WHOP_URL } = await import('../src/shared/config')
    await (await launch()).openStore()
    expect(h.openExternal.mock.calls).toEqual([[WHOP_URL]])
  })
})

describe('generate-license-keys.mjs', () => {
  it('prints a keypair that works from the server to the app, and writes nothing', async () => {
    const script = new URL('../scripts/generate-license-keys.mjs', import.meta.url).pathname
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: h.dir })
    expect(run.status).toBe(0)
    const [, publicKey, signingKey] = /config\.ts:\n\n(\S+)\n[\s\S]*nowhere else:\n\n(\S+)\n/.exec(run.stdout) ?? []
    expect(Buffer.from(publicKey, 'base64')).toHaveLength(32)

    vi.stubEnv('LICENSE_SIGNING_KEY', signingKey)
    const response = await validate.fetch(
      new Request('https://license.test/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: KEY, deviceId: 'aaaaaaaaaaaaaaaa' })
      })
    )
    const { token } = await response.json()
    const { verifyToken } = await launch()
    expect(verifyToken(token, 'aaaaaaaaaaaaaaaa', publicKey)?.deviceId).toBe('aaaaaaaaaaaaaaaa')
    expect(verifyToken(token, 'aaaaaaaaaaaaaaaa')).toBeNull()

    expect(readFileSync(script, 'utf8')).not.toMatch(/writeFile|appendFile|createWriteStream/)
  })
})
