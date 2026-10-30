// Debounced saving. Saves run one at a time and the newest value always wins, so an old write can't
// land after a new one. pause() holds writes while main owns the file, such as during captions.

export interface Autosave<T> {
  schedule(value: T): void
  flush(): Promise<void>
  pause(): void
  resume(): void
  dispose(): void
}

export type SaveStatus = 'saved' | 'saving' | 'failed'

export function createAutosave<T>(
  save: (value: T) => Promise<void>,
  delayMs: number,
  onStatus: (status: SaveStatus) => void = () => {}
): Autosave<T> {
  let pending: { value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let paused = false

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const run = (): Promise<void> => {
    clearTimer()
    if (running) return running
    if (!pending || paused) return Promise.resolve()
    const { value } = pending
    pending = null
    onStatus('saving')
    running = save(value)
      .then(
        () => onStatus('saved'),
        () => onStatus('failed')
      )
      .then(() => {
        running = null
        if (pending) return run()
      })
    return running
  }

  return {
    schedule(value) {
      pending = { value }
      clearTimer()
      if (!paused) timer = setTimeout(run, delayMs)
    },
    async flush() {
      while (running || (pending && !paused)) await run()
    },
    pause() {
      paused = true
      clearTimer()
    },
    resume() {
      paused = false
      if (pending) timer = setTimeout(run, delayMs)
    },
    dispose() {
      clearTimer()
      pending = null
    }
  }
}
