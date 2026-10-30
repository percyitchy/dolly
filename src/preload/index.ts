// The only bridge between the main window and the system. Exposes named methods, never ipcRenderer itself.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type CaptionEvent, type CaptureEvent, type DollyApi, type ExportEvent } from '../shared/ipc'

function subscribe<T>(channel: string, listener: (event: T) => void): () => void {
  const wrapped = (_: IpcRendererEvent, event: T) => listener(event)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: DollyApi = {
  capture: {
    displays: () => ipcRenderer.invoke('capture:displays'),
    permissions: () => ipcRenderer.invoke('capture:permissions'),
    openPermissionSettings: (kind) => ipcRenderer.invoke('capture:openPermissionSettings', kind),
    requestPermission: (kind) => ipcRenderer.invoke('capture:requestPermission', kind),
    start: (options) => ipcRenderer.invoke('capture:start', options),
    stop: () => ipcRenderer.invoke('capture:stop'),
    onEvent: (listener) => subscribe<CaptureEvent>(CHANNELS.captureEvent, listener)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    open: (dir) => ipcRenderer.invoke('projects:open', dir),
    save: (dir, project) => ipcRenderer.invoke('projects:save', dir, project),
    mediaUrl: (dir, file) => ipcRenderer.invoke('projects:mediaUrl', dir, file),
    pickBackgroundImage: (dir) => ipcRenderer.invoke('projects:pickBackgroundImage', dir)
  },
  export: {
    start: (request) => ipcRenderer.invoke('export:start', request),
    cancel: () => ipcRenderer.invoke('export:cancel'),
    pickFolder: () => ipcRenderer.invoke('export:pickFolder'),
    reveal: (path) => ipcRenderer.invoke('export:reveal', path),
    onEvent: (listener) => subscribe<ExportEvent>(CHANNELS.exportEvent, listener)
  },
  captions: {
    generate: (dir, language) => ipcRenderer.invoke('captions:generate', dir, language),
    onEvent: (listener) => subscribe<CaptionEvent>(CHANNELS.captionEvent, listener)
  },
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    activate: (key) => ipcRenderer.invoke('license:activate', key),
    deactivateLocal: () => ipcRenderer.invoke('license:deactivateLocal'),
    openStore: () => ipcRenderer.invoke('license:openStore')
  }
}

contextBridge.exposeInMainWorld('dolly', api)
