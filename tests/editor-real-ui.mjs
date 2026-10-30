// Every editor interaction in the real built app, using real input events and reading results from
// project.json on disk. Pro needs a signed license, so that part swaps only main's license and capture
// and captions handlers through the inspector. The renderer and everything else run as shipped.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aimAt, compose } from '../src/shared/compose.ts'
import {
  click, decodePng, drag, key, launch, log, micClip, openFirstProject, perfClip, resetProjects, screenshot, seekTo, sleep, webcamClip, writeProject
} from './editor-real-kit.mjs'

const DURATION = 12000
const META = 4 // Cmd in CDP modifier bits
const SHIFT = 8
const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const block = (id, startMs, endMs, clickMs, focus) => ({ id, startMs, endMs, level: 2, easeInMs: 600, easeOutMs: 600, focus, clickMs, origin: 'auto', edited: false })

function fixture(screen, mic, webcamFile) {
  const events = []
  for (let t = 0; t <= DURATION; t += 16) events.push({ t, x: 1440 + 1100 * Math.sin(t / 2100), y: 900 + 700 * Math.sin(t / 1300), kind: 'move' })
  for (const t of [1600, 2200, 2800, 4800, 7600, 9900]) {
    const near = events.find((e) => e.t >= t)
    events.push({ t, x: near.x, y: near.y, kind: 'down', button: 'left' })
  }
  events.sort((a, b) => a.t - b.t)
  return writeProject('Launch demo', {
    screen, mic, webcamFile, width: 2880, height: 1800, fps: 60, durationMs: DURATION, cursor: events,
    zooms: [
      block('a', 1000, 4400, [1600, 2200, 2800], { x: 0.6, y: 0.5 }),
      block('b', 4800, 6400, [4800], { x: 0.3, y: 0.3 }),
      block('c', 7000, 9200, [7600], { x: 0.5, y: 0.6 }),
      block('d', 9400, 11500, [9900], { x: 0.7, y: 0.4 })
    ],
    webcam: { shape: 'circle', corner: 'br', sizePct: 22 },
    captions: [{ id: 'c1', startMs: 500, endMs: 3000, text: 'Tick off the launch video' }]
  })
}

export async function ui() {
  const screen = await perfClip()
  const mic = await micClip()
  const cam = await webcamClip()
  resetProjects()
  const dir = fixture(screen, mic, cam)
  const disk = () => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
  const zoom = (id) => disk().zooms.find((z) => z.id === id)
  const settled = () => sleep(1100) // Past the autosave debounce

  const app = await launch({ inspect: true })
  try {
    const { page, main } = app
    const mainJs = (code) => main.js(code, { includeCommandLineAPI: true })
    const blockBox = (i) => page.js(`(() => { const r = document.querySelectorAll('.block')[${i}].getBoundingClientRect(); return { l: r.left, r: r.right, y: r.top + r.height / 2, w: r.width } })()`)
    const panel = () => page.js(`document.querySelector('.panel h2')?.textContent ?? null`)
    const blocks = () => page.js(`document.querySelectorAll('.block').length`)
    const tcText = () => page.js(`document.querySelector('.tl-top .tc').firstChild.textContent.trim()`)
    const shipText = () => page.js(`document.querySelector('.ship').innerText.replace(/\\n+/g, ' | ')`)
    const openTool = (name) => page.js(`[...document.querySelectorAll('.tools button')].find((b) => b.textContent.startsWith('${name}')).click()`)
    const rect = (selector) => page.js(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height } })()`)
    const sliderTo = async (label, fraction) => {
      const box = await page.js(`(() => { const f = [...document.querySelectorAll('.panel label.field')].find((n) => n.innerText.toLowerCase().includes('${label}')); const r = f.querySelector('input').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width } })()`)
      await drag(page, { x: box.x + box.w * 0.5, y: box.y }, { x: box.x + box.w * fraction, y: box.y }, 5)
    }

    // Free
    await sleep(800)
    check('first-run card explains permissions before the OS asks', await page.js(`/Before your first recording|New recording/.test(document.querySelector('.home-card').innerText)`), await page.js(`document.querySelector('.home-card h1').textContent`))
    await screenshot(page, 'ui-home-first-run.png')
    await openFirstProject(page)
    log('metrics', await page.js(`JSON.stringify(Object.fromEntries(Object.entries({ bar: '.bar', tool: '.tools button', frameA: '.fmt.a .frame', frameB: '.fmt.b .frame', frameC: '.fmt.c .frame', tl: '.tl', play: '.play', ship: '.ship', seg: '.ship .seg', primary: '.ship .primary', block: '.block' }).map(([k, q]) => { const r = document.querySelector(q).getBoundingClientRect(); return [k, [Math.round(r.width), Math.round(r.height)]] })))`))
    check('opens with four blocks and clicks', (await blocks()) === 4 && (await page.js(`document.querySelectorAll('.tick').length`)) === 6)
    check('summary reads like the concept', (await page.js(`document.querySelector('.tl-top').innerText`)).includes('4 zooms from 6 clicks'))
    check('left-out line names both items', (await shipText()).includes('The webcam bubble and captions are left out of this export.'))
    check('a click edits nothing', await (async () => {
      const b = await blockBox(1)
      await click(page, (b.l + b.r) / 2, b.y)
      await settled()
      return !zoom('b').edited
    })())
    check('clicking a block selects it and opens Zoom', (await panel()) === 'Zoom' && (await page.js(`document.querySelectorAll('.block')[1].classList.contains('sel')`)))
    await screenshot(page, 'ui-zoom-panel.png')

    let b = await blockBox(1)
    await drag(page, { x: (b.l + b.r) / 2, y: b.y }, { x: (b.l + b.r) / 2 + 40, y: b.y })
    await settled()
    let z = zoom('b')
    check('drag moves a block and keeps its length', z.startMs > 4800 && Math.abs(z.endMs - z.startMs - 1600) < 1, [z.startMs, z.endMs])
    check('drag sets edited on that block only', z.edited && !zoom('a').edited && !zoom('c').edited)

    b = await blockBox(1)
    await drag(page, { x: b.r - 3, y: b.y }, { x: b.r + 400, y: b.y })
    await settled()
    z = zoom('b')
    check('stretching an end stops at the neighbour', z.endMs === 7000, z.endMs)

    b = await blockBox(1)
    await drag(page, { x: b.l + 3, y: b.y }, { x: b.r, y: b.y })
    await settled()
    z = zoom('b')
    check('stretching enforces the minimum length', z.endMs - z.startMs === 500, z.endMs - z.startMs)
    check('a short block still reaches full zoom', z.easeInMs + z.easeOutMs <= 500, [z.easeInMs, z.easeOutMs])

    b = await blockBox(0)
    await drag(page, { x: (b.l + b.r) / 2, y: b.y }, { x: 0, y: b.y })
    await settled()
    check('dragging clamps to the recording', zoom('a').startMs === 0, zoom('a').startMs)

    await key(page, 'z', META)
    await key(page, 'z', META)
    await sleep(100)
    await key(page, 'z', META)
    await key(page, 'z', META)
    await settled()
    z = zoom('b')
    check('Cmd+Z undoes one gesture at a time', z.startMs === 4800 && z.endMs === 6400 && zoom('a').startMs === 1000, [zoom('a').startMs, z.startMs, z.endMs])
    await key(page, 'z', META | SHIFT)
    await settled()
    check('Cmd+Shift+Z redoes', zoom('b').startMs > 4800 && zoom('b').endMs - zoom('b').startMs === 1600, zoom('b').startMs)

    await click(page, (await blockBox(2)).l + 40, (await blockBox(2)).y)
    await key(page, 'Delete')
    await settled()
    check('Delete removes the selected block', (await blocks()) === 3 && !zoom('c'))
    await key(page, 'z', META)
    await settled()
    check('undo brings it back', (await blocks()) === 4 && !!zoom('c'))
    await key(page, 'Escape')

    const t = await seekTo(page, 500, DURATION)
    check('clicking the ruler moves the playhead', Math.abs(t - 500) < 40, Math.round(t))
    const addEnabled = !(await page.js(`document.querySelector('.tl-top .ghost').disabled`))
    await seekTo(page, 2000, DURATION)
    const addInBlock = await page.js(`document.querySelector('.tl-top .ghost').disabled`)
    check('+ Add zoom is off inside a block and on in a gap', addEnabled && addInBlock)
    await seekTo(page, 500, DURATION)
    const gapBox = await rect('.tl-top .ghost')
    await click(page, gapBox.x, gapBox.y)
    await settled()
    const added = disk().zooms.find((s) => s.origin === 'manual')
    check('+ Add zoom adds a manual block, fitted to the gap', !!added && added.edited && added.startMs === 0 && added.endMs === 1000, added && [Math.round(added.startMs), Math.round(added.endMs)])
    const overlap = (zs) => [...zs].sort((p, q) => p.startMs - q.startMs).some((s, i, a) => i > 0 && s.startMs < a[i - 1].endMs)
    check('no blocks overlap after all of that', !overlap(disk().zooms))

    const before = await tcText()
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 10 })
    await page.js(`document.activeElement?.blur()`)
    await key(page, ' ')
    await sleep(1200)
    const during = await tcText()
    await key(page, ' ')
    await sleep(200)
    const paused = await tcText()
    await sleep(400)
    check('Space plays and pauses', during !== before && (await tcText()) === paused, [before, during, paused])

    await seekTo(page, (added.startMs + added.endMs) / 2, DURATION)
    const dot = await rect('.focus-dot')
    await drag(page, { x: dot.x, y: dot.y }, { x: dot.x - 120, y: dot.y + 60 })
    await settled()
    const moved = disk().zooms.find((s) => s.id === added.id)
    check('dragging the dot moves the zoom focus', moved.focus.x !== added.focus.x && moved.focus.y !== added.focus.y, moved.focus)

    await sliderTo('level', 0.75)
    await settled()
    check('Level slider sets the block', disk().zooms.find((s) => s.id === added.id).level > 2.5, disk().zooms.find((s) => s.id === added.id).level)
    await sliderTo('ease in', 0.1)
    await settled()
    check('Ease slider sets the block', disk().zooms.find((s) => s.id === added.id).easeInMs < 400, disk().zooms.find((s) => s.id === added.id).easeInMs)

    // The added block touches the next one, so the camera pans between two levels here
    const panT = await seekTo(page, 1300, DURATION)
    const zs = [...disk().zooms].sort((p, q) => p.startMs - q.startMs)
    const panned = aimAt(zs, zs[1], { at: () => ({ x: 0, y: 0 }), clicks: [] }, 2880, 1800, panT).level
    const tag = await page.js(`document.querySelector('.zoomtag')?.textContent ?? null`)
    check('the zoom tag shows the level in between during a pan', tag === `${panned.toFixed(1)}×` && panned > 2 && panned < zs[0].level, [tag, +panned.toFixed(2), zs[0].level])
    await seekTo(page, 500, DURATION)

    await openTool('Look')
    await sleep(150)
    await page.js(`document.querySelectorAll('.swatch')[2].click()`)
    await sliderTo('padding', 0.9)
    await sliderTo('corner radius', 0.8)
    await sliderTo('shadow', 0.1)
    await settled()
    let look = disk().look
    check('Look saves wallpaper, padding, radius and shadow', look.background.id === 'ocean' && look.paddingPct > 12 && look.cornerRadiusPct > 4 && look.shadow < 0.3, look)
    await screenshot(page, 'ui-look.png')
    await key(page, 'z', META)
    await settled()
    check('a whole slider drag is one undo step', disk().look.shadow === 0.5 && disk().look.cornerRadiusPct === look.cornerRadiusPct, disk().look.shadow)

    await openTool('Cursor')
    await sleep(150)
    await sliderTo('smoothness', 1)
    await settled()
    let cursor = disk().cursor
    check('Smoothness loosens the spring and keeps its ratio', cursor.stiffness < 60 && Math.abs(cursor.damping / Math.sqrt(cursor.stiffness) - 26 / Math.sqrt(170)) < 0.01, cursor)
    await sliderTo('size', 0.9)
    await page.js(`document.querySelectorAll('.panel [role=switch]')[1].click()`)
    await page.js(`document.querySelectorAll('.panel [role=switch]')[0].click()`)
    await settled()
    cursor = disk().cursor
    check('Cursor saves smooth, ripple and size', cursor.smooth === false && cursor.clickRipple === false && cursor.scale > 1.5, cursor)
    check('Smoothness is off with smoothing off', await page.js(`document.querySelector('.panel input[type=range]').disabled`))

    const sheetFor = async (code) => {
      await page.js(code)
      await sleep(150)
      const title = await page.js(`document.querySelector('.dolly-sheet h2')?.textContent ?? null`)
      await page.js(`document.querySelector('.dolly-sheet-scrim')?.click()`)
      await sleep(100)
      return title
    }
    const seg = (label) => `[...document.querySelectorAll('.ship .seg button')].find((n) => n.textContent.startsWith('${label}')).click()`
    const tool = (label) => `[...document.querySelectorAll('.tools button')].find((n) => n.textContent.startsWith('${label}')).click()`
    await openTool('Look')
    await sleep(100)
    const locked = {
      'The webcam bubble is in Dolly Pro': tool('Webcam'),
      'Captions are in Dolly Pro': tool('Captions'),
      'The vertical cut is in Dolly Pro': `document.querySelector('.fmt.c .check').click()`,
      'GIF export is in Dolly Pro': seg('GIF'),
      '4K export is in Dolly Pro': seg('4K'),
      '60 fps export is in Dolly Pro': seg('60'),
      'Your own backgrounds are in Dolly Pro': `[...document.querySelectorAll('.panel .ghost')].find((n) => n.textContent.includes('Your own image')).click()`
    }
    for (const [title, code] of Object.entries(locked)) check(`locked control opens: ${title}`, (await sheetFor(code)) === title)
    check('Vertical is dimmed and says Preview only', await page.js(`document.querySelector('.fmt.c').classList.contains('locked') && document.querySelector('.fmt.c .unlock').textContent === 'Preview only'`))
    check('Space does nothing behind the sheet', await (async () => {
      await page.js(tool('Webcam'))
      await sleep(120)
      const a = await tcText()
      await key(page, ' ')
      await sleep(400)
      const same = (await tcText()) === a
      await page.js(`document.querySelector('.dolly-sheet-scrim').click()`)
      return same
    })())

    await page.js(`document.querySelector('.fmt.b .check').click()`)
    await sleep(100)
    check('unticking updates the count', (await shipText()).includes('Export 1 file'))
    await page.js(`document.querySelector('.fmt.a .check').click()`)
    await sleep(100)
    check('nothing ticked disables Export', await page.js(`document.querySelector('.ship .primary').disabled`))
    await page.js(`document.querySelector('.fmt.a .check').click()`)
    await sleep(100)
    await page.js(`document.querySelector('.ship .primary').click()`)
    await sleep(900)
    const running = await shipText()
    check('export shows per-file progress', /LANDSCAPE · \d+%/.test(running), running.slice(0, 40))
    check('leaving is blocked while exporting', await page.js(`[...document.querySelectorAll('.bar .ghost')].find((n) => n.textContent === 'Record again').disabled`))
    await page.js(`[...document.querySelectorAll('.ship .ghost')].find((n) => n.textContent === 'Cancel').click()`)
    await sleep(800)
    check('Cancel returns to the options', (await shipText()).includes('Export 1 file'))

    // Narrow, then back
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 720, deviceScaleFactor: 2, mobile: false })
    await sleep(500)
    const tabs = await page.js(`[...document.querySelectorAll('.tabs button')].map((n) => n.textContent)`)
    const shown = await page.js(`[...document.querySelectorAll('.fmt')].filter((n) => !n.hidden).length`)
    check('below 1100 px the previews are tabs', tabs.length === 3 && shown === 1, tabs)
    await page.js(`document.querySelectorAll('.tabs button')[2].click()`)
    await sleep(300)
    check('a tab shows its shape, drawn', await page.js(`(() => { const f = document.querySelector('.fmt.c'); return !f.hidden && f.querySelector('canvas').clientWidth > 0 })()`))
    await page.js(`document.querySelectorAll('.tabs button')[0].click()`)
    await sleep(800)
    await screenshot(page, 'ui-1000.png')
    check('nothing overflows at 1000 px', await page.js(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.ship').scrollWidth <= document.querySelector('.ship').clientWidth && document.querySelector('.bar').scrollWidth <= document.querySelector('.bar').clientWidth`))
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 2, mobile: false })
    await sleep(400)
    check('nothing overflows at the 1100 x 700 minimum', await page.js(`(() => { const last = [...document.querySelectorAll('.fmt .frame')].pop().getBoundingClientRect(); return last.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth })()`))
    await page.send('Emulation.clearDeviceMetricsOverride')
    await sleep(400)

    // Pro, and the main-process events the UI answers to
    await mainJs(`(() => {
      const { ipcMain, BrowserWindow } = require('electron')
      const fs = require('node:fs')
      const send = (channel, event) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')).webContents.send(channel, event)
      const swap = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
      globalThis.__test = { failStart: true, failCaptions: false, generated: 0, send }
      swap('license:status', () => ({ plan: 'pro' }))
      swap('capture:permissions', () => ({ screen: 'granted', 'input-monitoring': 'granted', microphone: 'granted', camera: 'granted' }))
      swap('capture:start', async () => {
        if (globalThis.__test.failStart) { globalThis.__test.failStart = false; throw new Error('Display 7 is gone') }
        setTimeout(() => send('capture:event', { type: 'started', projectDir: ${JSON.stringify(dir)}, warnings: ['Clicks are not being recorded, so this recording has no automatic zooms. Allow Input Monitoring for Dolly to fix that.'] }), 50)
      })
      swap('capture:stop', async () => { setTimeout(() => send('capture:event', { type: 'stopped', projectId: 'Launch demo' }), 50) })
      swap('captions:generate', async (_, projectDir) => {
        if (globalThis.__test.failCaptions) throw new Error('Captions are still running for another recording.')
        globalThis.__test.generated++
        send('captions:event', { type: 'progress', pct: 40 })
        await new Promise((r) => setTimeout(r, 600))
        const file = projectDir + '/project.json'
        const project = JSON.parse(fs.readFileSync(file, 'utf8'))
        project.captions = [{ id: 'g1', startMs: 1000, endMs: 3000, text: 'Generated line ' + globalThis.__test.generated }, { id: 'g2', startMs: 3200, endMs: 5000, text: 'Second line' }]
        fs.writeFileSync(file, JSON.stringify(project))
        send('captions:event', { type: 'done', projectDir })
      })
      return true
    })()`)
    await page.send('Page.reload')
    await sleep(1500)
    await page.js(`document.querySelector('.record').click()`)
    await sleep(3600)
    check('capture.start rejecting shows its message without the IPC wrapper', (await page.js(`document.querySelector('.error')?.textContent ?? null`)) === 'Display 7 is gone', await page.js(`document.querySelector('.error')?.textContent ?? null`))
    await page.js(`document.querySelector('.record').click()`)
    await sleep(600)
    check('countdown shows and Record goes to Cancel', (await page.js(`document.querySelector('.count')?.textContent`)) === '3', await page.js(`document.querySelector('.count')?.textContent`))
    await sleep(3200)
    const during2 = await page.js(`document.querySelector('.rec-overlay').innerText`)
    check('Home shows capture warnings while recording', during2.includes('no automatic zooms') && during2.includes('Stop'))
    await page.js(`[...document.querySelectorAll('.rec-overlay button')].find((n) => n.textContent === 'Stop').click()`)
    await sleep(2500)
    check('stopping opens the editor', await page.js(`!!document.querySelector('.app .fmt')`))
    check('the warning carries into the editor in full', (await page.js(`document.querySelector('.notices').innerText`)).includes('Allow Input Monitoring for Dolly to fix that.'))
    await screenshot(page, 'ui-warning.png')
    await page.js(`document.querySelector('.notices button').click()`)
    await sleep(800)

    check('Pro shows no badges', (await page.js(`document.querySelectorAll('.pro').length`)) === 0)
    check('Vertical is live and undimmed on Pro', await page.js(`!document.querySelector('.fmt.locked') && !document.querySelector('.unlock')`))
    await page.js(`document.querySelector('.fmt.c .check').click()`)
    await sleep(100)
    check('Vertical ticks on Pro', (await shipText()).includes('Export 2 files') || (await shipText()).includes('Export 3 files'), (await shipText()).slice(-16))
    await page.js(seg('GIF'))
    await sleep(100)
    check('GIF turns off resolution and frame rate', await page.js(`[...document.querySelectorAll('.ship .seg button')].find((n) => n.textContent.startsWith('4K')).disabled`))
    await page.js(seg('MP4'))
    await sleep(100)
    await page.js(seg('4K'))
    await page.js(seg('60'))
    await settled()
    check('4K and 60 stick on Pro', disk().output.resolution === '4k' && disk().output.fps === 60)

    const project = disk()
    const webT = await seekTo(page, 500, DURATION)
    await sleep(700)
    await page.js(`(() => { const s = document.createElement('style'); s.textContent = '.zoomtag{display:none!important}'; document.head.append(s) })()`)
    for (const [shape, selector] of [['16:9', '.fmt.a'], ['1:1', '.fmt.b'], ['9:16', '.fmt.c']]) {
      const box = await page.js(`(() => { const c = document.querySelector('${selector} canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, bw: c.width, bh: c.height } })()`)
      const { bw, bh, ...shotBox } = box
      const png = decodePng(await screenshot(page, null, shotBox))
      const spec = compose(project, { at: () => ({ x: 0, y: 0 }), clicks: [] }, shape, { width: bw, height: bh }, webT, { webcam: true, captions: true })
      const { rect: r } = spec.webcam
      const scale = png.width / bw
      const [red, green, blue] = png.at(Math.round((r.x + r.w / 2) * scale), Math.round((r.y + r.h / 2) * scale))
      check(`webcam bubble draws where compose() says, ${shape}`, red > 230 && green > 100 && green < 150 && blue < 40, [red, green, blue])
    }
    await screenshot(page, 'ui-pro.png')

    await openTool('Webcam')
    await sleep(150)
    await page.js(`document.querySelector('.corner.tl').click()`)
    await page.js(`[...document.querySelectorAll('.panel .seg button')].find((n) => n.textContent === 'Rounded').click()`)
    await settled()
    check('Webcam saves shape and corner', disk().webcam.corner === 'tl' && disk().webcam.shape === 'rounded', disk().webcam)

    await openTool('Captions')
    await sleep(150)
    await page.js(`[...document.querySelectorAll('.panel .ghost')].find((n) => n.textContent === 'Generate again').click()`)
    await sleep(100)
    check('regenerating warns before replacing edits', (await page.js(`document.querySelector('.panel').innerText`)).includes('including your edits'))
    await page.js(`[...document.querySelectorAll('.panel .ghost')].find((n) => n.textContent === 'Keep my lines').click()`)
    await sleep(100)
    check('Keep my lines changes nothing', disk().captions[0].id === 'c1' && (await mainJs(`globalThis.__test.generated`)) === 0)
    await page.js(`[...document.querySelectorAll('.panel .ghost')].find((n) => n.textContent === 'Generate again').click()`)
    await sleep(100)
    await page.js(`[...document.querySelectorAll('.panel .primary')].find((n) => n.textContent === 'Replace').click()`)
    await sleep(250)
    check('leaving is blocked while captions run', await page.js(`[...document.querySelectorAll('.bar .ghost')].find((n) => n.textContent === 'Record again').disabled`))
    await sleep(1000)
    check('captions reload from disk when done', (await page.js(`[...document.querySelectorAll('.caption-lines input')].map((i) => i.value).join('|')`)) === 'Generated line 1|Second line', await page.js(`[...document.querySelectorAll('.caption-lines input')].map((i) => i.value).join('|')`))
    await sleep(1400)
    check('a later save keeps them', disk().captions.length === 2 && disk().captions[0].id === 'g1', disk().captions.map((c) => c.text))
    const line = await rect('.caption-lines input')
    await click(page, line.x, line.y)
    await page.send('Input.insertText', { text: 'Hand ' })
    await sleep(100)
    await page.js(`document.activeElement.blur()`)
    await settled()
    check('editing a line saves', disk().captions.some((c) => c.text.includes('Hand ')), disk().captions.map((c) => c.text))
    const blocksBefore = await blocks()
    const firstBlock = await blockBox(0)
    await click(page, firstBlock.l + 30, firstBlock.y)
    await openTool('Captions')
    await sleep(150)
    const field = await rect('.caption-lines input')
    await click(page, field.x, field.y)
    await key(page, 'Delete')
    await sleep(200)
    check('Delete in a caption field leaves the blocks alone', (await blocks()) === blocksBefore, await blocks())
    await page.js(`document.activeElement.blur()`)
    await mainJs(`globalThis.__test.failCaptions = true`)
    await page.js(`[...document.querySelectorAll('.panel .ghost')].find((n) => n.textContent === 'Generate again').click()`)
    await sleep(100)
    await page.js(`[...document.querySelectorAll('.panel .primary')].find((n) => n.textContent === 'Replace').click()`)
    await sleep(500)
    check('a refused job says why', (await page.js(`document.querySelector('.panel-note.error')?.textContent ?? null`)) === 'Captions are still running for another recording.', await page.js(`document.querySelector('.panel-note.error')?.textContent ?? null`))
    check('autosave resumes after a refused job', await (async () => {
      const input = await rect('.caption-lines input')
      await click(page, input.x, input.y)
      await page.send('Input.insertText', { text: 'After ' })
      await page.js(`document.activeElement.blur()`)
      await settled()
      return disk().captions.some((c) => c.text.includes('After '))
    })())
    await screenshot(page, 'ui-captions.png')

    await page.js(`[...document.querySelectorAll('.bar .ghost')].find((n) => n.textContent === 'Record again').click()`)
    await sleep(600)
    check('Record again goes Home, saved', await page.js(`!!document.querySelector('.home')`))
    await mainJs(`globalThis.__test.send('capture:event', { type: 'error', message: 'The capture helper stopped.' })`)
    await sleep(200)
    check('an error after starting shows on Home', (await page.js(`document.querySelector('.error')?.textContent ?? null`)) === 'The capture helper stopped.')
    await page.js(`[...document.querySelectorAll('.bar .ghost')].find((n) => n.textContent === 'Settings').click()`)
    await sleep(250)
    check('Settings holds the license field', await page.js(`/license/i.test(document.querySelector('.settings-card').innerText)`))

    log('problems', JSON.stringify(page.problems))
    const failed = results.filter((r) => !r).length
    log(`${results.length - failed} of ${results.length} passed`)
  } finally {
    await app.stop()
  }
}
