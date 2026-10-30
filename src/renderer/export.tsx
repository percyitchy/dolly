// Hidden window that draws export frames. Preload hands it a MessagePort, nothing else reaches it.

import { EXPORT_PORT_MESSAGE } from '../shared/ipc'
import { attachExportPort } from './export/session'

window.addEventListener('message', (event) => {
  if (event.source === window && event.data === EXPORT_PORT_MESSAGE && event.ports[0]) attachExportPort(event.ports[0])
})
