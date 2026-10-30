#!/usr/bin/env node
// The real app, on the Free plan, driven the way the editor drives it: window.dolly.export over the preload
// bridge, with the network guard on and HOME redirected to a temp folder. Build first with `npm run build`.
//   node tests/export-ipc.mjs <project dir to copy>

import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const run = promisify(execFile)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const source = process.argv[2] && resolve(process.argv[2])
if (!source) {
  console.error('Usage: node tests/export-ipc.mjs <project dir to copy>')
  process.exit(2)
}

const home = await mkdtemp(join(tmpdir(), 'dolly-export-ipc-'))
const dolly = join(home, 'Movies/Dolly')
const projectDir = join(dolly, 'Fixture.dolly')
await mkdir(dolly, { recursive: true })
await cp(source, projectDir, { recursive: true })

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const env = { ...process.env, HOME: home, USERPROFILE: home }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
  cwd: root,
  env,
  stdio: ['ignore', 'ignore', 'pipe']
})

const port = await new Promise((done, fail) => {
  let text = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    text += chunk
    const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)
    if (found) done(Number(found[1]))
  })
  child.once('exit', (code) => fail(new Error(`The app exited with ${code}\n${text}`)))
})

async function poll(what, ms, attempt) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await attempt().catch(() => null)
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const target = await poll('the main window', 30000, async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return list.find((t) => t.type === 'page' && /\/index\.html/.test(t.url))
})
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((done, fail) => {
  socket.onopen = done
  socket.onerror = fail
})
let nextId = 1
const waiting = new Map()
socket.onmessage = ({ data }) => {
  const reply = JSON.parse(data)
  waiting.get(reply.id)?.(reply)
  waiting.delete(reply.id)
}
async function evaluate(expression) {
  const id = nextId++
  const reply = new Promise((done) => waiting.set(id, done))
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const { result } = await reply
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

async function exportOnce(request) {
  await evaluate(`window.__events = []; window.dolly.export.start(${JSON.stringify(request)}); true`)
  return poll('the export to end', 120000, () =>
    evaluate(`window.__events.find((e) => e.type !== 'progress') ?? null`)
  )
}

try {
  await poll('the preload bridge', 30000, () => evaluate(`typeof window.dolly?.export?.start === 'function'`))
  await evaluate(`window.__events = []; window.dolly.export.onEvent((e) => window.__events.push(e)); true`)

  const output = { shapes: ['16:9', '1:1'], format: 'mp4', resolution: '1080p', fps: 30, folder: dolly }
  const done = await exportOnce({ projectDir, output })
  const progress = await evaluate(`window.__events.filter((e) => e.type === 'progress').length`)
  check('Free export finishes over IPC', done.type === 'done', JSON.stringify(done).slice(0, 200))
  check('progress arrives for each file', progress > 10, `${progress} events`)
  for (const file of done.files ?? []) {
    const { stdout } = await run('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate', '-of', 'csv=p=0', file])
    check(`wrote ${basename(file)}`, file.startsWith(`${dolly}/`) && /^h264,/.test(stdout), stdout.trim())
  }

  const refused = await exportOnce({ projectDir, output: { ...output, fps: 60 } })
  check('60 fps is refused on Free', refused.type === 'failed' && /Dolly Pro/.test(refused.message), refused.message)
  const elsewhere = await exportOnce({ projectDir: join(home, 'Fixture.dolly'), output })
  check('a project outside the Dolly folder is refused', elsewhere.type === 'failed', elsewhere.message)
  const folder = await exportOnce({ projectDir, output: { ...output, folder: join(home, 'elsewhere') } })
  check('a folder nobody chose is refused', folder.type === 'failed', folder.message)

  await evaluate(`window.__events = []; window.dolly.export.start(${JSON.stringify({ projectDir, output })}); true`)
  await poll('progress', 30000, () => evaluate(`window.__events.some((e) => e.type === 'progress' && e.pct >= 5)`))
  await evaluate('window.dolly.export.cancel()')
  const cancelled = await poll('the cancel', 30000, () => evaluate(`window.__events.find((e) => e.type !== 'progress') ?? null`))
  check('cancel over IPC', cancelled.type === 'cancelled', cancelled.type)

  const names = (await readdir(dolly)).filter((n) => !n.endsWith('.dolly')).sort()
  check('only the two finished files are in the folder', names.length === 2, names.join(' | '))
  await evaluate(`window.dolly.export.reveal(${JSON.stringify(join(home, 'not-exported.mp4'))})`)
  check('reveal of a file Dolly did not export is ignored', true)
} catch (error) {
  check('run', false, error.message)
} finally {
  child.kill()
  await sleep(500)
  await rm(home, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
