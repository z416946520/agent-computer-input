import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseIconFile, parseAni, bestFrame, renderCursorAsset, encodePng, decodePng, packSpriteSheet,
} from '../src/core/cur.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BLACK = join(ROOT, 'Cur', 'Vision Cursor Black')

test('.cur：读出 5 个尺寸、取最大帧、热点在画布内', () => {
  const buffer = readFileSync(join(BLACK, 'pointer.cur'))
  const parsed = parseIconFile(buffer, 'cur')
  assert.equal(parsed.cursor, true)
  assert.equal(parsed.frames.length, 5)
  assert.deepEqual(parsed.frames.map((f) => f.width), [32, 48, 64, 96, 128])

  const best = bestFrame(buffer)
  assert.equal(best.width, 128)
  assert.equal(best.height, 128)
  assert.ok(best.hotspotX >= 0 && best.hotspotX <= best.width)
  assert.ok(best.hotspotY >= 0 && best.hotspotY <= best.height)
  // 指针类热点应在左上角附近（箭头尖）
  assert.ok(best.hotspotX <= 16 && best.hotspotY <= 16, `hotspot=${best.hotspotX},${best.hotspotY}`)
  // 对称类光标热点在中心
  const cross = bestFrame(readFileSync(join(BLACK, 'cross.cur')))
  assert.ok(Math.abs(cross.hotspotX - cross.width / 2) <= 2)
})

test('.cur：RGBA 有透明像素和可见像素', () => {
  const best = bestFrame(readFileSync(join(BLACK, 'pointer.cur')))
  let transparent = 0
  let visible = 0
  for (let i = 0; i < best.width * best.height; i++) {
    const a = best.data[i * 4 + 3]
    if (a === 0) transparent++
    else visible++
  }
  assert.ok(transparent > best.width * best.height * 0.3, '应有大量透明像素')
  assert.ok(visible > 200, '应有可见像素')
})

test('.ani：解析 12 帧并给出帧间隔', () => {
  const ani = parseAni(readFileSync(join(BLACK, 'busy.ani')))
  assert.equal(ani.frames.length, 12)
  assert.equal(ani.width, 64)
  assert.ok(ani.frameDelayMs >= 20 && ani.frameDelayMs <= 1000, `delay=${ani.frameDelayMs}`)
  for (const frame of ani.frames) {
    assert.equal(frame.width, 64)
    assert.equal(frame.height, 64)
  }
})

test('renderCursorAsset：静态单帧 / 动画 sheet 网格正确', () => {
  const stat = renderCursorAsset(readFileSync(join(BLACK, 'text.cur')))
  assert.equal(stat.kind, 'static')
  assert.equal(stat.frames, 1)
  assert.equal(stat.cols, 1)

  const anim = renderCursorAsset(readFileSync(join(BLACK, 'busy.ani')))
  assert.equal(anim.kind, 'animated')
  assert.equal(anim.frames, 12)
  assert.equal(anim.cols, 4)
  assert.equal(anim.cell, 64)
  assert.equal(anim.width, 256)
  assert.equal(anim.height, 192)
})

test('PNG 编解码往返一致', () => {
  const best = bestFrame(readFileSync(join(BLACK, 'dgn1.cur')))
  const png = encodePng({ width: best.width, height: best.height, data: best.data })
  const back = decodePng(png)
  assert.equal(back.width, best.width)
  assert.equal(back.height, best.height)
  assert.ok(back.data.equals(best.data), '像素应完全一致')
})

test('packSpriteSheet：帧按行列不重叠', () => {
  const frames = [0, 1, 2].map((i) => ({
    width: 4,
    height: 4,
    data: Buffer.alloc(4 * 4 * 4, i === 0 ? 255 : 0),
  }))
  frames[0].data = Buffer.from(frames[0].data.map((v, idx) => (idx % 4 === 3 ? 255 : 1)))
  const sheet = packSpriteSheet(frames)
  assert.equal(sheet.cell, 4)
  assert.equal(sheet.cols, 2)
  assert.equal(sheet.rows, 2)
  assert.equal(sheet.width, 8)
  assert.equal(sheet.height, 8)
})
