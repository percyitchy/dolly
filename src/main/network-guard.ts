// Dolly's only network rule: local app content, plus one POST to the license endpoint from main.
// Nothing here phones home, and crashReporter and autoUpdater are never started.

import { join, posix, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, net, session, shell, type MediaAccessPermissionRequest, type Session } from 'electron'
import { REPO_URL, VALIDATE_ENDPOINT, WHOP_URL } from '../shared/config'
import { allowPermission, guardContents } from './window-guard'

export interface GuardPolicy {
  validateEndpoint: string
  rendererRoot: string // file: URL ending in a slash
  devOrigin: string | null // Only ever set in an unpackaged build
  allowDevtools: boolean
}

export interface GuardRequest {
  url: string
  method: string
  fromMain: boolean // True for requests no web page started
}

// fileURLToPath throws on a % that starts no escape, and such a URL can reach here if a path wasn't encoded
function decodedPath(url: string, windows: boolean): string {
  return fileURLToPath(url.replace(/%(?![0-9a-f]{2})/gi, '%25'), { windows })
}

// Compares decoded paths, because Chromium and pathToFileURL escape [ ] ~ % differently. Windows paths compare
// without case, and an encoded slash could step out of the root
function insideRoot(url: URL, root: string): boolean {
  if (/%2f|%5c/i.test(url.pathname)) return false
  const windows = /^file:\/\/\/[a-z]:\//i.test(root)
  const paths = windows ? win32 : posix
  try {
    const rel = paths.relative(decodedPath(root, windows), decodedPath(url.href, windows))
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel)
  } catch {
    return false
  }
}

function fromDevServer(url: URL, devOrigin: string): boolean {
  const dev = new URL(devOrigin)
  if (url.host !== dev.host) return false
  return url.protocol === dev.protocol || url.protocol === 'ws:'
}

export function allowRequest(request: GuardRequest, policy: GuardPolicy): boolean {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return false
  }

  // A file: URL with a host is a network share on Windows
  if (url.protocol === 'file:') {
    if (url.host !== '') return false
    return request.fromMain || insideRoot(url, policy.rendererRoot)
  }

  if (url.protocol === 'dolly-media:') return true

  if (request.fromMain) return request.method === 'POST' && url.href === new URL(policy.validateEndpoint).href

  if (url.protocol === 'data:' || url.protocol === 'blob:') return true
  if (url.protocol === 'devtools:') return policy.allowDevtools
  return policy.devOrigin !== null && fromDevServer(url, policy.devOrigin)
}

export function allowExternalUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const bare = `${url.origin}${url.pathname}`.replace(/\/$/, '')
  return bare === WHOP_URL || bare === REPO_URL || bare.startsWith(`${REPO_URL}/`)
}

export async function openExternal(url: string): Promise<boolean> {
  if (!allowExternalUrl(url)) return false
  await shell.openExternal(url)
  return true
}

function localDevOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? url.origin : null
  } catch {
    return null
  }
}

function currentPolicy(): GuardPolicy {
  const dev = !app.isPackaged
  return {
    validateEndpoint: VALIDATE_ENDPOINT,
    rendererRoot: `${pathToFileURL(join(__dirname, '../renderer')).href}/`,
    devOrigin: dev ? localDevOrigin(process.env.ELECTRON_RENDERER_URL) : null,
    allowDevtools: dev
  }
}

function guardSession(target: Session, policy: GuardPolicy): void {
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const { mediaTypes } = details as MediaAccessPermissionRequest
    callback(allowPermission({ contents, permission, mediaTypes, mainFrame: details.isMainFrame }))
  })
  target.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const mediaTypes = details.mediaType ? [details.mediaType] : undefined
    return allowPermission({ contents, permission, mediaTypes, mainFrame: details.isMainFrame })
  })
  target.setSpellCheckerEnabled(false)
  target.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/') // Windows only, and a dead address
  target.webRequest.onBeforeRequest((details, callback) => {
    const { url, method, webContentsId } = details
    callback({ cancel: !allowRequest({ url, method, fromMain: webContentsId === undefined }, policy) })
  })
}

// Switches only count before the app is ready, so they run when main imports this file
// host-resolver-rules isn't among them. Mapping every host to nothing also fails a proxy named by host, which breaks
// activation behind one, and the proxy can't be excluded: session.resolveProxy needs a ready app, by which time the
// rules are fixed. webRequest below is the control
for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'no-pings']) {
  app.commandLine.appendSwitch(flag)
}

// Chromium opens its debugging server after this file runs, so a packaged build never gets one.
// tests/capture-record.mjs and the other real-app checks rely on it in dev
if (app.isPackaged) {
  for (const flag of ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins']) {
    app.commandLine.removeSwitch(flag)
  }
}

export function installNetworkGuard(): void {
  const policy = currentPolicy()
  guardSession(session.defaultSession, policy)
  // Node's own fetch never passes through a session, so webRequest would not see it
  globalThis.fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init)
  app.on('session-created', (created) => guardSession(created, policy))
  app.on('web-contents-created', (_, contents) => {
    guardContents(contents)
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp') // webRequest never sees WebRTC's UDP traffic
  })
}
