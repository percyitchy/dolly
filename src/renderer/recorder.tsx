// Hidden window that records mic and webcam. Main drives it, and the bytes go back over IPC, because main
// chooses where files land. Owned by capture.

import type { RecorderCommand, RecorderKind } from '../shared/ipc'

const CHUNK_MS = 1000
const FORMATS: Record<RecorderKind, MediaRecorderOptions> = {
  mic: { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 },
  webcam: { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2500000 }
}

const api = window.dollyRecorder
const streams = new Map<RecorderKind, MediaStream>()
const recorders: MediaRecorder[] = []

function reportFailure(what: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  api.report({ type: 'failed', message: `${what}: ${reason}` })
}

async function prepare(mic: boolean, webcam: boolean): Promise<void> {
  try {
    if (mic) {
      const audio = { echoCancellation: false, noiseSuppression: true, autoGainControl: true }
      streams.set('mic', await navigator.mediaDevices.getUserMedia({ audio, video: false }))
    }
    if (webcam) {
      const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      streams.set('webcam', await navigator.mediaDevices.getUserMedia({ audio: false, video }))
    }
    api.report({ type: 'prepared' })
  } catch (error) {
    reportFailure("Couldn't open the microphone or camera", error)
  }
}

function startRecorder(kind: RecorderKind, stream: MediaStream): void {
  const recorder = new MediaRecorder(stream, FORMATS[kind])
  // Reading a Blob is async, so chain the reads or a short chunk could overtake a long one
  let sent: Promise<void> = Promise.resolve()

  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return
    const data = event.data
    sent = sent.then(async () => api.chunk(kind, await data.arrayBuffer()))
  }
  recorder.onstart = (event) => {
    const { width, height, frameRate } = stream.getVideoTracks()[0]?.getSettings() ?? {}
    api.report({ type: 'started', kind, at: event.timeStamp, width, height, fps: frameRate })
  }
  recorder.onstop = () => {
    const at = performance.now()
    sent.then(() => {
      stream.getTracks().forEach((track) => track.stop())
      api.report({ type: 'ended', kind, at })
    }, (error) => reportFailure(`The ${kind} recording failed`, error))
  }
  recorder.onerror = () => api.report({ type: 'failed', message: `The ${kind} recording failed` })

  recorders.push(recorder)
  recorder.start(CHUNK_MS)
}

function begin(): void {
  try {
    for (const [kind, stream] of streams) startRecorder(kind, stream)
  } catch (error) {
    reportFailure("Couldn't start recording", error)
  }
}

function end(): void {
  for (const recorder of recorders) {
    if (recorder.state !== 'inactive') recorder.stop()
  }
}

api.onCommand((command: RecorderCommand) => {
  if (command.type === 'prepare') void prepare(command.mic, command.webcam)
  else if (command.type === 'sync') api.report({ type: 'sync', id: command.id, now: performance.now() })
  else if (command.type === 'begin') begin()
  else if (command.type === 'end') end()
})

api.report({ type: 'loaded' })
