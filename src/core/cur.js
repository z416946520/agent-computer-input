/**
 * agent-computer-input · Windows 光标文件解码
 *
 * 纯 Node（零依赖）实现：
 *   - .cur / .ico：ICONDIR 解析、PNG 条目直通、DIB（BMP）条目解码成 RGBA
 *   - .ani：RIFF/ACON 解析（anih / rate / seq / LIST fram + icon 帧）
 *   - PNG 编码（RGBA8，zlib deflate），用来把光标帧落成覆盖层能直接画的文件
 *
 * 为什么自己写：覆盖层是 WinForms，能读 PNG/ICO 但拿不到「最大帧 + 热点」；
 * 而原项目的 24 帧 sprite sheet 方案需要预先由外部工具烘焙。这里改成
 * 「运行时从 .cur/.ani 解码 → 生成按主题分目录的 PNG + manifest」，
 * 换光标素材只改一个目录，不需要重新烘焙或改代码。
 */

import { inflateSync, deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export class CursorFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CursorFormatError'
  }
}

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* -------------------------------------------------------------- PNG 编码 */

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * RGBA8 → PNG。filter 全 0（None），不做行内启发式，光标都是小图，体积无所谓。
 * @param {{width:number,height:number,data:Buffer}} rgba
 * @param {{level?:number}} [options]
 * @returns {Buffer}
 */
export function encodePng(rgba, options = {}) {
  const { width, height, data } = rgba
  if (!width || !height) throw new CursorFormatError('encodePng: 宽高必须 > 0')
  if (data.length !== width * height * 4) {
    throw new CursorFormatError(`encodePng: 像素长度不符（期望 ${width * height * 4}，实际 ${data.length}）`)
  }
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace
  const idat = deflateSync(raw, { level: options.level ?? 9 })
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* --------------------------------------------------------- PNG 解码（够用版） */

/**
 * 覆盖层自己解码用不到，但构建脚本要读素材包里的 PNG 预览、测试要比对像素，
 * 所以留一个只支持 8bit RGB/RGBA + filter 0..4 的最小 PNG 解码器。
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new CursorFormatError('不是 PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  let bitDepth = 8
  let interlace = 0
  let palette = null
  let transparency = null
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
  }
  if (!width || !height) throw new CursorFormatError('PNG 缺 IHDR')
  if (bitDepth !== 8) throw new CursorFormatError(`只支持 8bit PNG（实际 ${bitDepth}）`)
  if (interlace !== 0) throw new CursorFormatError('不支持隔行 PNG')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new CursorFormatError(`不支持的 PNG colorType=${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++]
    const line = Buffer.from(raw.subarray(cursor, cursor + stride))
    cursor += stride
    unfilter(filter, line, prev, channels)
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4
      if (colorType === 6) {
        out[to] = line[x * 4]
        out[to + 1] = line[x * 4 + 1]
        out[to + 2] = line[x * 4 + 2]
        out[to + 3] = line[x * 4 + 3]
      } else if (colorType === 2) {
        out[to] = line[x * 3]
        out[to + 1] = line[x * 3 + 1]
        out[to + 2] = line[x * 3 + 2]
        out[to + 3] = 255
      } else if (colorType === 0) {
        out[to] = out[to + 1] = out[to + 2] = line[x]
        out[to + 3] = 255
      } else if (colorType === 4) {
        out[to] = out[to + 1] = out[to + 2] = line[x * 2]
        out[to + 3] = line[x * 2 + 1]
      } else if (colorType === 3) {
        const index = line[x]
        out[to] = palette ? palette[index * 3] : 0
        out[to + 1] = palette ? palette[index * 3 + 1] : 0
        out[to + 2] = palette ? palette[index * 3 + 2] : 0
        out[to + 3] = transparency && index < transparency.length ? transparency[index] : 255
      }
    }
    line.copy(prev)
  }
  return { width, height, data: out }
}

function unfilter(filter, line, prev, bpp) {
  const n = line.length
  if (filter === 0) return
  if (filter === 1) {
    for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff
    return
  }
  if (filter === 2) {
    for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff
    return
  }
  if (filter === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? line[i - bpp] : 0
      line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff
    }
    return
  }
  if (filter === 4) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      line[i] = (line[i] + paeth(a, b, c)) & 0xff
    }
    return
  }
  throw new CursorFormatError(`未知 PNG filter=${filter}`)
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/* ------------------------------------------------------------- ICO / CUR */

function readIconDir(buffer, kind) {
  if (buffer.length < 6) throw new CursorFormatError(`${kind}: 文件太短`)
  const reserved = buffer.readUInt16LE(0)
  const type = buffer.readUInt16LE(2)
  const count = buffer.readUInt16LE(4)
  if (reserved !== 0) throw new CursorFormatError(`${kind}: reserved 不是 0`)
  const expected = kind === 'cur' ? 2 : 1
  if (type !== 1 && type !== 2) throw new CursorFormatError(`${kind}: 未知 type=${type}`)
  // .ico 也可能带热点字段（type=1 却没有），所以按 16 字节游走时用 type 判定是否读热点。
  const isCursor = type === 2 || expected === 2
  const entrySize = 16
  if (6 + count * entrySize > buffer.length) throw new CursorFormatError(`${kind}: 目录越界`)
  const entries = []
  for (let i = 0; i < count; i++) {
    const base = 6 + i * entrySize
    const width = buffer[base] === 0 ? 256 : buffer[base]
    const height = buffer[base + 1] === 0 ? 256 : buffer[base + 1]
    const colorCount = buffer[base + 2]
    const hotspotX = isCursor ? buffer.readUInt16LE(base + 4) : 0
    const hotspotY = isCursor ? buffer.readUInt16LE(base + 6) : 0
    const bitCount = isCursor ? 0 : buffer.readUInt16LE(base + 6)
    const bytes = buffer.readUInt32LE(base + 8)
    const offset = buffer.readUInt32LE(base + 12)
    if (offset + bytes > buffer.length) throw new CursorFormatError(`${kind}: 条目 ${i} 数据越界`)
    entries.push({
      index: i,
      width,
      height,
      colorCount,
      bitCount,
      hotspotX,
      hotspotY,
      offset,
      bytes,
      data: buffer.subarray(offset, offset + bytes),
    })
  }
  return { type, isCursor, entries }
}

function decodeDibEntry(entry, headerOffset = 0) {
  const data = entry.data
  const base = headerOffset
  if (data.length < base + 40) throw new CursorFormatError('DIB: 头部太短')
  const headerSize = data.readUInt32LE(base)
  if (headerSize < 40) throw new CursorFormatError(`DIB: 不支持的 headerSize=${headerSize}`)
  const width = data.readInt32LE(base + 4)
  const heightRaw = data.readInt32LE(base + 8)
  const planes = data.readUInt16LE(base + 12)
  const bitCount = data.readUInt16LE(base + 14)
  const compression = data.readUInt32LE(base + 16)
  if (compression !== 0) throw new CursorFormatError(`DIB: 不支持的压缩方式 ${compression}`)
  if (planes !== 1) throw new CursorFormatError(`DIB: planes=${planes}`)
  // ICO/CUR 里高度是 XOR + AND 两段之和
  const hasMask = heightRaw === (entry.height ?? 0) * 2 || heightRaw === width * 2
  const height = hasMask ? heightRaw / 2 : heightRaw
  if (!width || !height) throw new CursorFormatError('DIB: 宽高为 0')

  const paletteBytes = bitCount <= 8 ? (1 << bitCount) * 4 : 0
  const xorStride = Math.ceil((width * bitCount) / 32) * 4
  const xorBytes = xorStride * height
  const andStride = Math.ceil(width / 32) * 4
  const andBytes = hasMask ? andStride * height : 0
  const start = base + headerSize + paletteBytes
  if (start + xorBytes > data.length) throw new CursorFormatError('DIB: 像素数据越界')
  const palette = []
  for (let i = 0; i < paletteBytes / 4; i++) {
    const p = base + headerSize + i * 4
    palette.push([data[p + 2], data[p + 1], data[p]])
  }

  const out = Buffer.alloc(width * height * 4)
  const alphaUsed = { value: false }
  for (let y = 0; y < height; y++) {
    const srcRow = start + (height - 1 - y) * xorStride
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4
      let r = 0
      let g = 0
      let b = 0
      let a = 255
      if (bitCount === 32) {
        const p = srcRow + x * 4
        b = data[p]
        g = data[p + 1]
        r = data[p + 2]
        a = data[p + 3]
        if (a !== 0) alphaUsed.value = true
      } else if (bitCount === 24) {
        const p = srcRow + x * 3
        b = data[p]
        g = data[p + 1]
        r = data[p + 2]
      } else if (bitCount === 8 || bitCount === 4 || bitCount === 1) {
        let index
        if (bitCount === 8) index = data[srcRow + x]
        else if (bitCount === 4) {
          const byte = data[srcRow + (x >> 1)]
          index = x % 2 === 0 ? byte >> 4 : byte & 0x0f
        } else {
          const byte = data[srcRow + (x >> 3)]
          index = (byte >> (7 - (x % 8))) & 1
        }
        const color = palette[index] || [0, 0, 0]
        r = color[0]
        g = color[1]
        b = color[2]
      } else {
        throw new CursorFormatError(`DIB: 不支持 ${bitCount}bpp`)
      }
      out[to] = r
      out[to + 1] = g
      out[to + 2] = b
      out[to + 3] = a
    }
  }

  // AND mask：32bpp 且 alpha 全 0 的老素材靠它做透明
  if (hasMask) {
    const maskStart = start + xorBytes
    for (let y = 0; y < height; y++) {
      const srcRow = maskStart + (height - 1 - y) * andStride
      for (let x = 0; x < width; x++) {
        const bit = (data[srcRow + (x >> 3)] >> (7 - (x % 8))) & 1
        const to = (y * width + x) * 4
        if (bit === 1) out[to + 3] = 0
        else if (!alphaUsed.value) out[to + 3] = 255
      }
    }
  }

  return { width, height, data: out, bitCount }
}

function decodeEntry(entry) {
  const data = entry.data
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const png = decodePng(data)
    return { width: png.width, height: png.height, data: png.data, format: 'png' }
  }
  return { ...decodeDibEntry(entry), format: 'dib' }
}

/**
 * 解析 .cur / .ico，返回全部帧（按尺寸升序）。
 * @param {Buffer} buffer
 * @param {'cur'|'ico'} [kind]
 */
export function parseIconFile(buffer, kind = 'cur') {
  const dir = readIconDir(buffer, kind)
  const frames = []
  for (const entry of dir.entries) {
    const decoded = decodeEntry(entry)
    frames.push({
      width: decoded.width,
      height: decoded.height,
      format: decoded.format,
      bitCount: decoded.bitCount ?? null,
      hotspotX: entry.hotspotX,
      hotspotY: entry.hotspotY,
      declaredWidth: entry.width,
      declaredHeight: entry.height,
      data: decoded.data,
    })
  }
  frames.sort((a, b) => a.width * a.height - b.width * b.height)
  if (!frames.length) throw new CursorFormatError(`${kind}: 没有任何帧`)
  return { type: dir.type, cursor: dir.isCursor, frames }
}

/**
 * 取最大帧，并把热点按「最大帧 / 声明尺寸」的比例算出来（有些素材热点只在 32px 上写对）。
 */
export function bestFrame(buffer, kind = 'cur') {
  const parsed = parseIconFile(buffer, kind)
  const frame = parsed.frames[parsed.frames.length - 1]
  return {
    ...frame,
    hotspotX: frame.hotspotX,
    hotspotY: frame.hotspotY,
    hotspotRatio: {
      x: frame.width ? frame.hotspotX / (frame.declaredWidth || frame.width) : 0,
      y: frame.height ? frame.hotspotY / (frame.declaredHeight || frame.height) : 0,
    },
    frameCount: parsed.frames.length,
    sizes: parsed.frames.map((f) => `${f.width}x${f.height}`),
  }
}

/* --------------------------------------------------------------------- ANI */

function readChunks(buffer, start, end) {
  const chunks = []
  let offset = start
  while (offset + 8 <= end) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    if (dataStart + size > end) break
    chunks.push({ id, size, start: dataStart, end: dataStart + size })
    offset = dataStart + size + (size % 2)
  }
  return chunks
}

function findChunk(chunks, id) {
  return chunks.find((c) => c.id === id) || null
}

/**
 * 解析 .ani（RIFF/ACON），返回 { frames:[{data,w,h}], rates:[ms], steps, size }
 */
export function parseAni(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'ACON') {
    throw new CursorFormatError('ANI: 不是 RIFF/ACON')
  }
  const riffSize = buffer.readUInt32LE(4)
  const riffEnd = Math.min(buffer.length, 8 + riffSize)
  const chunks = readChunks(buffer, 12, riffEnd)

  const anih = findChunk(chunks, 'anih')
  let header = null
  if (anih) {
    header = {
      size: buffer.readUInt32LE(anih.start),
      frames: buffer.readUInt32LE(anih.start + 4),
      steps: buffer.readUInt32LE(anih.start + 8),
      width: buffer.readUInt32LE(anih.start + 12),
      height: buffer.readUInt32LE(anih.start + 16),
      bitCount: buffer.readUInt32LE(anih.start + 20),
      planes: buffer.readUInt32LE(anih.start + 24),
      displayRate: buffer.readUInt32LE(anih.start + 28),
      flags: buffer.readUInt32LE(anih.start + 32),
    }
  }

  const rateChunk = findChunk(chunks, 'rate')
  const rates = []
  if (rateChunk) {
    const n = rateChunk.size / 4
    // AVI 的时间单位是 1/60 秒（jiffy）
    for (let i = 0; i < n; i++) rates.push((buffer.readUInt32LE(rateChunk.start + i * 4) * 1000) / 60)
  }

  const seqChunk = findChunk(chunks, 'seq ')
  const seq = []
  if (seqChunk) {
    const n = seqChunk.size / 4
    for (let i = 0; i < n; i++) seq.push(buffer.readUInt32LE(seqChunk.start + i * 4))
  }

  const frames = []
  const listChunk = chunks.find((c) => c.id === 'LIST' && buffer.toString('ascii', c.start, c.start + 4) === 'fram')
  if (!listChunk) throw new CursorFormatError('ANI: 找不到 LIST fram')
  const inner = readChunks(buffer, listChunk.start + 4, listChunk.end)
  for (const chunk of inner) {
    if (chunk.id !== 'icon') continue
    const frameBuffer = buffer.subarray(chunk.start, chunk.end)
    try {
      const parsed = parseIconFile(frameBuffer, 'ico')
      const frame = parsed.frames[parsed.frames.length - 1]
      frames.push(frame)
    } catch {
      // 少数 .ani 的 icon chunk 直接是裸 DIB
      try {
        const fake = { data: frameBuffer, width: header?.width || 0, height: header?.height || 0 }
        const decoded = decodeDibEntry(fake, 0)
        frames.push({ ...decoded, hotspotX: 0, hotspotY: 0 })
      } catch { /* 跳过坏帧 */ }
    }
  }
  if (!frames.length) throw new CursorFormatError('ANI: 没有可用帧')

  const fps = header && header.displayRate > 0 ? header.displayRate : 10
  const uniformRate = rates.length ? Math.max(...rates) : Math.round(1000 / fps) || 100
  return {
    header,
    frames,
    seq: seq.length ? seq : frames.map((_, i) => i),
    frameDelayMs: Math.max(20, Math.round(uniformRate)),
    width: frames[0].width,
    height: frames[0].height,
  }
}

/**
 * 把多帧拼成一张 sprite sheet（正方形网格），覆盖层按 cell/cols 切。
 * @param {Array<{width:number,height:number,data:Buffer}>} frames
 */
export function packSpriteSheet(frames) {
  if (!frames.length) throw new CursorFormatError('packSpriteSheet: 没有帧')
  const cell = Math.max(...frames.map((f) => Math.max(f.width, f.height)))
  const cols = Math.ceil(Math.sqrt(frames.length))
  const rows = Math.ceil(frames.length / cols)
  const width = cell * cols
  const height = cell * rows
  const data = Buffer.alloc(width * height * 4)
  frames.forEach((frame, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const offsetX = col * cell + Math.floor((cell - frame.width) / 2)
    const offsetY = row * cell + Math.floor((cell - frame.height) / 2)
    for (let y = 0; y < frame.height; y++) {
      const from = y * frame.width * 4
      const to = ((offsetY + y) * width + offsetX) * 4
      frame.data.copy(data, to, from, from + frame.width * 4)
    }
  })
  return { width, height, cell, cols, rows, frames: frames.length, data }
}

/**
 * 读任意光标文件 → 统一的「可给覆盖层用」的形状。
 * @returns {{kind:'static'|'animated', width:number, height:number, cell:number, cols:number,
 *            frames:number, frameDelayMs:number, hotspotX:number, hotspotY:number, png:Buffer}}
 */
export function renderCursorAsset(buffer, { kind = 'cur', frameDelayMs = 100 } = {}) {
  const signature = buffer.toString('ascii', 0, 4)
  if (signature === 'RIFF') {
    const ani = parseAni(buffer)
    const sheet = packSpriteSheet(ani.frames)
    return {
      kind: 'animated',
      width: sheet.width,
      height: sheet.height,
      cell: sheet.cell,
      cols: sheet.cols,
      frames: sheet.frames,
      frameDelayMs: ani.frameDelayMs || frameDelayMs,
      nativeWidth: ani.width,
      nativeHeight: ani.height,
      hotspotX: ani.frames[0].hotspotX || 0,
      hotspotY: ani.frames[0].hotspotY || 0,
      png: encodePng({ width: sheet.width, height: sheet.height, data: sheet.data }),
    }
  }
  const best = bestFrame(buffer, kind)
  return {
    kind: 'static',
    width: best.width,
    height: best.height,
    cell: best.width,
    cols: 1,
    frames: 1,
    frameDelayMs: 0,
    nativeWidth: best.width,
    nativeHeight: best.height,
    hotspotX: best.hotspotX,
    hotspotY: best.hotspotY,
    png: encodePng({ width: best.width, height: best.height, data: best.data }),
  }
}
