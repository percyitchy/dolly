import { describe, expect, it } from 'vitest'
import {
  effectiveOutput,
  estimateBytes,
  exportNote,
  filesLabel,
  formatSize,
  leftOutLine,
  shortPath
} from '../src/renderer/editor/export-model'
import { smoothnessToSpring, springToSmoothness } from '../src/renderer/editor/cursor-model'
import { clipIsLive, clipSeconds, needsResync, nudgedRate, peaksOf, peaksToPath, projectMs } from '../src/renderer/editor/media-sync'
import { canRecord, clicksWanted, missingPermissions, permissionRows, type Permissions } from '../src/renderer/home/permissions-model'
import { errorText } from '../src/renderer/home/error-text'
import { CURSOR_DEFAULTS, type Clip, type OutputSettings } from '../src/shared/project'

const output = (extra: Partial<OutputSettings> = {}): OutputSettings => ({
  shapes: ['16:9', '1:1'],
  format: 'mp4',
  resolution: '1080p',
  fps: 30,
  folder: '/Users/me/Movies/Dolly',
  ...extra
})

describe('export strip', () => {
  it('reduces Pro settings to what Free exports, without losing the Free ones', () => {
    const pro = output({ shapes: ['16:9', '9:16'], format: 'gif', resolution: '4k', fps: 60 })
    expect(effectiveOutput('free', pro)).toEqual(output({ shapes: ['16:9'] }))
    expect(effectiveOutput('pro', pro)).toEqual(pro)
  })

  it('estimates the concept example close to 40 MB', () => {
    const bytes = estimateBytes(output(), 20000)
    expect(bytes).toBeGreaterThan(25e6)
    expect(bytes).toBeLessThan(45e6)
  })

  it('scales the estimate with shapes, frame rate and size', () => {
    const base = estimateBytes(output({ shapes: ['16:9'] }), 20000)
    expect(estimateBytes(output({ shapes: ['16:9', '1:1'] }), 20000)).toBeGreaterThan(base)
    expect(estimateBytes(output({ shapes: ['16:9'], fps: 60 }), 20000)).toBeGreaterThan(base)
    expect(estimateBytes(output({ shapes: ['16:9'], resolution: '4k' }), 20000)).toBeGreaterThan(base)
  })

  it('treats GIF as 720 px whatever the resolution', () => {
    const a = estimateBytes(output({ format: 'gif', resolution: '1080p' }), 20000)
    const b = estimateBytes(output({ format: 'gif', resolution: '4k' }), 20000)
    expect(a).toBeCloseTo(b)
  })

  it('writes the note', () => {
    expect(exportNote(output({ shapes: [] }), 20000)).toBe('Tick a shape to export')
    expect(exportNote(output(), 20000)).toMatch(/^2 files · about \d+ MB$/)
    expect(filesLabel(1)).toBe('1 file')
    expect(formatSize(500)).toBe('under 1 MB')
    expect(formatSize(2.5e9)).toBe('about 2.5 GB')
  })

  it('names what is left out in one line', () => {
    expect(leftOutLine([])).toBeNull()
    expect(leftOutLine(['webcam'])).toBe('The webcam bubble is left out of this export.')
    expect(leftOutLine(['captions'])).toBe('Captions are left out of this export.')
    expect(leftOutLine(['customBackground'])).toBe('Your own backgrounds are left out of this export.')
    expect(leftOutLine(['webcam', 'captions'])).toBe('The webcam bubble and captions are left out of this export.')
    expect(leftOutLine(['webcam', 'captions', 'customBackground'])).toBe(
      'The webcam bubble, captions and your own backgrounds are left out of this export.'
    )
  })

  it('shortens home folders', () => {
    expect(shortPath('/Users/me/Movies/Dolly')).toBe('~/Movies/Dolly')
    expect(shortPath('C:\\Users\\me\\Videos\\Dolly')).toBe('~\\Videos\\Dolly')
    expect(shortPath('/Volumes/Work')).toBe('/Volumes/Work')
  })
})

describe('smoothness slider', () => {
  it('gives the spec default at the middle', () => {
    const { stiffness, damping } = smoothnessToSpring(0.5)
    expect(stiffness).toBeCloseTo(CURSOR_DEFAULTS.stiffness)
    expect(damping).toBeCloseTo(CURSOR_DEFAULTS.damping)
  })

  it('loosens as it goes right', () => {
    expect(smoothnessToSpring(1).stiffness).toBeLessThan(smoothnessToSpring(0).stiffness)
  })

  it('keeps the same damping ratio at both ends', () => {
    const ratio = ({ stiffness, damping }: { stiffness: number; damping: number }) => damping / Math.sqrt(stiffness)
    expect(ratio(smoothnessToSpring(0))).toBeCloseTo(ratio(smoothnessToSpring(1)))
  })

  it('round-trips', () => {
    for (const s of [0, 0.2, 0.5, 0.8, 1]) expect(springToSmoothness(smoothnessToSpring(s).stiffness)).toBeCloseTo(s)
  })
})

describe('clip clock', () => {
  const clip: Clip = { id: 'm', kind: 'mic', file: 'mic.webm', startMs: 500, durationMs: 2000 }

  it('maps project time to clip time and back', () => {
    expect(clipSeconds(clip, 1500)).toBe(1)
    expect(clipSeconds(clip, 0)).toBe(0)
    expect(projectMs(clip, 1, 20000)).toBe(1500)
    expect(projectMs(clip, 99, 20000)).toBe(20000)
  })

  it('knows when a clip is playing', () => {
    expect(clipIsLive(clip, 499)).toBe(false)
    expect(clipIsLive(clip, 500)).toBe(true)
    expect(clipIsLive(clip, 2500)).toBe(false)
  })

  it('eases small drift away in the right direction', () => {
    expect(nudgedRate(0.005)).toBe(1)
    expect(nudgedRate(0.05)).toBeLessThan(1) // Ahead, so slow down
    expect(nudgedRate(-0.05)).toBeGreaterThan(1)
  })

  it('resyncs only past the drift limit', () => {
    expect(needsResync(1, 1.05)).toBe(false)
    expect(needsResync(1, 1.2)).toBe(true)
  })
})

describe('waveform', () => {
  it('reduces samples to peaks', () => {
    const samples = new Float32Array(3200)
    samples.fill(0.5, 0, 1600)
    expect(peaksOf(samples, 2)).toEqual([0.5, 0])
  })

  it('handles more buckets than samples', () => {
    expect(peaksOf([1, -1], 8)).toHaveLength(8)
  })

  it('draws a line per peak', () => {
    expect(peaksToPath([1, 0])).toBe('M0 0.0v48.0M1 23.5v1.0')
  })

  it('scales a quiet mic up to fill the lane, but leaves silence flat', () => {
    expect(peaksToPath([0.1, 0])).toBe('M0 0.0v48.0M1 23.5v1.0')
    expect(peaksToPath([0.0001])).toBe('M0 23.5v1.0')
  })
})

describe('error text', () => {
  it('strips the IPC wrapper', () => {
    const wrapped = new Error("Error invoking remote method 'captions:generate': Error: Captions are still running for another recording.")
    expect(errorText(wrapped, 'fallback')).toBe('Captions are still running for another recording.')
  })

  it('falls back when there is nothing to say', () => {
    expect(errorText('nope', 'fallback')).toBe('fallback')
    expect(errorText(new Error(''), 'fallback')).toBe('fallback')
  })
})

describe('permissions', () => {
  const none: Permissions = { screen: 'not-determined', 'input-monitoring': 'not-determined', microphone: 'not-determined', camera: 'not-determined' }
  const all: Permissions = { screen: 'granted', 'input-monitoring': 'granted', microphone: 'granted', camera: 'granted' }

  it('asks through Dolly first, then sends a denied one to settings', () => {
    const rows = permissionRows({ ...none, 'input-monitoring': 'denied' }, { mic: true, webcam: false, clicks: true }, true)
    expect(rows.find((r) => r.kind === 'screen')?.action).toBe('allow')
    expect(rows.find((r) => r.kind === 'input-monitoring')?.action).toBe('open-settings')
  })

  it('needs no action when granted', () => {
    expect(permissionRows(all, { mic: true, webcam: true, clicks: true }, true).every((r) => r.action === null)).toBe(true)
  })

  it('hides what Windows does not need', () => {
    const rows = permissionRows({ ...all, screen: 'not-needed', 'input-monitoring': 'not-needed' }, { mic: true, webcam: false, clicks: true }, true)
    expect(rows.map((r) => r.kind)).toEqual(['microphone', 'camera'])
  })

  it('leaves the camera out for Free', () => {
    expect(permissionRows(none, { mic: true, webcam: false, clicks: true }, false).map((r) => r.kind)).not.toContain('camera')
  })

  it('only blocks on the mic and camera when they are on', () => {
    expect(missingPermissions({ ...all, microphone: 'denied' }, { mic: true, webcam: false, clicks: true })).toEqual(['microphone'])
    expect(canRecord({ ...all, microphone: 'denied' }, { mic: false, webcam: false, clicks: true })).toBe(true)
    expect(canRecord({ ...all, camera: 'denied' }, { mic: true, webcam: false, clicks: true })).toBe(true)
    expect(canRecord({ ...all, camera: 'denied' }, { mic: true, webcam: true, clicks: true })).toBe(false)
  })

  it('always blocks on screen', () => {
    expect(canRecord({ ...all, screen: 'denied' }, { mic: false, webcam: false, clicks: false })).toBe(false)
  })

  it('says plainly that the mouse permission never sees the keyboard', () => {
    const copy = permissionRows(none, { mic: true, webcam: false, clicks: true }, true).find((r) => r.kind === 'input-monitoring')
    expect(copy?.title).toBe('Input Monitoring')
    expect(copy?.why).toMatch(/only asks for mouse events/)
    expect(copy?.why).toMatch(/never sees what you type/)
  })

  it('blocks on input monitoring until the user chooses to go without zooms', () => {
    expect(canRecord({ ...all, 'input-monitoring': 'not-determined' }, { mic: false, webcam: false, clicks: true })).toBe(false)
    expect(canRecord({ ...all, 'input-monitoring': 'denied' }, { mic: false, webcam: false, clicks: false })).toBe(true)
  })

  it('lets go of skipping clicks once the permission is there', () => {
    expect(clicksWanted(true, null)).toBe(true)
    expect(clicksWanted(false, null)).toBe(false)
    expect(clicksWanted(false, { ...all, 'input-monitoring': 'denied' })).toBe(false)
    expect(clicksWanted(false, { ...all, 'input-monitoring': 'granted' })).toBe(true)
  })
})
