import { describe, expect, it } from 'vitest'
import { buildZooms } from '../src/engine/zoom'
import type { ClickPoint } from '../src/shared/compose'
import { ZOOM_DEFAULTS, type ZoomSegment } from '../src/shared/project'

const clip = { width: 1920, height: 1080 }
const DURATION = 20000

const click = (t: number, x = 960, y = 540): ClickPoint => ({ t, x, y })
const clicks = (...times: number[]): ClickPoint[] => times.map((t) => click(t))

function edited(startMs: number, endMs: number, id = 'mine'): ZoomSegment {
  return {
    id,
    startMs,
    endMs,
    level: 3,
    easeInMs: 200,
    easeOutMs: 300,
    focus: { x: 0.1, y: 0.9 },
    clickMs: [],
    origin: 'auto',
    edited: true
  }
}

describe('buildZooms: one click', () => {
  it('returns nothing for no clicks', () => {
    expect(buildZooms([], DURATION, clip)).toEqual([])
  })

  it('starts 600 ms before the click and ends 1600 ms after it', () => {
    const [seg] = buildZooms([click(5000, 480, 270)], DURATION, clip)
    expect(seg).toMatchObject({
      startMs: 4400,
      endMs: 6600,
      level: 2,
      easeInMs: 600,
      easeOutMs: 600,
      focus: { x: 0.25, y: 0.25 },
      clickMs: [5000],
      origin: 'auto',
      edited: false
    })
  })

  it('uses the defaults from the data model', () => {
    const [seg] = buildZooms(clicks(5000), DURATION, clip)
    expect(seg.level).toBe(ZOOM_DEFAULTS.level)
    expect(seg.easeInMs).toBe(ZOOM_DEFAULTS.easeInMs)
    expect(seg.easeOutMs).toBe(ZOOM_DEFAULTS.easeOutMs)
    expect(seg.endMs - 5000).toBe(ZOOM_DEFAULTS.tailMs)
  })

  it('keeps the arrival exact for fractional click times', () => {
    for (const t of [1234.567, 700.1, 0.1 + 0.2 + 3000, 16.666666666666668 * 200]) {
      const [seg] = buildZooms(clicks(t), DURATION, clip)
      expect(t - seg.startMs).toBeGreaterThanOrEqual(seg.easeInMs)
    }
  })
})

describe('buildZooms: grouping', () => {
  it('merges clicks under 1.2 s apart', () => {
    const zooms = buildZooms(clicks(5000, 6199), DURATION, clip)
    expect(zooms).toHaveLength(1)
    expect(zooms[0]).toMatchObject({ startMs: 4400, endMs: 7799, clickMs: [5000, 6199] })
  })

  it('keeps clicks exactly 1.2 s apart separate', () => {
    const zooms = buildZooms(clicks(5000, 6200), DURATION, clip)
    expect(zooms.map((z) => z.clickMs)).toEqual([[5000], [6200]])
  })

  it('merges a chain by the gap to the previous click, not to the first', () => {
    const zooms = buildZooms(clicks(1000, 2000, 3000, 4000, 5000), DURATION, clip)
    expect(zooms).toHaveLength(1)
    expect(zooms[0].clickMs).toEqual([1000, 2000, 3000, 4000, 5000])
  })

  it('focuses on the first click of a group', () => {
    const [seg] = buildZooms([click(5000, 192, 108), click(5500, 1800, 1000)], DURATION, clip)
    expect(seg.focus).toEqual({ x: 0.1, y: 0.1 })
  })

  it('merges clicks at the same moment', () => {
    const zooms = buildZooms(clicks(5000, 5000), DURATION, clip)
    expect(zooms).toHaveLength(1)
    expect(zooms[0].clickMs).toEqual([5000, 5000])
  })
})

describe('buildZooms: recording edges', () => {
  it('handles a click on the first frame', () => {
    const [seg] = buildZooms(clicks(0), DURATION, clip)
    expect(seg).toMatchObject({ startMs: 0, endMs: 1600, easeInMs: 0, easeOutMs: 600 })
  })

  it('shortens the ease in for clicks in the first 600 ms', () => {
    for (const t of [100, 300, 599.5]) {
      const [seg] = buildZooms(clicks(t), DURATION, clip)
      expect(seg.startMs).toBe(0)
      expect(seg.easeInMs).toBe(t)
    }
  })

  it('holds the zoom instead of cutting in when there is no room for a ramp', () => {
    const [seg] = buildZooms(clicks(16.7), DURATION, clip)
    expect(seg).toMatchObject({ startMs: 0, easeInMs: 0 })
  })

  it('keeps the full ease in from 600 ms on', () => {
    expect(buildZooms(clicks(600), DURATION, clip)[0]).toMatchObject({ startMs: 0, easeInMs: 600 })
    expect(buildZooms(clicks(601), DURATION, clip)[0]).toMatchObject({ startMs: 1, easeInMs: 600 })
  })

  it('handles a click on the last frame', () => {
    const [seg] = buildZooms(clicks(DURATION), DURATION, clip)
    expect(seg).toMatchObject({ startMs: DURATION - 600, endMs: DURATION, easeInMs: 600, easeOutMs: 0 })
  })

  it('clamps the end and keeps the ease out after the last click', () => {
    const cases: [number, number][] = [
      [DURATION - 1600, 600],
      [DURATION - 1000, 600],
      [DURATION - 600, 600],
      [DURATION - 300, 300],
      [DURATION - 100, 100],
      [DURATION - 99, 0]
    ]
    for (const [t, ease] of cases) {
      const [seg] = buildZooms(clicks(t), DURATION, clip)
      expect(seg.endMs).toBe(DURATION)
      expect(seg.easeOutMs).toBe(ease)
      expect(seg.endMs - ease).toBeGreaterThanOrEqual(t)
    }
  })

  it('fits a recording shorter than the segment', () => {
    const [seg] = buildZooms(clicks(200), 500, clip)
    expect(seg).toMatchObject({ startMs: 0, endMs: 500, easeInMs: 200, easeOutMs: 300 })
  })

  it('ignores clicks outside the recording', () => {
    expect(buildZooms(clicks(-1, DURATION + 1), DURATION, clip)).toEqual([])
    expect(buildZooms(clicks(NaN), DURATION, clip)).toEqual([])
  })

  it('makes nothing from an empty recording', () => {
    expect(buildZooms(clicks(0), 0, clip)).toEqual([])
  })

  it('clamps focus for clicks past the clip edge', () => {
    const [seg] = buildZooms([click(5000, -40, 2000)], DURATION, clip)
    expect(seg.focus).toEqual({ x: 0, y: 1 })
  })
})

describe('buildZooms: overlap', () => {
  it('ends the first group exactly where the next starts', () => {
    const [a, b] = buildZooms(clicks(5000, 6200), DURATION, clip)
    expect(a.endMs).toBe(5600)
    expect(b.startMs).toBe(5600)
    expect(a.endMs).toBe(b.startMs)
  })

  it('still reaches every click before the join', () => {
    for (const gap of [1200, 1500, 2000, 2199]) {
      const [a, b] = buildZooms(clicks(5000, 5000 + gap), DURATION, clip)
      expect(a.endMs).toBe(b.startMs)
      expect(a.endMs - 5000).toBeGreaterThanOrEqual(600)
      expect(b.easeInMs).toBe(600)
    }
  })

  it('leaves groups that only just fit alone', () => {
    const [a, b] = buildZooms(clicks(5000, 7200), DURATION, clip)
    expect(a.endMs).toBe(6600)
    expect(b.startMs).toBe(6600)
    const [c, d] = buildZooms(clicks(5000, 7300), DURATION, clip)
    expect(c.endMs).toBe(6600)
    expect(d.startMs).toBe(6700)
  })

  it('chains three groups', () => {
    const zooms = buildZooms(clicks(2000, 3300, 4600), DURATION, clip)
    expect(zooms.map((z) => [z.startMs, z.endMs])).toEqual([
      [1400, 2700],
      [2700, 4000],
      [4000, 6200]
    ])
  })
})

describe('buildZooms: unsorted input', () => {
  it('gives the same result as sorted input', () => {
    const sorted = [click(1000, 10, 10), click(1500, 20, 20), click(5000, 30, 30), click(9000, 40, 40)]
    const shuffled = [sorted[2], sorted[0], sorted[3], sorted[1]]
    expect(buildZooms(shuffled, DURATION, clip)).toEqual(buildZooms(sorted, DURATION, clip))
  })

  it('leaves its input alone', () => {
    const input = clicks(5000, 1000, 3000)
    const existing = [edited(8000, 9000)]
    const copy = JSON.parse(JSON.stringify({ input, existing }))
    buildZooms(input, DURATION, clip, existing)
    expect({ input, existing }).toEqual(copy)
  })
})

describe('buildZooms: existing segments', () => {
  it('keeps edited segments unchanged', () => {
    const mine = edited(8000, 9000)
    const zooms = buildZooms(clicks(2000), DURATION, clip, [mine])
    expect(zooms).toHaveLength(2)
    expect(zooms[1]).toEqual(mine)
  })

  it('keeps an edited segment that has no clicks left', () => {
    const mine = edited(8000, 9000)
    expect(buildZooms([], DURATION, clip, [mine])).toEqual([mine])
  })

  it('drops an auto segment that collides with an edited one', () => {
    const mine = edited(5000, 6000)
    expect(buildZooms(clicks(5500), DURATION, clip, [mine])).toEqual([mine])
    expect(buildZooms(clicks(3500), DURATION, clip, [mine])).toEqual([mine])
    expect(buildZooms(clicks(6500), DURATION, clip, [mine])).toEqual([mine])
  })

  it('keeps auto segments that only touch an edited one', () => {
    const mine = edited(5000, 6000)
    const zooms = buildZooms(clicks(3400, 6600), DURATION, clip, [mine])
    expect(zooms.map((z) => [z.startMs, z.endMs])).toEqual([
      [2800, 5000],
      [5000, 6000],
      [6000, 8200]
    ])
  })

  it('drops only the colliding group', () => {
    const mine = edited(8000, 9000)
    const zooms = buildZooms(clicks(2000, 8500, 15000), DURATION, clip, [mine])
    expect(zooms.map((z) => z.id)).toEqual(['zoom-2000', 'mine', 'zoom-15000'])
  })

  it('keeps a group that was shortened by a group that then gets dropped', () => {
    const mine = edited(6000, 8000)
    const zooms = buildZooms(clicks(5000, 6300), DURATION, clip, [mine])
    expect(zooms.map((z) => [z.startMs, z.endMs])).toEqual([
      [4400, 5700],
      [6000, 8000]
    ])
    expect(zooms[0].easeOutMs).toBe(600)
    expect(zooms[0].endMs - zooms[0].easeOutMs).toBeGreaterThanOrEqual(5000)
  })

  it('replaces unedited auto segments', () => {
    const stale: ZoomSegment = { ...edited(1000, 2000, 'stale'), edited: false }
    const zooms = buildZooms(clicks(5000), DURATION, clip, [stale])
    expect(zooms.map((z) => z.id)).toEqual(['zoom-5000'])
  })

  it('keeps manual segments even before they are edited', () => {
    const manual: ZoomSegment = { ...edited(8000, 9000, 'manual'), origin: 'manual', edited: false }
    expect(buildZooms(clicks(8500), DURATION, clip, [manual])).toEqual([manual])
  })

  it('returns segments in time order', () => {
    const zooms = buildZooms(clicks(2000, 15000), DURATION, clip, [edited(9000, 10000, 'b'), edited(5000, 6000, 'a')])
    expect(zooms.map((z) => z.id)).toEqual(['zoom-2000', 'a', 'b', 'zoom-15000'])
  })
})

describe('buildZooms: IDs', () => {
  it('derives IDs from the first click', () => {
    const zooms = buildZooms(clicks(1000, 1500, 9000), DURATION, clip)
    expect(zooms.map((z) => z.id)).toEqual(['zoom-1000', 'zoom-9000'])
  })

  it('stays the same when run again', () => {
    const input = clicks(1000, 1500, 9000, 10200)
    const once = buildZooms(input, DURATION, clip)
    expect(buildZooms(input, DURATION, clip)).toEqual(once)
    expect(buildZooms(input, DURATION, clip, once)).toEqual(once)
  })

  it('keeps the ID of a group when other groups change', () => {
    const before = buildZooms(clicks(1000, 9000), DURATION, clip)
    const after = buildZooms(clicks(1000, 5000, 9000), DURATION, clip)
    expect(after.find((z) => z.clickMs[0] === 9000)?.id).toBe(before[1].id)
  })

  it('never hands out an ID that an edited segment holds', () => {
    const moved = edited(15000, 16000, 'zoom-5000')
    const zooms = buildZooms(clicks(5000), DURATION, clip, [moved])
    const ids = zooms.map((z) => z.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['zoom-5000-2', 'zoom-5000'])
  })
})

describe('buildZooms: generated recordings', () => {
  it('holds its invariants', () => {
    let seed = 7
    const next = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let run = 0; run < 400; run++) {
      const duration = 500 + next() * 30000
      const count = Math.floor(next() * 12)
      const input = Array.from({ length: count }, () => click(next() * duration, next() * 1920, next() * 1080))
      const zooms = buildZooms(input, duration, clip)

      expect(zooms.flatMap((z) => z.clickMs)).toEqual(input.map((c) => c.t).sort((a, b) => a - b))
      zooms.forEach((z, i) => {
        expect(z.startMs).toBeGreaterThanOrEqual(0)
        expect(z.endMs).toBeLessThanOrEqual(duration)
        expect(z.endMs).toBeGreaterThan(z.startMs)
        expect(z.startMs + z.easeInMs).toBeLessThanOrEqual(z.clickMs[0] + 1e-6)
        expect(z.endMs - z.easeOutMs).toBeGreaterThanOrEqual(z.clickMs[z.clickMs.length - 1] - 1e-6)
        z.clickMs.forEach((t, j) => {
          if (j > 0) expect(t - z.clickMs[j - 1]).toBeLessThan(1200)
          expect(t).toBeGreaterThanOrEqual(z.startMs)
          expect(t).toBeLessThanOrEqual(z.endMs)
        })
        const after = zooms[i + 1]
        if (!after) return
        expect(after.clickMs[0] - z.clickMs[z.clickMs.length - 1]).toBeGreaterThanOrEqual(1200)
        expect(z.endMs).toBeLessThanOrEqual(after.startMs)
      })
    }
  })
})
