import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ['uiohook-napi', 'ffmpeg-static'] } }
  },
  preload: {
    build: {
      // A sandboxed preload can't require a sibling file, so a chunk shared between entries would break them
      isolatedEntries: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          recorder: resolve(__dirname, 'src/preload/recorder.ts'),
          export: resolve(__dirname, 'src/preload/export.ts'),
          stopbar: resolve(__dirname, 'src/preload/stopbar.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          recorder: resolve(__dirname, 'src/renderer/recorder.html'),
          export: resolve(__dirname, 'src/renderer/export.html'),
          stopbar: resolve(__dirname, 'src/renderer/stopbar.html')
        }
      }
    }
  }
})
