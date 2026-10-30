// Where bundled programs and user files live, in dev and in the packaged app.

import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'

const platformDir = `${process.platform}-${process.arch}`
const exe = process.platform === 'win32' ? '.exe' : ''

// Packaged binaries sit outside the asar archive
function unpacked(path: string): string {
  return path.replace('app.asar', 'app.asar.unpacked')
}

// macOS uses our own build from native/ffmpeg, because ffmpeg-static's can't be redistributed there. Packaged
// builds work the path out themselves, since ffmpeg-static would take any program named in FFMPEG_BIN
export function ffmpegPath(): string {
  if (app.isPackaged) {
    if (process.platform === 'darwin') return nativeBin('ffmpeg')
    return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', `ffmpeg${exe}`)
  }
  if (process.platform === 'darwin') {
    const built = nativeBin('ffmpeg')
    if (existsSync(built)) return built
  }
  return unpacked(ffmpegStatic as unknown as string)
}

// Every ffmpeg input goes through this, so a crafted media file such as a playlist can't point ffmpeg at a URL.
// pipe is for the frames Dolly feeds in itself
export function ffmpegInput(file: string): string[] {
  return ['-protocol_whitelist', 'file,pipe', '-i', file]
}

// The dev server, which a packaged build never uses whatever the environment says
export function devRendererUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
}

// What a window loads. loadFile doesn't encode the path, so a folder with a % in its name would load the wrong file
export function pageUrl(page: string): string {
  const devServer = devRendererUrl()
  return devServer ? `${devServer}/${page}` : pathToFileURL(join(__dirname, '../renderer', page)).href
}

// A helper from native/bin in dev, or resources/bin when packaged
export function nativeBin(name: string): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'native/bin', platformDir)
  return join(base, name + exe)
}

export function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'native/bin', platformDir)
  return join(base, ...parts)
}

export function defaultDollyFolder(): string {
  const media = process.platform === 'win32' ? 'Videos' : 'Movies'
  return join(homedir(), media, 'Dolly')
}

export function licenseFile(): string {
  return join(app.getPath('userData'), 'license.json')
}

export function dollyTemp(): string {
  return join(tmpdir(), 'dolly')
}
