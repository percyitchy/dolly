// A file dropped on the window would otherwise ask Chromium to open it in place of the app.

export function blockFileDrops(target: Pick<Window, 'addEventListener'>): void {
  for (const type of ['dragover', 'drop'] as const) target.addEventListener(type, (event) => event.preventDefault())
}
