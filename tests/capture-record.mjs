// Records for real without touching the UI, for acceptance runs such as A10. Launches the built app with a
// DevTools port on 127.0.0.1 and calls the same window.dolly.capture API the Home screen uses. Needs no test
// hook in the app. Build first with `npm run build`.
//
//   node tests/capture-record.mjs --seconds 20 --mic [--webcam] [--name demo] [--display <id>]
//                                 [--home <dir>] [--fake-media] [--keep-open] [--require-tap-events] [--no-clicks]
//
// --home redirects HOME and the user data folder, so the project lands in <dir>/Movies/Dolly instead of the real
// folder, and the run works beside an open Dolly.app.
// --fake-media uses Chromium's fake mic and camera, so no real device opens.
// --webcam only records on a Pro plan: on Free it is ignored, as it is in the app.
// --no-clicks records the way "Record without automatic zooms" does, with no event tap.
// --require-tap-events fails a macOS run whose mouse tap saw nothing, so move the mouse during the run. A tap can
// be created and still receive nothing, which the helper's own tapEvents count is there to catch.
//
// Prints one JSON object per line. A step of "recording" means t is running, so a script doing scripted clicks
// can start from that line. The last line has step "done" or "failed", and the exit code matches.

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')

const { values: args } = parseArgs({
  options: {
    seconds: { type: 'string', default: '20' },
    mic: { type: 'boolean', default: false },
    webcam: { type: 'boolean', default: false },
    name: { type: 'string' },
    display: { type: 'string' },
    home: { type: 'string' },
    'fake-media': { type: 'boolean', default: false },
    'keep-open': { type: 'boolean', default: false },
    'require-tap-events': { type: 'boolean', default: false },
    'no-clicks': { type: 'boolean', default: false }
  }
})

const say = (step, fields = {}) => console.log(JSON.stringify({ step, ...fields }))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function poll(what, timeoutMs, attempt) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await attempt().catch(() => null)
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

function launch() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (args.home) env.HOME = env.USERPROFILE = resolve(args.home)
  const switches = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']
  // Without this it shares a user data folder with an open Dolly.app, loses the single instance lock and quits
  if (args.home) switches.push(`--user-data-dir=${join(resolve(args.home), 'user-data')}`)
  if (args['fake-media']) switches.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream')
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

// Just enough of the DevTools protocol to run an expression in the page
async function connect(port) {
  const target = await poll('the main window', 30000, async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return list.find((t) => t.type === 'page' && /\/index\.html|^http:\/\/localhost/.test(t.url))
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = () => fail(new Error("Couldn't reach the DevTools port"))
  })
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
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(text.split('\n')[0].replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
    }
    return result.result.value
  }
}

async function record(evaluate) {
  await poll('the preload bridge', 30000, () => evaluate(`typeof window.dolly?.capture?.start === 'function'`))
  await evaluate(`window.__dollyEvents = []; window.dolly.capture.onEvent((e) => window.__dollyEvents.push(e)); true`)

  const displays = await evaluate('window.dolly.capture.displays()')
  const display = displays.find((d) => (args.display ? d.id === args.display : d.primary))
  if (!display) throw new Error('No matching display')
  say('ready', { displays, permissions: await evaluate('window.dolly.capture.permissions()') })

  const options = { displayId: display.id, mic: args.mic, webcam: args.webcam, clicks: !args['no-clicks'], name: args.name }
  await evaluate(`window.dolly.capture.start(${JSON.stringify(options)})`)
  const started = await evaluate(`window.__dollyEvents.find((e) => e.type === 'started')`)
  say('recording', { projectDir: started.projectDir, warnings: started.warnings ?? [] })

  await sleep(Number(args.seconds) * 1000)
  await evaluate('window.dolly.capture.stop()')
  const last = await poll('the recording to finish', 60000, () =>
    evaluate(`window.__dollyEvents.find((e) => e.type === 'stopped' || e.type === 'error') ?? null`)
  )
  if (last.type === 'error') throw new Error(last.message)
  if (args['require-tap-events'] && !last.tapEvents) throw new Error('The mouse tap saw no events')
  return { projectDir: started.projectDir, projectId: last.projectId, tapEvents: last.tapEvents ?? null, warnings: last.warnings ?? [] }
}

const { child, port } = launch()
let code = 0
try {
  const evaluate = await connect(await port)
  say('done', await record(evaluate))
} catch (error) {
  code = 1
  say('failed', { message: error.message })
}
if (!args['keep-open']) child.kill()
process.exit(code)
