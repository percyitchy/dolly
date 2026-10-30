// Builds the Electron test entry on its own. It goes to dist/, which is ignored by git, because out/ is
// what electron-builder packages and this must never ship.

import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const root = resolve(__dirname, '..')
const out = resolve(root, 'dist/export-test')

export default defineConfig({
  main: {
    build: {
      outDir: resolve(out, 'main'),
      rollupOptions: { input: { index: resolve(root, 'tests/export-main.ts') }, external: ['uiohook-napi', 'ffmpeg-static'] }
    }
  },
  preload: {
    build: {
      outDir: resolve(out, 'preload'),
      rollupOptions: {
        input: { export: resolve(root, 'src/preload/export.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    build: {
      outDir: resolve(out, 'renderer'),
      rollupOptions: { input: { export: resolve(root, 'src/renderer/export.html') } }
    }
  }
})
