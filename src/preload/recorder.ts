// The hidden recorder window's whole bridge: commands from main, and reports and media chunks back.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type RecorderApi, type RecorderCommand } from '../shared/ipc'

const api: RecorderApi = {
  onCommand: (listener) => {
    const wrapped = (_: IpcRendererEvent, command: RecorderCommand) => listener(command)
    ipcRenderer.on(CHANNELS.recorderCommand, wrapped)
    return () => ipcRenderer.removeListener(CHANNELS.recorderCommand, wrapped)
  },
  report: (event) => ipcRenderer.send(CHANNELS.recorderReport, event),
  chunk: (kind, data) => ipcRenderer.send(CHANNELS.recorderChunk, kind, data)
}

contextBridge.exposeInMainWorld('dollyRecorder', api)
