/**
 * Generates the PNG icons in resources/ without any image dependency:
 * a minimal PNG encoder (zlib + CRC32) drawing a filled circle with a mic dot.
 * Run: node scripts/generate-icons.js
 */
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** pixelFn(x, y) -> [r, g, b, a] */
function encodePng(size, pixelFn) {
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const o = row + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** Filled circle of `color` with a white mic dot + stand, anti-aliased edges. */
function circleIcon(size, [r, g, b]) {
  const c = (size - 1) / 2
  const radius = size * 0.46
  return encodePng(size, (x, y) => {
    const d = Math.hypot(x - c, y - c)
    const edge = radius - d // >0 inside
    if (edge < -0.5) return [0, 0, 0, 0]
    const alpha = Math.round(Math.max(0, Math.min(1, edge + 0.5)) * 255)

    // white mic: rounded capsule in the upper-middle + a small stand line
    const mw = size * 0.11
    const capTop = size * 0.28
    const capBottom = size * 0.52
    const inCapsule =
      Math.abs(x - c) <= mw &&
      y >= capTop - mw &&
      y <= capBottom + mw &&
      (y >= capTop && y <= capBottom
        ? true
        : Math.hypot(x - c, y - (y < capTop ? capTop : capBottom)) <= mw)
    const inStand =
      Math.abs(x - c) <= size * 0.02 && y > capBottom + mw && y <= size * 0.68
    const inBase = Math.abs(x - c) <= size * 0.13 && Math.abs(y - size * 0.7) <= size * 0.02

    if (inCapsule || inStand || inBase) return [255, 255, 255, alpha]
    return [r, g, b, alpha]
  })
}

const out = path.join(__dirname, '..', 'resources')
fs.mkdirSync(out, { recursive: true })

const COLORS = {
  idle: [79, 110, 247], // blue
  recording: [229, 72, 77], // red
  processing: [245, 166, 35] // amber
}

for (const [name, color] of Object.entries(COLORS)) {
  fs.writeFileSync(path.join(out, `tray-${name}.png`), circleIcon(32, color))
  fs.writeFileSync(path.join(out, `tray-${name}@2x.png`), circleIcon(64, color))
}
fs.writeFileSync(path.join(out, 'icon.png'), circleIcon(512, COLORS.idle))
console.log('Icons generated in resources/')
