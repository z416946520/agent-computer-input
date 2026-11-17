import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATE_SOURCES } from '../src/core/cursor-build.js'
import { decodePng } from '../src/core/cur.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'assets', 'cursors')

test('manifest：light / dark 两个主题都已烘焙', () => {
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.ok(manifest.themes.light, '缺少 light（浅色主题 → 深色光标）')
  assert.ok(manifest.themes.dark, '缺少 dark（深色主题 → 浅色光标）')
  assert.match(manifest.themes.light.source, /Vision Cursor Black/)
  assert.match(manifest.themes.dark.source, /Vision Cursor White/)
})

test('manifest：每个状态都有 PNG、帧参一致、热点在格内', () => {
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))
  for (const theme of ['light', 'dark']) {
    const states = manifest.themes[theme].states
    for (const state of Object.keys(STATE_SOURCES)) {
      const entry = states[state]
      assert.ok(entry, `${theme}/${state} 缺失`)
      const file = join(ASSETS, theme, entry.file)
      assert.ok(existsSync(file), `${theme}/${state} 文件不存在：${entry.file}`)
      assert.ok(entry.cols >= 1 && entry.frames >= 1)
      assert.equal(entry.cell, 128, '统一 128px 画布，覆盖层才好等比缩放')
      assert.equal(entry.cols * entry.rows >= entry.frames, true, `${theme}/${state} 网格装不下帧`)
      assert.ok(entry.hotspot.x >= 0 && entry.hotspot.x <= entry.cell, `${theme}/${state} 热点 x 越界`)
      assert.ok(entry.hotspot.y >= 0 && entry.hotspot.y <= entry.cell, `${theme}/${state} 热点 y 越界`)
    }
  }
})

test('PNG：浅色主题是深色箭头，深色主题是浅色箭头', () => {
  const lightArrow = decodePng(readFileSync(join(ASSETS, 'light', 'pointer.png')))
  const darkArrow = decodePng(readFileSync(join(ASSETS, 'dark', 'pointer.png')))

  const luminance = (png) => {
    let sum = 0
    let count = 0
    for (let i = 0; i < png.width * png.height; i++) {
      if (png.data[i * 4 + 3] < 200) continue
      sum += (png.data[i * 4] + png.data[i * 4 + 1] + png.data[i * 4 + 2]) / 3
      count++
    }
    return count ? sum / count : 0
  }

  const light = luminance(lightArrow)
  const dark = luminance(darkArrow)
  assert.ok(light < dark, `light 目录应更暗（${light} < ${dark}）`)
})

test('动画状态：work / busy 是 2×2 以上网格的多帧 sheet', () => {
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))
  for (const theme of ['light', 'dark']) {
    for (const state of ['work', 'busy']) {
      const entry = manifest.themes[theme].states[state]
      assert.equal(entry.animated, true, `${theme}/${state} 应是动画`)
      assert.ok(entry.frames >= 2)
      const png = decodePng(readFileSync(join(ASSETS, theme, entry.file)))
      assert.equal(png.width, entry.cell * entry.cols)
      assert.equal(png.height, entry.cell * entry.rows)
    }
  }
})
