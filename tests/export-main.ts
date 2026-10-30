// Electron entry for tests/export-fixture.mjs. Runs the real pipeline with no UI, then writes what compose()
// predicts for every frame so the fixture can compare it with the files. Not part of the app bundle.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, session } from 'electron'
import { buildCursorTrack } from '../src/engine/cursor'
import { checkRequest, exportForTest, type ExportResult, type FileStats } from '../src/main/export'
import { defaultDollyFolder } from '../src/main/paths'
import { parseCursorLog } from '../src/main/projects'
import { compose } from '../src/shared/compose'
import type { Plan } from '../src/shared/entitlements'
import type { OutputSettings, Project } from '../src/shared/project'

interface JobConfig {
  name: string
  projectDir: string
  output: OutputSettings
  plan: Plan
  threads?: number
  pro?: { webcam: boolean; captions: boolean } // Stands in for the plan in the predictions
  cancelAtPct?: number
  specStride?: number
}

interface Config {
  jobs: JobConfig[]
  result: string
  checkPaths?: boolean
}

const run = promisify(execFile)

function log(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: Date.now(), ...event })}\n`)
}

async function predict(job: JobConfig, stats: FileStats): Promise<unknown[]> {
  const project = JSON.parse(await readFile(join(job.projectDir, 'project.json'), 'utf8')) as Project
  const events = parseCursorLog(await readFile(join(job.projectDir, 'cursor.jsonl'), 'utf8').catch(() => ''))
  const track = buildCursorTrack(events, project.cursor)
  const size = { width: stats.width, height: stats.height }
  const specs: unknown[] = []
  const pro = job.pro ?? { webcam: false, captions: false }
  for (let n = 0; n < stats.frames; n += job.specStride ?? 1) {
    const s = compose(project, track, stats.shape, size, (n * 1000) / stats.fps, pro)
    specs.push({ n, camera: s.camera, screen: s.screen, cursor: s.cursor, zoom: s.zoom })
  }
  return specs
}

async function runJob(job: JobConfig): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const events: { pct: number; file: number }[] = []
  log({ ev: 'job-start', name: job.name })
  const started = performance.now()
  let result: ExportResult | null = null
  let error: string | null = null
  try {
    result = await exportForTest({
      projectDir: job.projectDir,
      output: job.output,
      plan: job.plan,
      threads: job.threads,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type !== 'progress') return
        events.push({ pct: e.pct, file: e.fileIndex })
        if (job.cancelAtPct !== undefined && e.pct >= job.cancelAtPct) controller.abort(new Error('Export cancelled'))
      }
    })
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const ms = performance.now() - started
  const leftRunning = await run('pgrep', ['-P', String(process.pid), 'ffmpeg']).then(
    ({ stdout }) => stdout.trim().split('\n').length,
    () => 0
  )
  log({ ev: 'job-end', name: job.name, ms, error })
  const specs = result ? await Promise.all(result.stats.map((s) => predict(job, s))) : []
  return { name: job.name, ms, error, stats: result?.stats ?? [], specs, progress: events, leftRunning }
}

app.dock?.hide()
app.on('window-all-closed', () => {}) // Each export closes its hidden window
app.whenReady().then(async () => {
  // Proves the renderer side needs no network: anything but local files fails the test
  const blocked: string[] = []
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const local = details.url.startsWith('file:') || details.url.startsWith('blob:') || details.url.startsWith('data:')
    if (!local) blocked.push(details.url)
    callback({ cancel: !local })
  })
  const config = JSON.parse(await readFile(process.env.DOLLY_EXPORT_TEST_CONFIG!, 'utf8')) as Config
  const results: unknown[] = []
  for (const job of config.jobs) results.push(await runJob(job))

  const rejected: Record<string, string | null> = {}
  if (config.checkPaths) await checkPaths(config, rejected)
  await writeFile(config.result, JSON.stringify({ results, blocked, rejected, gpu: await app.getGPUInfo('basic') }))
  log({ ev: 'finished' })
  app.quit()
})

async function checkPaths(config: Config, rejected: Record<string, string | null>): Promise<void> {
  const attempt = async (name: string, request: Parameters<typeof checkRequest>[0]) => {
    rejected[name] = await checkRequest(request).then(
      () => null,
      (e: Error) => e.message
    )
  }
  const output = config.jobs[0].output
  await attempt('projectOutsideDollyFolder', { projectDir: config.jobs[0].projectDir, output })
  const inDollyFolder = join(defaultDollyFolder(), 'dolly-export-test.dolly')
  await mkdir(inDollyFolder, { recursive: true })
  await attempt('folderNotChosen', { projectDir: inDollyFolder, output: { ...output, folder: join(homedir(), 'not-chosen') } })
  await rm(inDollyFolder, { recursive: true, force: true })
}
