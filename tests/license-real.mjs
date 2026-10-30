// Drives the built app against the deployed license server: A16 with no key, A15 with DOLLY_TEST_KEY.
//   npm run build && node tests/license-real.mjs
// A real key takes one of its 3 device slots. Reruns with the same key on this Mac reuse that slot.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const dir = mkdtempSync(join(tmpdir(), 'dolly-license-'))
const key = process.env.DOLLY_TEST_KEY?.trim()

function start() {
  const env = { ...process.env, HOME: dir, USERPROFILE: dir }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DOLLY_TEST_KEY
  const switches = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${join(dir, 'data')}`]
  const child = spawn(electron, ['.', ...switches], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] })
  const port = new Promise((done, fail) => {
    let text = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      text += chunk
      const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)
      if (found) done(Number(found[1]))
    })
    child.on('exit', (code) => fail(new Error(`The app exited early with code ${code}`)))
  })
  return { child, port }
}

async function until(what, read) {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    const value = await read().catch(() => null)
    if (value) return value
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

async function connect(port) {
  const target = await until('the main window', async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return list.find((t) => t.type === 'page' && /\/index\.html/.test(t.url))
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done) => (socket.onopen = done))
  let nextId = 1
  const waiting = new Map()
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data)
    waiting.get(reply.id)?.(reply)
    waiting.delete(reply.id)
  }
  return async (expression) => {
    const id = nextId++
    const reply = new Promise((done) => waiting.set(id, done))
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    const { result } = await reply
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
}

async function session(steps) {
  const { child, port } = start()
  try {
    const evaluate = await connect(await port)
    await until('the bridge', () => evaluate(`typeof window.dolly?.license?.status === 'function'`))
    return await steps(evaluate)
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 800))
  }
}

const plan = async (evaluate) => (await evaluate('window.dolly.license.status()')).plan
const activate = (evaluate, value) => evaluate(`window.dolly.license.activate(${JSON.stringify(value)})`)
let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

try {
  await session(async (evaluate) => {
    check('starts on Free', (await plan(evaluate)) === 'free')
    const result = await activate(evaluate, 'FAKE00-FAKE00-FAKE00')
    check('a fake key is rejected', result.ok === false && result.reason === 'invalid_key', JSON.stringify(result))
    check('Pro stays locked', (await plan(evaluate)) === 'free')
    if (key) {
      const real = await activate(evaluate, key)
      check('the real key unlocks Pro', real.ok === true, real.ok ? '' : `reason ${real.reason}`)
      check('the plan is now Pro', (await plan(evaluate)) === 'pro')
    }
  })
  if (key) {
    await session(async (evaluate) => check('Pro survives a restart', (await plan(evaluate)) === 'pro'))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
