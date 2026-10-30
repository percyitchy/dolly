// The hidden export window's whole bridge: one MessagePort from main, handed to the page. It exposes no methods.

import { ipcRenderer } from 'electron'
import { CHANNELS, EXPORT_PORT_MESSAGE } from '../shared/ipc'

ipcRenderer.on(CHANNELS.exportPort, (event) => window.postMessage(EXPORT_PORT_MESSAGE, '*', [...event.ports]))
