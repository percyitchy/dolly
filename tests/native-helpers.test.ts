// The helpers themselves. This Mac can't compile the Windows one, so these pin what its fixes rest on as text.
// The macOS binary needs a display and Screen Recording to record, but its mouse tap runs alone, so that part is real.

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const swift = read('native/mac-capture/main.swift')
const cpp = read('native/win-capture/main.cpp')
const cmake = read('native/win-capture/CMakeLists.txt')
const binary = new URL('../native/bin/darwin-arm64/dolly-capture', import.meta.url).pathname

// The body of the record loop, up to the catch that ends it
const loop = cpp.slice(cpp.indexOf('while (!g_stop.load()) {'), cpp.indexOf('capture stopped:'))
const before = (text: string, a: string, b: string) => {
  expect(text).toContain(a)
  expect(text).toContain(b)
  return text.indexOf(a) < text.indexOf(b)
}

describe('the macOS mouse tap', () => {
  const types = /let mouseEventTypes: \[CGEventType\] = \[([^\]]*)\]/.exec(swift)?.[1] ?? ''

  it('asks for mouse events and nothing else', () => {
    expect(types.match(/\.\w+/g)?.sort()).toEqual(
      ['.leftMouseDown', '.leftMouseDragged', '.leftMouseUp', '.mouseMoved', '.otherMouseDown', '.otherMouseDragged', '.otherMouseUp', '.rightMouseDown', '.rightMouseDragged', '.rightMouseUp'].sort()
    )
    expect(swift).not.toMatch(/\.keyDown|\.keyUp|\.flagsChanged/)
  })

  it('is a session tap that only listens, built from that one list', () => {
    expect(swift).toContain('tap: .cgSessionEventTap')
    expect(swift).toContain('options: .listenOnly')
    expect(swift).not.toContain('.defaultTap')
    expect(swift).toMatch(/let mask = mouseEventTypes\.reduce/)
    expect(swift.match(/CGEvent\.tapCreate/g)).toHaveLength(1)
  })

  it('turns itself back on when macOS turns it off', () => {
    expect(swift).toMatch(/case \.tapDisabledByTimeout, \.tapDisabledByUserInput:[\s\S]{0,120}tapEnable\(tap: tap, enable: true\)/)
  })

  it('stamps events with the clock the frames use', () => {
    expect(swift).toContain('ms(hostNow()), at.x, at.y')
    expect(swift).toContain('"type": "firstFrame", "hostMs": ms(pts)')
    expect(swift).not.toContain('event.timestamp')
  })

  it('reports the count in the final line, and only after the log is closed', () => {
    expect(swift).toContain('"tapEvents": events')
    expect(before(swift, 'stopped.merge(tap.finish())', 'emit(stopped)')).toBe(true)
  })

  it('N2: lets only arriving events clear the quiet count', () => {
    const check = swift.slice(swift.indexOf('private func check()'), swift.indexOf('// Closes the log'))
    expect(check).toContain('silentChecks = silentChecksAfter(')
    expect(check).toContain('arrived: events != seenAtLastCheck')
    expect(check).not.toContain('silentChecks = quiet')
  })

  it('does not post, warp or otherwise make input of its own', () => {
    expect(swift).not.toMatch(/\.post\(|CGWarpMouseCursorPosition|CGEventPost/)
  })
})

describe('the macOS file writer', () => {
  it('writes fragments, so a full disk or a crash leaves a file that plays', () => {
    expect(swift).toContain('writer.movieFragmentInterval = CMTime(value: 2, timescale: 1)')
  })

  it('keeps the file when writing fails, since cancelling would delete it', () => {
    const write = swift.slice(swift.indexOf('private func write(_ buffer'), swift.indexOf('// Repeats the last frame'))
    expect(write).toContain('stop(reason: "write-failed")')
    expect(write).not.toContain('fail(')
    expect(swift.match(/cancelWriting/g)).toHaveLength(1) // Only for a recording with no frames at all
    expect(swift).toContain('guard writer.status == .writing else')
  })
})

describe('the Windows helper', () => {
  it('M6: ends the loop on a failure and still finalizes', () => {
    expect(cpp).toMatch(/\} catch \(const winrt::hresult_error& error\) \{\n\s+fwprintf\(stderr, L"capture stopped[^\n]*\n\s+g_interrupted = true;/)
    expect(before(cpp, 'try {\n    while (!g_stop.load()) {', 'capture stopped:')).toBe(true)
    expect(before(cpp, 'capture stopped:', 'writer.finish();\n  } catch (const winrt::hresult_error& error) {')).toBe(true)
  })

  it('M7: tells a failed write apart and reports it', () => {
    expect(cpp).toContain('write_failed_ = FAILED(written);')
    expect(cpp).toContain('write_failed ? "write-failed" : g_interrupted.load() ? "interrupted" : "requested"')
  })

  it('M7: reports a failed write even when finalizing fails too, so main can check the file', () => {
    expect(cpp).toContain('if (!write_failed) fail("Couldn\'t finish the file: "')
    expect(before(cpp, 'const bool write_failed = writer.write_failed();', 'writer.finish();\n  } catch')).toBe(true)
  })

  it('M8: holds to the same limits as macOS, and scales through to the staging texture', () => {
    expect(cpp).toContain('std::min({4096.0 / width, 2304.0 / height, 1.0})')
    expect(swift).toContain('min(4096.0 / Double(pixelW), 2304.0 / Double(pixelH), 1)')
    expect(cpp).toContain('writer.open(output, width, height,')
    expect(loop).toContain('scaler.run(context, texture.get(), box, staging.get())')
    expect(cmake).toMatch(/target_link_libraries\(.*\bd2d1\b/)
  })

  it('M9: checks for stop while filling, caps a pass and notices a clock jump', () => {
    expect(cpp).toContain('!(until_stop && g_stop.load())')
    expect(loop).toContain('std::min(slot, next_slot + fill_cap)')
    expect(loop).toContain('std::min(slot_of(now) - 3, next_slot + fill_cap)')
    expect(loop).toMatch(/> CLOCK_JUMP_TICKS\) \{\n\s+g_interrupted = true;\n\s+break;/)
    expect(cpp).toContain('fill_to(std::min(slot_of(pass_at) + 1, next_slot + fill_cap * 2), false)')
  })

  it('N7: tells sleep from a stall by what the two clocks disagree on', () => {
    expect(cpp).toContain('QueryUnbiasedInterruptTime(&ticks);')
    expect(loop).toContain('(now - pass_at) - (awake - awake_at) > CLOCK_JUMP_TICKS')
    expect(loop).not.toMatch(/now - pass_at > CLOCK_JUMP_TICKS/)
    expect(before(loop, 'awake_at = awake;', 'pool.TryGetNextFrame()')).toBe(true)
  })

  it('N8: ends the recording on a resolution change instead of writing at the old size', () => {
    expect(cpp).not.toContain('pool.Recreate')
    expect(loop).toMatch(/frame\.ContentSize\(\);\n[^\n]*content\.Width != item_size\.Width[^\n]*\n\s+frame\.Close\(\);\n\s+resolution_changed = true;\n\s+g_interrupted = true;\n\s+break;/)
    expect(cpp).toContain('\\"resolutionChanged\\":%s')
    expect(cpp).toContain('resolution_changed ? "true" : "false"')
  })

  it('L14: reports the cursor and border, and uses both only behind a runtime check', () => {
    expect(cpp).toContain('\\"cursorHidden\\":%s,\\"borderHidden\\":%s')
    expect(before(cpp, 'L"IsCursorCaptureEnabled"', 'session.IsCursorCaptureEnabled(false)')).toBe(true)
    expect(before(cpp, 'L"IsBorderRequired"', 'RequestAccessAsync')).toBe(true)
    expect(before(cpp, 'RequestAccessAsync', 'session.IsBorderRequired(false)')).toBe(true)
  })

  it('L15c: keeps the frame open until the copy has been read', () => {
    expect(before(loop, 'context->Map(', 'context->Unmap(')).toBe(true)
    expect(before(loop, 'context->Unmap(', 'frame.Close();\n\n      if (first_ticks')).toBe(true)
  })

})

describe.runIf(process.platform === 'darwin')('the quiet count, compiled', () => {
  it('N2: adds up over still seconds, and only events clear it', { timeout: 60000 }, async () => {
    const source = /^func silentChecksAfter[\s\S]*?^}\n/m.exec(swift)?.[0]
    expect(source).toBeTruthy()
    const steps = [
      // enabled, moved, arrived. A dead tap with a mouse that moves one second in two
      [true, true, false],
      [true, false, false],
      [true, true, false],
      [true, false, false],
      [true, true, false],
      // Events clear it, a still second leaves it, and an off tap counts even when still
      [true, true, true],
      [true, false, false],
      [false, false, false],
      [true, false, true]
    ]
    const dir = mkdtempSync(join(tmpdir(), 'dolly-quiet-'))
    try {
      const calls = steps.map(([enabled, moved, arrived]) => `count = silentChecksAfter(count, enabled: ${enabled}, moved: ${moved}, arrived: ${arrived}); print(count)`)
      writeFileSync(join(dir, 'main.swift'), `${source}\nvar count = 0\n${calls.join('\n')}\n`)
      await promisify(execFile)('swiftc', ['main.swift', '-o', 'quiet'], { cwd: dir, timeout: 50000 })
      const { stdout } = await promisify(execFile)(join(dir, 'quiet'), [], { timeout: 5000 })
      expect(stdout.trim().split('\n').map(Number)).toEqual([1, 1, 2, 2, 3, 0, 0, 1, 0])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.runIf(process.platform === 'darwin' && existsSync(binary))('the real dolly-capture', () => {
  it('runs the tap alone, closes its log and reports what it saw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dolly-tap-'))
    const log = join(dir, 'mouse.jsonl')
    try {
      const { stdout } = await promisify(execFile)(binary, ['mouse-tap', '--seconds', '0.2', '--output', log], { timeout: 10000 })
      const [ready, stopped] = stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(ready).toMatchObject({ type: 'ready', listenAccess: expect.any(Boolean) })
      expect(['listening', 'disabled', 'unavailable']).toContain(ready.mouseTap)
      expect(stopped).toMatchObject({ type: 'stopped', mouseTap: ready.mouseTap, tapEvents: expect.any(Number), tapDisabled: expect.any(Number) })
      expect(existsSync(log)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('N6: says how much room a volume has, at least as much as statfs sees', async () => {
    const { stdout } = await promisify(execFile)(binary, ['disk-free', '--path', tmpdir()], { timeout: 10000 })
    const reply = JSON.parse(stdout) as { type: string; bytes: number }
    const { bavail, bsize } = statfsSync(tmpdir())
    expect(reply.type).toBe('diskFree')
    expect(reply.bytes).toBeGreaterThan(bavail * bsize * 0.9) // Not exact: other programs write between the two reads
  })

  it('N6: fails plainly for a path that is not there', async () => {
    await expect(promisify(execFile)(binary, ['disk-free', '--path', join(tmpdir(), 'no-such-folder-dolly')], { timeout: 10000 })).rejects.toMatchObject({ code: 1 })
  })

  it('answers both permissions without asking', async () => {
    const { stdout } = await promisify(execFile)(binary, ['permission'], { timeout: 10000 })
    expect(JSON.parse(stdout)).toMatchObject({ type: 'permission', screen: expect.any(Boolean), mouse: expect.any(Boolean) })
  })
})
