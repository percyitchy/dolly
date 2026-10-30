import { app, BrowserWindow, Menu } from 'electron'
import type { MainContext } from './context'
import { installNetworkGuard } from './network-guard'
import { isRecording, register as registerCapture } from './capture'
import { register as registerProjects, registerMediaScheme, serveMedia } from './projects'
import { register as registerExport } from './export'
import { register as registerCaptions, sweepTemp } from './captions'
import { register as registerLicense } from './license'
import { pageUrl } from './paths'
import { appMenuTemplate, focusExisting, secureWebPreferences } from './window-guard'

registerMediaScheme()

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 700,
    backgroundColor: '#0E1014',
    // Windows keeps its own frame, because hiddenInset would leave it with no window controls
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { autoHideMenuBar: true }),
    webPreferences: secureWebPreferences('index')
  })
  win.on('closed', () => (win = null))
  void win.loadURL(pageUrl('index.html'))
}

const ctx: MainContext = {
  mainWindow: () => win,
  send: (channel, event) => win?.webContents.send(channel, event)
}

function start(): void {
  app.on('second-instance', () => focusExisting(win, isRecording(), createWindow))

  app.whenReady().then(() => {
    installNetworkGuard()
    if (app.isPackaged) {
      const template = appMenuTemplate(process.platform)
      Menu.setApplicationMenu(template && Menu.buildFromTemplate(template))
    }
    void sweepTemp()
    serveMedia()
    registerCapture(ctx)
    registerProjects(ctx)
    registerExport(ctx)
    registerCaptions(ctx)
    registerLicense(ctx)
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (app.requestSingleInstanceLock()) start()
else app.quit()
