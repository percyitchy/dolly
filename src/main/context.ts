// What every main-process module gets when it registers its IPC handlers.

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export interface MainContext {
  mainWindow(): BrowserWindow | null
  send(channel: string, event: unknown): void
}

export type Register = (ctx: MainContext) => void

export function fromMainWindow(ctx: MainContext, event: IpcMainInvokeEvent): void {
  if (event.sender !== ctx.mainWindow()?.webContents) throw new Error('Not allowed from this window')
}

// Every invoke channel goes through here. The hidden windows have their own one-way channels and sender checks
export function handleFromMain(ctx: MainContext, channel: string, handler: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    fromMainWindow(ctx, event)
    return handler(...(args as never[]))
  })
}
