import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADD_BLOCK_MS,
  MIN_BLOCK_MS,
  addZoom,
  blockLabel,
  canAddZoom,
  deleteBlock,
  formatTimecode,
  moveBlock,
  msFromX,
  rulerTicks,
  stretchEnd,
  stretchStart,
  updateBlock,
  zoomSummary
} from '../src/renderer/editor/timeline-model'
import { editorReducer, initialState, withZooms, type EditorState } from '../src/renderer/editor/editor-state'
import { createAutosave } from '../src/renderer/editor/autosave'
import { LOOK_DEFAULTS, CURSOR_DEFAULTS, type Project, type ZoomSegment } from '../src/shared/project'

const DURATION = 20000

function seg(id: string, startMs: number, endMs: number, extra: Partial<ZoomSegment> = {}): ZoomSegment {
  return {
    id,
    startMs,
    endMs,
    level: 2,
    easeInMs: 600,
    easeOutMs: 600,
    focus: { x: 0.5, y: 0.5 },
    clickMs: [],
    origin: 'auto',
    edited: false,
    ...extra
  }
}

function project(zooms: ZoomSegment[]): Project {
  return {
    version: 1,
    id: 'p',
    name: 'Launch demo',
    createdAt: '2026-10-30T00:00:00.000Z',
    durationMs: DURATION,
    clips: [],
    zooms,
    look: LOOK_DEFAULTS,
    cursor: CURSOR_DEFAULTS,
    webcam: null,
    captions: [],
    output: { shapes: ['16:9'], format: 'mp4', resolution: '1080p', fps: 30, folder: '' }
  }
}

const three = () => [seg('a', 1000, 4000), seg('b', 6000, 8000), seg('c', 12000, 15000)]
const byId = (zooms: ZoomSegment[], id: string) => zooms.find((z) => z.id === id)!

function assertValid(zooms: ZoomSegment[]) {
  for (let i = 0; i < zooms.length; i++) {
    expect(zooms[i].startMs).toBeGreaterThanOrEqual(0)
    expect(zooms[i].endMs).toBeLessThanOrEqual(DURATION)
    expect(zooms[i].endMs).toBeGreaterThan(zooms[i].startMs)
    if (i > 0) expect(zooms[i].startMs).toBeGreaterThanOrEqual(zooms[i - 1].endMs)
  }
}

describe('dragging a block', () => {
  it('moves it and keeps its length', () => {
    const z = byId(moveBlock(three(), 'b', 7000, DURATION), 'b')
    expect([z.startMs, z.endMs]).toEqual([7000, 9000])
  })

  it('marks it as edited', () => {
    expect(byId(moveBlock(three(), 'b', 7000, DURATION), 'b').edited).toBe(true)
    expect(byId(moveBlock(three(), 'b', 7000, DURATION), 'a').edited).toBe(false)
  })

  it('stops at the previous block', () => {
    const z = byId(moveBlock(three(), 'b', 0, DURATION), 'b')
    expect(z.startMs).toBe(4000)
    expect(z.endMs).toBe(6000)
  })

  it('stops at the next block', () => {
    const zooms = moveBlock(three(), 'b', 19000, DURATION)
    expect(byId(zooms, 'b').endMs).toBe(12000)
    assertValid(zooms)
  })

  it('never passes a neighbour, so order holds', () => {
    const zooms = moveBlock(three(), 'a', 13000, DURATION)
    expect(zooms.map((z) => z.id)).toEqual(['a', 'b', 'c'])
    expect(byId(zooms, 'a').endMs).toBe(6000)
  })

  it('clamps to the start of the recording', () => {
    const z = byId(moveBlock(three(), 'a', -5000, DURATION), 'a')
    expect([z.startMs, z.endMs]).toEqual([0, 3000])
  })

  it('clamps to the end of the recording', () => {
    const z = byId(moveBlock(three(), 'c', 99999, DURATION), 'c')
    expect([z.startMs, z.endMs]).toEqual([17000, 20000])
  })

  it('returns the same list when nothing moved, so a click edits nothing', () => {
    const zooms = three()
    expect(moveBlock(zooms, 'b', 6000, DURATION)).toBe(zooms)
  })
})

describe('stretching a block', () => {
  it('moves only the dragged end', () => {
    const left = byId(stretchStart(three(), 'b', 5000, DURATION), 'b')
    expect([left.startMs, left.endMs]).toEqual([5000, 8000])
    const right = byId(stretchEnd(three(), 'b', 10000, DURATION), 'b')
    expect([right.startMs, right.endMs]).toEqual([6000, 10000])
    expect(left.edited && right.edited).toBe(true)
  })

  it('enforces the minimum length from either end', () => {
    expect(byId(stretchStart(three(), 'b', 7999, DURATION), 'b').startMs).toBe(8000 - MIN_BLOCK_MS)
    expect(byId(stretchEnd(three(), 'b', 6001, DURATION), 'b').endMs).toBe(6000 + MIN_BLOCK_MS)
  })

  it('stops at neighbours', () => {
    expect(byId(stretchStart(three(), 'b', 0, DURATION), 'b').startMs).toBe(4000)
    expect(byId(stretchEnd(three(), 'b', 19000, DURATION), 'b').endMs).toBe(12000)
  })

  it('clamps to the recording', () => {
    expect(byId(stretchStart(three(), 'a', -100, DURATION), 'a').startMs).toBe(0)
    expect(byId(stretchEnd(three(), 'c', 50000, DURATION), 'c').endMs).toBe(DURATION)
  })

  it('leaves a block already shorter than the minimum alone rather than overlapping', () => {
    const zooms = [seg('a', 0, 300), seg('b', 300, 2000)]
    expect(stretchEnd(zooms, 'a', 200, DURATION)).toEqual(
      stretchEnd(zooms, 'a', 300, DURATION)
    )
    assertValid(stretchEnd(zooms, 'a', 800, DURATION))
  })

  it('shrinks eases on a short block so it still reaches full zoom', () => {
    const z = byId(stretchEnd(three(), 'b', 6000, DURATION), 'b')
    expect(z.easeInMs + z.easeOutMs).toBeLessThanOrEqual(z.endMs - z.startMs)
  })
})

describe('deleting a block', () => {
  it('removes only that block', () => {
    expect(deleteBlock(three(), 'b').map((z) => z.id)).toEqual(['a', 'c'])
  })

  it('returns the same list for an unknown id', () => {
    const zooms = three()
    expect(deleteBlock(zooms, 'nope')).toBe(zooms)
  })
})

describe('adding a block at the playhead', () => {
  const focus = { x: 0.25, y: 0.75 }

  it('adds a manual, edited block starting at the playhead', () => {
    const zooms = addZoom(three(), 9000, DURATION, focus, 'new')!
    const z = byId(zooms, 'new')
    expect([z.startMs, z.endMs]).toEqual([9000, 9000 + ADD_BLOCK_MS])
    expect(z.origin).toBe('manual')
    expect(z.edited).toBe(true)
    expect(z.focus).toEqual(focus)
    expect(zooms.map((s) => s.id)).toEqual(['a', 'b', 'new', 'c'])
  })

  it('slides back when the next block is too close', () => {
    const z = byId(addZoom(three(), 11500, DURATION, focus, 'new')!, 'new')
    expect(z.endMs).toBe(12000)
    expect(z.startMs).toBe(12000 - ADD_BLOCK_MS)
  })

  it('slides back at the end of the recording', () => {
    const z = byId(addZoom([], DURATION, DURATION, focus, 'new')!, 'new')
    expect(z.endMs).toBe(DURATION)
  })

  it('refuses inside a block', () => {
    expect(addZoom(three(), 2000, DURATION, focus, 'new')).toBeNull()
    expect(canAddZoom(three(), 2000, DURATION)).toBe(false)
  })

  it('refuses a gap smaller than the minimum', () => {
    const zooms = [seg('a', 1000, 2000), seg('b', 2000 + MIN_BLOCK_MS - 1, 4000)]
    expect(addZoom(zooms, 2100, DURATION, focus, 'new')).toBeNull()
  })

  it('fits a gap shorter than the default length', () => {
    const zooms = [seg('a', 1000, 2000), seg('b', 3000, 4000)]
    const z = byId(addZoom(zooms, 2500, DURATION, focus, 'new')!, 'new')
    expect([z.startMs, z.endMs]).toEqual([2000, 3000])
    expect(z.easeInMs + z.easeOutMs).toBeLessThanOrEqual(1000)
  })

  it('fits a recording shorter than the default length', () => {
    const z = byId(addZoom([], 0, 800, focus, 'new')!, 'new')
    expect([z.startMs, z.endMs]).toEqual([0, 800])
  })

  it('clamps the focus', () => {
    expect(byId(addZoom([], 0, DURATION, { x: 2, y: -1 }, 'new')!, 'new').focus).toEqual({ x: 1, y: 0 })
  })
})

describe('updating a block', () => {
  it('sets level and marks it edited', () => {
    const z = byId(updateBlock(three(), 'a', { level: 3 }), 'a')
    expect(z.level).toBe(3)
    expect(z.edited).toBe(true)
  })

  it('clamps level and focus', () => {
    expect(byId(updateBlock(three(), 'a', { level: 99 }), 'a').level).toBe(4)
    expect(byId(updateBlock(three(), 'a', { focus: { x: -1, y: 2 } }), 'a').focus).toEqual({ x: 0, y: 1 })
  })

  it('keeps ease in and out inside the block', () => {
    const z = byId(updateBlock(three(), 'b', { easeInMs: 1800 }), 'b')
    expect(z.easeInMs).toBe(1400)
  })

  it('returns the same list when nothing changed', () => {
    const zooms = three()
    expect(updateBlock(zooms, 'a', { level: 2 })).toBe(zooms)
  })
})

describe('undo and redo', () => {
  const edit = (state: EditorState, change: (zooms: ZoomSegment[]) => ZoomSegment[]) =>
    editorReducer(state, { type: 'edit', change: (p) => withZooms(p, change(p.zooms)) })

  it('undoes and redoes a move', () => {
    const start = initialState(project(three()))
    const moved = edit(start, (z) => moveBlock(z, 'b', 7000, DURATION))
    const undone = editorReducer(moved, { type: 'undo' })
    expect(undone.project.zooms).toEqual(three())
    const redone = editorReducer(undone, { type: 'redo' })
    expect(byId(redone.project.zooms, 'b').startMs).toBe(7000)
  })

  it('undoes a delete and clears a selection that no longer exists', () => {
    let state = initialState(project(three()))
    state = editorReducer(state, { type: 'select', id: 'b' })
    state = edit(state, (z) => deleteBlock(z, 'b'))
    expect(state.selectedId).toBeNull()
    state = editorReducer(state, { type: 'undo' })
    expect(state.project.zooms).toHaveLength(3)
  })

  it('makes a whole drag one undo step', () => {
    let state = initialState(project(three()))
    state = editorReducer(state, { type: 'gesture-start' })
    for (const ms of [6100, 6200, 6300, 6400]) state = edit(state, (z) => moveBlock(z, 'b', ms, DURATION))
    state = editorReducer(state, { type: 'gesture-end' })
    expect(state.past).toHaveLength(1)
    expect(byId(state.project.zooms, 'b').startMs).toBe(6400)
    state = editorReducer(state, { type: 'undo' })
    expect(byId(state.project.zooms, 'b').startMs).toBe(6000)
  })

  it('adds no undo step for a drag that changed nothing', () => {
    let state = initialState(project(three()))
    state = editorReducer(state, { type: 'gesture-start' })
    state = edit(state, (z) => moveBlock(z, 'b', 6000, DURATION))
    state = editorReducer(state, { type: 'gesture-end' })
    expect(state.past).toHaveLength(0)
  })

  it('adds no undo step for a drag that came back to where it began', () => {
    const start = initialState(project(three()))
    const base = start.project.zooms
    let state = editorReducer(start, { type: 'gesture-start' })
    state = edit(state, () => moveBlock(base, 'b', 7000, DURATION))
    state = edit(state, () => moveBlock(base, 'b', 6000, DURATION))
    state = editorReducer(state, { type: 'gesture-end' })
    expect(state.past).toHaveLength(0)
    expect(byId(state.project.zooms, 'b').edited).toBe(false)
  })

  it('ignores undo during a drag', () => {
    let state = initialState(project(three()))
    state = edit(state, (z) => deleteBlock(z, 'a'))
    state = editorReducer(state, { type: 'gesture-start' })
    expect(editorReducer(state, { type: 'undo' })).toBe(state)
  })

  it('clears redo after a new edit', () => {
    let state = initialState(project(three()))
    state = edit(state, (z) => deleteBlock(z, 'a'))
    state = editorReducer(state, { type: 'undo' })
    state = edit(state, (z) => deleteBlock(z, 'b'))
    expect(state.future).toHaveLength(0)
  })

  it('leaves output settings out of undo', () => {
    let state = initialState(project(three()))
    state = edit(state, (z) => deleteBlock(z, 'a'))
    state = editorReducer(state, { type: 'output', change: (o) => ({ ...o, fps: 60 }) })
    expect(state.past).toHaveLength(1)
    state = editorReducer(state, { type: 'undo' })
    expect(state.project.output.fps).toBe(60)
    expect(state.project.zooms).toHaveLength(3)
  })

  it('caps history', () => {
    let state = initialState(project(three()))
    for (let i = 0; i < 150; i++) state = edit(state, (z) => updateBlock(z, 'a', { level: 1.5 + (i % 2) }))
    expect(state.past).toHaveLength(100)
  })

  it('does nothing with an empty history', () => {
    const state = initialState(project(three()))
    expect(editorReducer(state, { type: 'undo' })).toBe(state)
    expect(editorReducer(state, { type: 'redo' })).toBe(state)
  })
})

describe('helpers', () => {
  it('maps pointer x to time and clamps', () => {
    expect(msFromX(500, 1000, DURATION)).toBe(10000)
    expect(msFromX(-10, 1000, DURATION)).toBe(0)
    expect(msFromX(2000, 1000, DURATION)).toBe(DURATION)
    expect(msFromX(10, 0, DURATION)).toBe(0)
  })

  it('labels blocks like the concept', () => {
    expect(blockLabel(seg('a', 0, 1000, { clickMs: [1, 2, 3] }))).toBe('2.0× · 3 clicks')
    expect(blockLabel(seg('a', 0, 1000, { clickMs: [1] }))).toBe('2.0×')
    expect(zoomSummary(4, 7)).toBe('4 zooms from 7 clicks')
    expect(zoomSummary(1, 1)).toBe('1 zoom from 1 click')
  })

  it('formats timecode as hh:mm:ss:ff', () => {
    expect(formatTimecode(7600, 60)).toBe('00:00:07:36')
    expect(formatTimecode(3661000, 60)).toBe('01:01:01:00')
  })

  it('spaces ruler ticks to fit the width', () => {
    expect(rulerTicks(20000, 800).map((t) => t.label)).toEqual(['0s', '2s', '4s', '6s', '8s', '10s', '12s', '14s', '16s', '18s'])
    const long = rulerTicks(3600000, 800)
    expect(long.length).toBeLessThanOrEqual(13)
    expect(long[1].label).toBe('5:00')
  })
})

describe('autosave', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('debounces to the newest value', async () => {
    const saved: number[] = []
    const auto = createAutosave<number>(async (v) => void saved.push(v), 500)
    auto.schedule(1)
    await vi.advanceTimersByTimeAsync(200)
    auto.schedule(2)
    await vi.advanceTimersByTimeAsync(200)
    auto.schedule(3)
    expect(saved).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(saved).toEqual([3])
  })

  it('never lets an older save land after a newer one', async () => {
    const saved: number[] = []
    let release = () => {}
    const auto = createAutosave<number>(async (v) => {
      saved.push(v)
      if (v === 1) await new Promise<void>((r) => (release = r))
    }, 100)
    auto.schedule(1)
    await vi.advanceTimersByTimeAsync(100)
    auto.schedule(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(saved).toEqual([1])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(saved).toEqual([1, 2])
  })

  it('flush writes right away and waits for it', async () => {
    const saved: number[] = []
    const auto = createAutosave<number>(async (v) => void saved.push(v), 5000)
    auto.schedule(1)
    await auto.flush()
    expect(saved).toEqual([1])
  })

  it('holds writes while paused and sends the newest on resume', async () => {
    const saved: number[] = []
    const auto = createAutosave<number>(async (v) => void saved.push(v), 100)
    auto.pause()
    auto.schedule(1)
    auto.schedule(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(saved).toEqual([])
    auto.resume()
    await vi.advanceTimersByTimeAsync(100)
    expect(saved).toEqual([2])
  })

  it('reports a failed save and recovers on the next one', async () => {
    const statuses: string[] = []
    let fail = true
    const auto = createAutosave<number>(
      async () => {
        if (fail) throw new Error('disk full')
      },
      100,
      (s) => statuses.push(s)
    )
    auto.schedule(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(statuses).toEqual(['saving', 'failed'])
    fail = false
    auto.schedule(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(statuses).toEqual(['saving', 'failed', 'saving', 'saved'])
  })
})
