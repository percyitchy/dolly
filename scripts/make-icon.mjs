// Draws the Dolly mark and writes build/icon.png, build/icon.icns and build/icon.ico.
// No dependencies. The .icns step needs macOS for iconutil. Output is committed, so this only runs when the mark changes.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const INK = [0x0f, 0x12, 0x17]
const DOT = [0xf0, 0x43, 0x2a]

// Proportions of .mark in concepts/shared/tokens.css: 20px square, radius 6, dot 7
const RADIUS = 6 / 20
const DOT_DIAMETER = 7 / 20

// macOS icons sit on Apple's grid, 824 of 1024. Windows icons fill the frame
const MAC_BODY = 824 / 1024
const WIN_BODY = 1

function roundedSquareDistance(x, y, half, radius) {
  const qx = Math.abs(x) - half + radius
  const qy = Math.abs(y) - half + radius
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

// RGBA pixels. Coverage comes from the signed distance, so edges stay clean at 16 px
function render(size, body) {
  const half = (size * body) / 2
  const radius = size * body * RADIUS
  const dotRadius = (size * body * DOT_DIAMETER) / 2
  const pixels = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const x = col + 0.5 - size / 2
      const y = row + 0.5 - size / 2
      const square = Math.min(Math.max(0.5 - roundedSquareDistance(x, y, half, radius), 0), 1)
      const dot = Math.min(Math.max(0.5 - (Math.hypot(x, y) - dotRadius), 0), 1)
      const at = (row * size + col) * 4
      for (let channel = 0; channel < 3; channel++) {
        pixels[at + channel] = Math.round(INK[channel] + (DOT[channel] - INK[channel]) * dot)
      }
      pixels[at + 3] = Math.round(square * 255)
    }
  }
  return pixels
}

function pngChunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function png(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // Bits per channel
  header[9] = 6 // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let row = 0; row < size; row++) {
    pixels.copy(rows, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// Classic bottom-up BGRA bitmap with an empty AND mask. NSIS and old Explorer views read these reliably
function dib(size, pixels) {
  const maskRow = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20)
  const bgra = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const from = (row * size + col) * 4
      const to = ((size - 1 - row) * size + col) * 4
      bgra[to] = pixels[from + 2]
      bgra[to + 1] = pixels[from + 1]
      bgra[to + 2] = pixels[from]
      bgra[to + 3] = pixels[from + 3]
    }
  }
  return Buffer.concat([header, bgra, Buffer.alloc(maskRow * size)])
}

function ico(sizes) {
  const images = sizes.map((size) => {
    const pixels = render(size, WIN_BODY)
    return { size, data: size === 256 ? png(size, pixels) : dib(size, pixels) }
  })
  const directory = Buffer.alloc(6 + 16 * images.length)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16
    directory[entry] = size === 256 ? 0 : size
    directory[entry + 1] = size === 256 ? 0 : size
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([directory, ...images.map(({ data }) => data)])
}

function icns() {
  const temp = mkdtempSync(join(tmpdir(), 'dolly-icon-'))
  const iconset = join(temp, 'icon.iconset')
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${size}x${size}.png`), png(size, render(size, MAC_BODY)))
    writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), png(size * 2, render(size * 2, MAC_BODY)))
  }
  const run = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(out, 'icon.icns')], { stdio: 'inherit' })
  rmSync(temp, { recursive: true, force: true })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`iconutil exited with ${run.status}`)
}

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), png(1024, render(1024, MAC_BODY)))
writeFileSync(join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))
icns()
console.log(`Wrote icon.png, icon.ico and icon.icns to ${out}`)
