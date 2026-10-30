// Checks the editor in the real built app, against a real project on disk. Build first with
// `npx electron-vite build`. Run one at a time, they're heavy.
//
//   node tests/editor-real.mjs perf    playback cost on a Retina clip. `perf still` uses a still screen
//   node tests/editor-real.mjs rgb     preview pixels against compose(), and against an exported frame
//   node tests/editor-real.mjs ui      every interaction, with real input events, checked on disk
//
// Clips and screenshots stay in $DOLLY_EDITOR_DIR (default: <tmp>/dolly-editor-real).

import { mkdirSync } from 'node:fs'
import { WORK, log, perf } from './editor-real-kit.mjs'

mkdirSync(WORK, { recursive: true })
const command = process.argv[2]
if (command === 'perf') await perf(process.argv[3] === 'still')
else if (command === 'rgb') await (await import('./editor-real-rgb.mjs')).rgb()
else if (command === 'ui') await (await import('./editor-real-ui.mjs')).ui()
else log('Usage: node tests/editor-real.mjs perf|rgb|ui')
process.exit(0)
