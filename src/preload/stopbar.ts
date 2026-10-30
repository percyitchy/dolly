// The stop bar's whole bridge: two messages to main and nothing else.

import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/ipc'

contextBridge.exposeInMainWorld('dollyStopBar', {
  hover: () => ipcRenderer.send(CHANNELS.stopBarHover),
  stop: () => ipcRenderer.send(CHANNELS.stopBarStop)
})
