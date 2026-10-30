// Project folders on disk: projects:* handlers and the dolly-media:// scheme that streams their files.
// Everything from the renderer is checked here. A path has to land inside the Dolly folder, after symlinks.

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { Readable } from 'node:stream'
import { dialog, protocol } from 'electron'
import { can } from '../shared/entitlements'
import type { OpenedProject, ProjectSummary } from '../shared/ipc'
import type { CursorEvent, Project } from '../shared/project'
import { handleFromMain, type Register } from './context'
import { currentPlan } from './license'
import { defaultDollyFolder } from './paths'

export const PROJECT_EXT = '.dolly'
export const PROJECT_FILE = 'project.json'
export const CURSOR_FILE = 'cursor.jsonl'

const SCHEME = 'dolly-media'
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp']
const MAX_NAME_CHARS = 80
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson'
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

// A folder name from free text. Safe on both file systems, and never a Windows device name
export function sanitizeName(name: unknown, fallback: string): string {
  const raw = typeof name === 'string' ? name : ''
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
  const trimmed = clean.replace(/^\.+|\.+$/g, '').trim().slice(0, MAX_NAME_CHARS).trim()
  if (!trimmed) return fallback
  return RESERVED_NAME.test(trimmed) ? `${fallback} ${trimmed}` : trimmed
}

// A project folder is exactly <root>/<name>.dolly. Checks the text only: realProjectDir also follows symlinks
export function checkProjectDir(root: string, dir: unknown): string {
  if (typeof dir !== 'string' || dir === '' || dir.includes('\0') || !isAbsolute(dir)) {
    throw new Error('Not a project folder')
  }
  const full = resolve(dir)
  if (dirname(full) !== resolve(root) || !basename(full).endsWith(PROJECT_EXT) || basename(full) === PROJECT_EXT) {
    throw new Error('Not a project folder')
  }
  return full
}

// A file named by a project: relative, forward or back slashes, never climbing out. Returns it with forward slashes
export function checkRelativeFile(file: unknown): string {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) throw new Error('Not a project file')
  if (posix.isAbsolute(file) || win32.isAbsolute(file) || /^[a-z]:/i.test(file)) throw new Error('Not a project file')
  const parts = file.split(/[/\\]/)
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error('Not a project file')
  return parts.join('/')
}

async function realInside(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root)
  const real = await realpath(target)
  if (!isInside(realRoot, real)) throw new Error('Path is outside the Dolly folder')
  return real
}

export async function realProjectDir(root: string, dir: unknown): Promise<string> {
  const full = checkProjectDir(root, dir)
  const real = await realInside(root, full)
  if (dirname(real) !== (await realpath(root))) throw new Error('Not a project folder')
  return full
}

// For other main-process modules that take a project folder from the renderer
export function assertProjectDir(dir: unknown): Promise<string> {
  return realProjectDir(defaultDollyFolder(), dir)
}

export async function realProjectFile(root: string, dir: unknown, file: unknown): Promise<string> {
  const folder = await realProjectDir(root, dir)
  const inside = join(folder, ...checkRelativeFile(file).split('/'))
  const real = await realInside(folder, inside)
  return real
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

// What save and open accept. Every file a project names stays inside its folder, so a bad project.json
// can't send the export or the media scheme somewhere else
export function assertProject(value: unknown): Project {
  if (!isObject(value) || value.version !== 1) throw new Error('Not a Dolly project')
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.createdAt !== 'string') {
    throw new Error('Not a Dolly project')
  }
  if (!isCount(value.durationMs) || !Array.isArray(value.clips) || !Array.isArray(value.zooms)) {
    throw new Error('Not a Dolly project')
  }
  if (!Array.isArray(value.captions) || !isObject(value.look) || !isObject(value.cursor) || !isObject(value.output)) {
    throw new Error('Not a Dolly project')
  }
  for (const clip of value.clips) {
    if (!isObject(clip) || !['screen', 'mic', 'webcam'].includes(clip.kind as string)) {
      throw new Error('Not a Dolly project')
    }
    if (!Number.isFinite(clip.startMs) || !isCount(clip.durationMs)) throw new Error('Not a Dolly project')
    checkRelativeFile(clip.file)
  }
  const background = value.look.background
  if (!isObject(background)) throw new Error('Not a Dolly project')
  if (background.kind === 'image') checkRelativeFile(background.file)
  return value as unknown as Project
}

// One event per line. A crash can leave a cut-off last line, so bad lines are skipped
export function parseCursorLog(text: string): CursorEvent[] {
  const events: CursorEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as CursorEvent
      if (Number.isFinite(event.t) && Number.isFinite(event.x) && Number.isFinite(event.y)) events.push(event)
    } catch {
      continue
    }
  }
  return events
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  return writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n')
}

// Makes <root>/<name>.dolly, adding a number when the name is taken. Never reuses a folder
export async function createProjectDir(root: string, name: string): Promise<string> {
  await mkdir(root, { recursive: true })
  for (let n = 1; n < 1000; n++) {
    const dir = join(root, `${n === 1 ? name : `${name} ${n}`}${PROJECT_EXT}`)
    try {
      await mkdir(dir)
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Too many projects share this name')
}

export async function readProject(dir: string): Promise<Project> {
  return assertProject(JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')))
}

export async function listProjects(root: string): Promise<ProjectSummary[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const found = await Promise.all(
    names
      .filter((n) => n.endsWith(PROJECT_EXT))
      .map(async (n): Promise<ProjectSummary | null> => {
        try {
          const dir = await realProjectDir(root, join(root, n))
          const p = await readProject(dir)
          return { id: p.id, name: p.name, dir, createdAt: p.createdAt, durationMs: p.durationMs }
        } catch {
          return null // A folder mid-recording or a damaged project isn't listed
        }
      })
  )
  return found.filter((p): p is ProjectSummary => p !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function openProject(root: string, dir: unknown): Promise<OpenedProject> {
  const folder = await realProjectDir(root, dir)
  const project = await readProject(folder)
  let cursor: CursorEvent[] = []
  try {
    cursor = parseCursorLog(await readFile(join(folder, CURSOR_FILE), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { dir: folder, project, cursor }
}

export async function saveProject(root: string, dir: unknown, project: unknown): Promise<void> {
  const folder = await realProjectDir(root, dir)
  await writeJsonAtomic(join(folder, PROJECT_FILE), assertProject(project))
}

export function mediaUrlFor(root: string, dir: unknown, file: unknown): string {
  const folder = checkProjectDir(root, dir)
  const parts = [basename(folder), ...checkRelativeFile(file).split('/')]
  return `${SCHEME}://project/${parts.map(encodeURIComponent).join('/')}`
}

// Undoes mediaUrlFor. The URL comes from a page, so it gets the same checks as any other renderer path
export function mediaFromUrl(root: string, url: string): { dir: string; file: string } {
  const parsed = new URL(url)
  if (parsed.protocol !== `${SCHEME}:` || parsed.hostname !== 'project') throw new Error('Not a media URL')
  const [folder, ...rest] = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (!folder || rest.length === 0 || /[/\\]/.test(folder)) throw new Error('Not a media URL')
  return { dir: checkProjectDir(root, join(root, folder)), file: checkRelativeFile(rest.join('/')) }
}

// null means send the whole file, 'invalid' means answer 416. Multiple ranges fall back to the whole file
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, from, to] = match
  if (from === '' && to === '') return 'invalid'
  if (from === '') {
    const count = Number(to)
    if (count === 0 || size === 0) return 'invalid'
    return { start: Math.max(0, size - count), end: size - 1 }
  }
  const start = Number(from)
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (start >= size || end < start) return 'invalid'
  return { start, end }
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export async function serveFile(path: string, rangeHeader: string | null, method: string): Promise<Response> {
  const info = await stat(path)
  if (!info.isFile()) return new Response('Not found', { status: 404 })
  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(path),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*', // Lets WebGL read video frames from a dolly-media URL
    'X-Content-Type-Options': 'nosniff'
  }
  const range = parseRange(rangeHeader, info.size)
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? info.size - 1
  headers['Content-Length'] = String(Math.max(0, end - start + 1))
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`
  const status = range ? 206 : 200
  if (method === 'HEAD' || info.size === 0) return new Response(null, { status, headers })
  const stream = Readable.toWeb(createReadStream(path, { start, end }))
  return new Response(stream as unknown as BodyInit, { status, headers })
}

// Must run before app ready
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

export function serveMedia(): void {
  protocol.handle(SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    try {
      const root = defaultDollyFolder()
      const { dir, file } = mediaFromUrl(root, request.url)
      const path = await realProjectFile(root, dir, file)
      return await serveFile(path, request.headers.get('range'), request.method)
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export async function importBackground(root: string, dir: unknown, source: string): Promise<string> {
  const ext = extname(source).toLowerCase()
  if (!IMAGE_EXTS.includes(ext.slice(1))) throw new Error('Not a supported image')
  const folder = await realProjectDir(root, dir)
  const file = `backgrounds/${randomUUID()}${ext}`
  await mkdir(join(folder, 'backgrounds'), { recursive: true })
  await copyFile(source, join(folder, ...file.split('/')))
  return file
}

export const register: Register = (ctx) => {
  const root = defaultDollyFolder
  handleFromMain(ctx, 'projects:list', () => listProjects(root()))
  handleFromMain(ctx, 'projects:open', (dir: unknown) => openProject(root(), dir))
  handleFromMain(ctx, 'projects:save', (dir: unknown, project: unknown) => saveProject(root(), dir, project))
  handleFromMain(ctx, 'projects:mediaUrl', async (dir: unknown, file: unknown) => {
    await realProjectFile(root(), dir, file)
    return mediaUrlFor(root(), dir, file)
  })
  handleFromMain(ctx, 'projects:pickBackgroundImage', async (dir: unknown) => {
    await realProjectDir(root(), dir)
    if (!can(currentPlan(), 'customBackground')) return null
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a background',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: IMAGE_EXTS }]
    }
    const win = ctx.mainWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return null
    return importBackground(root(), dir, picked.filePaths[0])
  })
}
