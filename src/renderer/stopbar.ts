// The always-on-top bar shown while recording. Macs with a notch can hide the menu bar icon, so this is the visible Stop.

declare global {
  interface Window {
    dollyStopBar: { hover(): void; stop(): void }
  }
}

const started = Date.now()
const time = document.getElementById('time')!
const stop = document.getElementById('stop') as HTMLButtonElement

function tick(): void {
  const seconds = Math.floor((Date.now() - started) / 1000)
  time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

setInterval(tick, 500)
stop.addEventListener('pointerenter', () => window.dollyStopBar.hover())
stop.addEventListener('click', () => {
  stop.disabled = true
  window.dollyStopBar.stop()
})

export {}
