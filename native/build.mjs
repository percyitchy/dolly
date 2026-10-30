// Builds every native helper for this OS into native/bin. Each folder owns a build.mjs
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
for (const name of readdirSync(root)) {
  const script = join(root, name, 'build.mjs')
  if (!existsSync(script)) continue
  console.log(`Building ${name}`)
  const run = spawnSync(process.execPath, [script], { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
