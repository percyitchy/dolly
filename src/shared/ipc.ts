// The whole surface between renderer and main. preload/index.ts exposes DollyApi as window.dolly to the main
// window and main registers one handler per Channel. Each hidden window has a narrower preload of its own.

import type { CursorEvent, OutputSettings, Project, Shape } from './project'
import type { Plan } from './entitlements'

export interface DisplayInfo {
  id: string
  name: string
  width: number // Pixels
  height: number
  scaleFactor: number
  primary: boolean
}

export type PermissionKind = 'screen' | 'input-monitoring' | 'microphone' | 'camera'
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'not-needed'

export interface RecordingOptions {
  displayId: string
  mic: boolean
  webcam: boolean // Pro
  clicks: boolean // False records a cursor path and opens no event tap or hook
  name?: string
}

export type CaptureEvent =
  | { type: 'started'; projectDir: string; warnings?: string[] } // Warnings say what the recording will lack
  | { type: 'warning'; message: string } // Something changed mid-recording, and the recording carries on
  | { type: 'stopped'; projectId: string; warnings?: string[]; tapEvents?: number } // tapEvents: mouse events the macOS helper saw
  | { type: 'error'; message: string }

// The hidden recorder window. Main sends commands, the page reports back and streams media chunks.
// Times are the page's performance.now()
export type RecorderKind = 'mic' | 'webcam'

export type RecorderCommand =
  | { type: 'prepare'; mic: boolean; webcam: boolean }
  | { type: 'sync'; id: number }
  | { type: 'begin' }
  | { type: 'end' }

export type RecorderEvent =
  | { type: 'loaded' }
  | { type: 'prepared' }
  | { type: 'sync'; id: number; now: number }
  | { type: 'started'; kind: RecorderKind; at: number; width?: number; height?: number; fps?: number }
  | { type: 'ended'; kind: RecorderKind; at: number }
  | { type: 'failed'; message: string }

export interface ProjectSummary {
  id: string
  name: string
  dir: string
  createdAt: string
  durationMs: number
}

export interface OpenedProject {
  dir: string
  project: Project
  cursor: CursorEvent[]
}

export interface ExportRequest {
  projectDir: string
  output: OutputSettings
}

export type ExportEvent =
  | { type: 'progress'; shape: Shape; fileIndex: number; fileCount: number; pct: number }
  | { type: 'done'; files: string[] }
  | { type: 'failed'; message: string }
  | { type: 'cancelled' }

export type CaptionEvent =
  | { type: 'progress'; pct: number }
  | { type: 'done'; projectDir: string }
  | { type: 'failed'; message: string }

// Automatic detection can pick the wrong language on a quiet or distant mic, so the user can name it
export const CAPTION_LANGUAGES = [
  { code: 'auto', label: 'Detect automatically' },
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' }
] as const

export type CaptionLanguage = (typeof CAPTION_LANGUAGES)[number]['code']

export type LicenseFailure =
  | 'invalid_key'
  | 'inactive'
  | 'wrong_product'
  | 'device_limit'
  | 'network'
  | 'rate_limited' // The license server is turning requests away
  | 'device_id' // This computer's ID couldn't be read
  | 'save' // The answer was good but couldn't be written to disk

export interface LicenseStatus {
  plan: Plan
}

export type ActivateResult = { ok: true } | { ok: false; reason: LicenseFailure }

export interface DollyApi {
  capture: {
    displays(): Promise<DisplayInfo[]>
    permissions(): Promise<Record<PermissionKind, PermissionState>>
    openPermissionSettings(kind: PermissionKind): Promise<void>
    requestPermission(kind: PermissionKind): Promise<PermissionState>
    start(options: RecordingOptions): Promise<void>
    stop(): Promise<void>
    onEvent(listener: (event: CaptureEvent) => void): () => void
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    open(dir: string): Promise<OpenedProject>
    save(dir: string, project: Project): Promise<void>
    // A dolly-media:// URL that the renderer can load, for a file inside a project folder
    mediaUrl(dir: string, file: string): Promise<string>
    pickBackgroundImage(dir: string): Promise<string | null>
  }
  export: {
    start(request: ExportRequest): Promise<void>
    cancel(): Promise<void>
    pickFolder(): Promise<string | null>
    reveal(path: string): Promise<void>
    onEvent(listener: (event: ExportEvent) => void): () => void
  }
  captions: {
    generate(projectDir: string, language?: CaptionLanguage): Promise<void>
    onEvent(listener: (event: CaptionEvent) => void): () => void
  }
  license: {
    status(): Promise<LicenseStatus>
    activate(key: string): Promise<ActivateResult>
    deactivateLocal(): Promise<void>
    openStore(): Promise<void>
  }
}

// All the hidden recorder window gets, as window.dollyRecorder. Only its reports are acted on: main checks the sender
export interface RecorderApi {
  onCommand(listener: (command: RecorderCommand) => void): () => void
  report(event: RecorderEvent): void
  chunk(kind: RecorderKind, data: ArrayBuffer): void
}

// Channel names. invoke channels match the method path, event channels end in :event
export const CHANNELS = {
  captureEvent: 'capture:event',
  exportEvent: 'export:event',
  captionEvent: 'captions:event',
  exportPort: 'export:port', // Main to the hidden export window, carries one MessagePort
  recorderCommand: 'recorder:command',
  recorderReport: 'recorder:report',
  recorderChunk: 'recorder:chunk',
  stopBarHover: 'stopbar:hover',
  stopBarStop: 'stopbar:stop'
} as const

// Preload forwards that port to the page under this window message
export const EXPORT_PORT_MESSAGE = 'dolly-export-port'

declare global {
  interface Window {
    dolly: DollyApi
    dollyRecorder: RecorderApi
  }
}
