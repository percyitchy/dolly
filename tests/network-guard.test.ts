// A8: the guard blocks everything but local app content and one POST to the license endpoint.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  switches: [] as string[],
  values: new Map<string, string | undefined>(),
  removed: [] as string[],
  listeners: new Map<string, (...args: never[]) => void>(),
  openExternal: vi.fn(async () => {}),
  netFetch: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    commandLine: {
      appendSwitch: (flag: string, value?: string) => {
        h.switches.push(flag)
        h.values.set(flag, value)
      },
      removeSwitch: (flag: string) => h.removed.push(flag)
    },
    on: (event: string, listener: (...args: never[]) => void) => h.listeners.set(event, listener)
  },
  net: { fetch: h.netFetch },
  session: { defaultSession: null as unknown },
  shell: { openExternal: h.openExternal }
}))

import { app, session } from 'electron'
import { allowExternalUrl, allowRequest, installNetworkGuard, openExternal, type GuardPolicy } from '../src/main/network-guard'
import { REPO_URL, WHOP_URL } from '../src/shared/config'

const ENDPOINT = 'https://dolly-license.vercel.app/api/validate'
const ROOT = 'file:///Applications/Dolly.app/Contents/Resources/app.asar/out/renderer/'

const packaged: GuardPolicy = { validateEndpoint: ENDPOINT, rendererRoot: ROOT, devOrigin: null, allowDevtools: false }
const dev: GuardPolicy = { ...packaged, devOrigin: 'http://localhost:5173', allowDevtools: true }

const fromPage = (url: string, method = 'GET') => ({ url, method, fromMain: false })
const fromMain = (url: string, method = 'POST') => ({ url, method, fromMain: true })

describe('pages may load', () => {
  it.each([
    `${ROOT}index.html`,
    `${ROOT}assets/index-abc.js`,
    `${ROOT}recorder.html?x=1#y`,
    'dolly-media://media/clip.mp4',
    'data:image/png;base64,AAAA',
    'blob:file:///6f1c1f7e-3e5e-4ac1-9b1a-1d1f1d1f1d1f'
  ])('%s', (url) => {
    expect(allowRequest(fromPage(url), packaged)).toBe(true)
  })

  it('app content under a path with spaces', () => {
    const rendererRoot = 'file:///Users/a%20b/Dolly/out/renderer/'
    expect(allowRequest(fromPage(`${rendererRoot}index.html`), { ...packaged, rendererRoot })).toBe(true)
  })

  it('app content on Windows, whatever the drive letter case', () => {
    const rendererRoot = 'file:///C:/Program%20Files/Dolly/resources/app.asar/out/renderer/'
    const url = 'file:///c:/program%20files/dolly/resources/app.asar/out/renderer/index.html'
    expect(allowRequest(fromPage(url), { ...packaged, rendererRoot })).toBe(true)
  })
})

describe('install paths with characters URLs treat oddly', () => {
  // What Chromium sends for a file under the path: it leaves [ ] ~ alone and keeps a literal % escaped
  const asChromium = (path: string) => `file://${path.replaceAll('%', '%25').replaceAll(' ', '%20')}`
  const fileUrl = (path: string) => pathToFileURL(path, { windows: false }).href
  const policyFor = (path: string) => ({ ...packaged, rendererRoot: `${fileUrl(path)}/` })

  it.each(['/Applications/[beta] Dolly/out/renderer', '/Users/a~b/Dolly/out/renderer', '/Users/100%/Dolly/out/renderer', '/Users/a[1]~2%20b/out/renderer'])(
    'allows app content under %s',
    (path) => {
      const policy = policyFor(path)
      expect(allowRequest(fromPage(`${asChromium(path)}/index.html`), policy)).toBe(true)
      expect(allowRequest(fromPage(`${fileUrl(path)}/assets/a.js`), policy)).toBe(true)
    }
  )

  it('allows a % left unescaped, which a plain file URL can carry', () => {
    const path = '/Users/100%/Dolly/out/renderer'
    expect(allowRequest(fromPage(`file://${path}/index.html`), policyFor(path))).toBe(true)
    expect(allowRequest(fromPage(`file://${path}/../main/index.js`), policyFor(path))).toBe(false)
  })

  it.each(['/Applications/[beta] Dolly/out/renderer', '/Users/a~b/Dolly/out/renderer', '/Users/100%/Dolly/out/renderer'])('still keeps %s to its root', (path) => {
    const policy = policyFor(path)
    expect(allowRequest(fromPage(`${asChromium(path)}/../main/index.js`), policy)).toBe(false)
    expect(allowRequest(fromPage(`${asChromium(path)}-evil/x.js`), policy)).toBe(false)
    expect(allowRequest(fromPage(`${asChromium(path)}/..%2fmain/x.js`), policy)).toBe(false)
    expect(allowRequest(fromPage('file:///etc/passwd'), policy)).toBe(false)
    expect(allowRequest(fromPage(asChromium(path)), policy)).toBe(false)
  })

  it('handles the same characters on Windows, without case', () => {
    const rendererRoot = 'file:///C:/Users/a%5B1%5D~b/Dolly/resources/app.asar/out/renderer/'
    const policy = { ...packaged, rendererRoot }
    expect(allowRequest(fromPage('file:///c:/users/A[1]~B/dolly/resources/app.asar/out/renderer/index.html'), policy)).toBe(true)
    expect(allowRequest(fromPage('file:///C:/Users/a[1]~b/Dolly/resources/app.asar/out/main/index.js'), policy)).toBe(false)
    expect(allowRequest(fromPage('file:///etc/passwd'), policy)).toBe(false)
  })
})

describe('the main process may reach', () => {
  it('the validate endpoint, by POST only', () => {
    expect(allowRequest(fromMain(ENDPOINT), packaged)).toBe(true)
    expect(allowRequest(fromMain(ENDPOINT, 'GET'), packaged)).toBe(false)
    expect(allowRequest(fromMain(ENDPOINT, 'PUT'), packaged)).toBe(false)
  })

  it('local files and media, which never touch the network', () => {
    expect(allowRequest(fromMain('file:///Users/a/Movies/Dolly/x.dolly/screen.mp4', 'GET'), packaged)).toBe(true)
    expect(allowRequest(fromMain('dolly-media://media/clip.mp4', 'GET'), packaged)).toBe(true)
  })

  it.each([
    'https://dolly-license.vercel.app/api/validate?x=1',
    'https://dolly-license.vercel.app/api/validate/',
    'https://dolly-license.vercel.app/api/other',
    'https://dolly-license.vercel.app/',
    'http://dolly-license.vercel.app/api/validate',
    'https://dolly-license.vercel.app:8443/api/validate',
    'https://evil.dolly-license.vercel.app/api/validate',
    'https://dolly-license.vercel.app.evil.com/api/validate',
    'https://evil.com/api/validate',
    'https://api.whop.com/api/v1/memberships/x',
    'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic',
    'https://clients2.google.com/cr/report',
    'https://update.electronjs.org/x',
    'ws://dolly-license.vercel.app/api/validate',
    'data:text/plain,hello',
    'file://fileserver/share/secret.txt'
  ])('nothing else: %s', (url) => {
    expect(allowRequest(fromMain(url), packaged)).toBe(false)
  })
})

describe('a page may not reach', () => {
  it.each([
    'https://example.com/',
    'http://example.com/',
    'https://example.com/track.gif',
    'wss://example.com/socket',
    'ws://example.com/socket',
    'ftp://example.com/x',
    'https://fonts.googleapis.com/css2?family=Geist',
    'https://whop.com/getdolly/dolly-lifetime-sub',
    'https://api.whop.com/api/v1/memberships/x',
    ENDPOINT,
    'http://localhost:5173/',
    'http://127.0.0.1:3000/',
    'http://[::1]:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'file:///Applications/Dolly.app/Contents/Resources/app.asar/out/renderer/../main/index.js',
    'file:///Applications/Dolly.app/Contents/Resources/app.asar/out/renderer/%2e%2e/main/index.js',
    'file:///Applications/Dolly.app/Contents/Resources/app.asar/out/renderer/..%2fmain/index.js',
    'file:///Applications/Dolly.app/Contents/Resources/app.asar/out/renderer-evil/x.js',
    'file://fileserver/share/x.js',
    'devtools://devtools/bundled/inspector.html',
    'chrome-extension://abc/x.js',
    'not a url',
    ''
  ])('%s', (url) => {
    expect(allowRequest(fromPage(url), packaged)).toBe(false)
  })

  it('the endpoint by POST either: only main talks to it', () => {
    expect(allowRequest(fromPage(ENDPOINT, 'POST'), packaged)).toBe(false)
  })
})

describe('in dev', () => {
  it('allows the dev server, its socket and devtools', () => {
    expect(allowRequest(fromPage('http://localhost:5173/src/index.tsx'), dev)).toBe(true)
    expect(allowRequest(fromPage('ws://localhost:5173/'), dev)).toBe(true)
    expect(allowRequest(fromPage('devtools://devtools/bundled/inspector.html'), dev)).toBe(true)
  })

  it.each(['http://localhost:3000/', 'http://example.com/', 'ws://example.com/', 'https://localhost:5173/', 'https://chrome-devtools-frontend.appspot.com/x'])(
    'still blocks %s',
    (url) => {
      expect(allowRequest(fromPage(url), dev)).toBe(false)
    }
  )

  it('never lets main reach the dev server', () => {
    expect(allowRequest(fromMain('http://localhost:5173/', 'GET'), dev)).toBe(false)
  })
})

describe('external links', () => {
  it.each([WHOP_URL, `${WHOP_URL}/`, `${WHOP_URL}?ref=app`, REPO_URL, `${REPO_URL}/`, `${REPO_URL}/releases`, `${REPO_URL}#readme`])('opens %s', (url) => {
    expect(allowExternalUrl(url)).toBe(true)
  })

  it.each([
    'https://whop.com/',
    'https://whop.com/getdolly/other',
    `${WHOP_URL}-evil`,
    WHOP_URL.replace('https:', 'http:'),
    WHOP_URL.replace('whop.com', 'whop.com.evil.com'),
    WHOP_URL.replace('https://', 'https://user:pw@'),
    `${REPO_URL}-evil`,
    'https://github.com/',
    'https://evil.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'smb://server/share',
    'mailto:a@b.c',
    'not a url'
  ])('refuses %s', (url) => {
    expect(allowExternalUrl(url)).toBe(false)
  })

  it('never hands a refused URL to the OS', async () => {
    h.openExternal.mockClear()
    expect(await openExternal('https://evil.com/')).toBe(false)
    expect(h.openExternal).not.toHaveBeenCalled()
    expect(await openExternal(WHOP_URL)).toBe(true)
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(WHOP_URL)
  })
})

describe('installNetworkGuard', () => {
  type Listener = (details: Record<string, unknown>, callback: (response: { cancel: boolean }) => void) => void
  let listener: Listener
  const spellcheck = vi.fn()
  const requestHandler = vi.fn()
  const checkHandler = vi.fn()

  function cancels(details: Record<string, unknown>): boolean {
    let cancel: boolean | undefined
    listener(details, (response) => (cancel = response.cancel))
    return cancel as boolean
  }

  function fakeSession() {
    return {
      setPermissionRequestHandler: requestHandler,
      setPermissionCheckHandler: checkHandler,
      setSpellCheckerEnabled: spellcheck,
      setSpellCheckerDictionaryDownloadURL: vi.fn(),
      webRequest: { onBeforeRequest: (handler: Listener) => (listener = handler) }
    }
  }

  const nodeFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = nodeFetch
  })

  beforeEach(() => {
    spellcheck.mockClear()
    h.listeners.clear()
    Object.assign(session, { defaultSession: fakeSession() })
    installNetworkGuard()
  })

  it('cancels a page request to another host', () => {
    expect(cancels({ url: 'https://example.com/', method: 'GET', webContentsId: 1 })).toBe(true)
  })

  it('treats a request with no web contents as main', () => {
    expect(cancels({ url: 'https://example.com/', method: 'POST' })).toBe(true)
  })

  it('sends Node fetch through the guarded session', () => {
    h.netFetch.mockClear()
    void globalThis.fetch(new URL('https://example.com/a'))
    void globalThis.fetch('https://example.com/b', { method: 'POST' })
    expect(h.netFetch.mock.calls).toEqual([
      ['https://example.com/a', undefined],
      ['https://example.com/b', { method: 'POST' }]
    ])
  })

  it('turns spellcheck off', () => {
    expect(spellcheck).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('guards sessions created later, and WebRTC in every page', () => {
    const later = fakeSession()
    ;(h.listeners.get('session-created') as unknown as (s: unknown) => void)(later)
    expect(spellcheck).toHaveBeenCalledTimes(2)
    const contents = { setWebRTCIPHandlingPolicy: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() }
    ;(h.listeners.get('web-contents-created') as unknown as (e: unknown, c: unknown) => void)({}, contents)
    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
  })

  it('puts every page under the window rules', () => {
    const contents = { setWebRTCIPHandlingPolicy: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() }
    ;(h.listeners.get('web-contents-created') as unknown as (e: unknown, c: unknown) => void)({}, contents)
    expect(contents.setWindowOpenHandler).toHaveBeenCalled()
    expect(contents.on.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining(['will-navigate', 'will-attach-webview']))
  })

  it('refuses permissions by default in every session, both ways in', () => {
    requestHandler.mockClear()
    checkHandler.mockClear()
    const later = fakeSession()
    ;(h.listeners.get('session-created') as unknown as (s: unknown) => void)(later)
    const page = {}

    const answer = vi.fn()
    requestHandler.mock.calls[0][0](page, 'notifications', answer, { isMainFrame: true })
    requestHandler.mock.calls[0][0](page, 'media', answer, { isMainFrame: true, mediaTypes: ['audio'] })
    expect(answer.mock.calls).toEqual([[false], [false]])

    expect(checkHandler.mock.calls[0][0](page, 'media', 'file:///', { isMainFrame: true, mediaType: 'audio' })).toBe(false)
    expect(checkHandler.mock.calls[0][0](null, 'geolocation', 'file:///', { isMainFrame: true })).toBe(false)
  })

  it('never allows the dev server in a packaged build, even with the env set', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    expect(app.isPackaged).toBe(true)
    installNetworkGuard()
    expect(cancels({ url: 'http://localhost:5173/', method: 'GET', webContentsId: 1 })).toBe(true)
    vi.unstubAllEnvs()
  })

  it('sets the background-network switches at import, before the app is ready', () => {
    expect(h.switches).toEqual(expect.arrayContaining(['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'no-pings']))
  })
})

describe('switches set at import', () => {
  it('leaves host lookups alone, so a proxy named by host keeps working', () => {
    expect(h.switches).not.toContain('host-resolver-rules')
  })

  it('strips the debugging switches from a packaged build', () => {
    expect(h.removed).toEqual(expect.arrayContaining(['remote-debugging-port', 'remote-debugging-pipe']))
  })
})

describe('nothing in the app goes around the guard', () => {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url))

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.tsx?$/.test(name) ? [path] : []
    })
  }

  const code = (path: string) => readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  const matching = (pattern: RegExp) => sources(srcRoot).filter((path) => pattern.test(code(path)))

  it('uses no Node networking module, which webRequest cannot see', () => {
    expect(matching(/from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram)['"]/)).toEqual([])
  })

  it('never starts crashReporter or an auto-updater', () => {
    expect(matching(/\b(?:crashReporter|autoUpdater)\b|electron-updater/)).toEqual([])
  })

  it('calls fetch from main only through net.fetch, in license.ts', () => {
    const mainFiles = sources(join(srcRoot, 'main')).filter((path) => /(?<![\w.])fetch\(/.test(code(path)))
    expect(mainFiles).toEqual([])
    const usesNet = sources(join(srcRoot, 'main')).filter((path) => /\bnet\.(?:fetch|request)\(/.test(code(path)))
    expect(usesNet.map((path) => basename(path)).sort()).toEqual(['license.ts', 'network-guard.ts'])
  })

  it('reads the dev server variable only through a packaged check', () => {
    const readers = sources(join(srcRoot, 'main')).filter((path) => code(path).includes('ELECTRON_RENDERER_URL'))
    expect(readers.map((path) => basename(path)).sort()).toEqual(['network-guard.ts', 'paths.ts'])
  })

  it('has no remote URL in the renderer', () => {
    const urls = sources(join(srcRoot, 'renderer')).flatMap((path) =>
      [...code(path).matchAll(/\b(?:https?|wss?):\/\/[^\s'"`)]+/g)].map((match) => match[0])
    )
    expect(urls.filter((url) => !url.startsWith('http://www.w3.org/'))).toEqual([])
  })
})
