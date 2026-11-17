/**
 * agent-computer-input · 光标资产烘焙
 *
 * 把素材包（默认 `Cur/Vision Cursor Black` 与 `Cur/Vision Cursor White`）
 * 里的 .cur / .ani 解码成覆盖层能直接画的 PNG，并按主题分目录：
 *
 *   assets/cursors/light/pointer.png     ← 浅色主题用深色光标（Vision Cursor Black）
 *   assets/cursors/dark/pointer.png      ← 深色主题用浅色光标（Vision Cursor White）
 *   assets/cursors/manifest.json         ← 每个状态的帧数/网格/热点/来源
 *
 * 约定：`light` 目录 = 给浅色主题用的「黑」光标，`dark` 目录 = 给深色主题用的「白」光标。
 * 命名按用途（用在哪）而不是按颜色，读代码时不用再想一遍对应关系。
 */

import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng, decodePng, packSpriteSheet, parseAni, parseIconFile, bestFrame } from './cur.js'

/** 覆盖层统一按 128px 画布切帧；小于这个尺寸的动画帧用整数倍最近邻放大。 */
export const NOMINAL_CELL = 128

/** 主题 → 素材包目录名（Vision Cursor Black 画在黑字上不好看，所以给浅色主题用）。 */
export const THEME_SOURCES = {
  light: 'Vision Cursor Black',
  dark: 'Vision Cursor White',
}

/**
 * 状态 → 素材文件名（不含扩展名）。素材包缺某个状态时按 fallback 链找。
 * 状态名沿用上游 0.2.0 的 15 个，另加素材包里多出来的 person / pin。
 */
export const STATE_SOURCES = {
  pointer: ['pointer', 'alternate'],
  work: ['work', 'busy', 'person', 'pointer'],
  busy: ['busy', 'work', 'person', 'pointer'],
  unavailiable: ['unavailiable', 'unavailable', 'help', 'pointer'],
  link: ['link', 'person', 'pointer'],
  text: ['text', 'handwriting', 'pointer'],
  cross: ['cross', 'pointer'],
  move: ['move', 'pointer'],
  vert: ['vert', 'move', 'pointer'],
  horz: ['horz', 'move', 'pointer'],
  help: ['help', 'pointer'],
  handwriting: ['handwriting', 'text', 'pointer'],
  dgn1: ['dgn1', 'dgnl', 'pointer'],
  dgn2: ['dgn2', 'dgnr', 'pointer'],
  alternate: ['alternate', 'pointer'],
  person: ['person', 'link', 'pointer'],
  pin: ['pin', 'link', 'pointer'],
}

/** 覆盖层按状态自动切换时用的默认值（缺素材时的兜底）。 */
export const DEFAULT_STATE = 'pointer'
export const PAUSED_STATE = 'unavailiable'

function nearestUpscale(frame, factor) {
  if (factor === 1) return frame
  const width = frame.width * factor
  const height = frame.height * factor
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / factor)
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(x / factor)
      const from = (sy * frame.width + sx) * 4
      const to = (y * width + x) * 4
      data[to] = frame.data[from]
      data[to + 1] = frame.data[from + 1]
      data[to + 2] = frame.data[from + 2]
      data[to + 3] = frame.data[from + 3]
    }
  }
  return { ...frame, width, height, data }
}

/**
 * 把单帧/多帧统一成 NOMINAL_CELL 画布的 sheet。
 * @returns {{png:Buffer, cell:number, cols:number, rows:number, frames:number,
 *            frameDelayMs:number, hotspot:{x:number,y:number}, nativeWidth:number, nativeHeight:number}}
 */
export function normalizeAsset(buffer) {
  if (buffer.toString('ascii', 0, 4) === 'RIFF') {
    const ani = parseAni(buffer)
    const native = ani.width
    const factor = Math.max(1, Math.round(NOMINAL_CELL / native) || 1)
    const frames = ani.frames.map((f) => nearestUpscale(f, factor))
    const sheet = packSpriteSheet(frames)
    // 网关网格必须是 NOMINAL_CELL 的整数倍，packSpriteSheet 已按最大帧算 cell
    const cell = sheet.cell
    return {
      png: encodePng({ width: sheet.width, height: sheet.height, data: sheet.data }),
      cell,
      cols: sheet.cols,
      rows: sheet.rows,
      frames: sheet.frames,
      frameDelayMs: ani.frameDelayMs,
      hotspot: {
        x: Math.round((ani.frames[0].hotspotX || 0) * (cell / (native || cell))),
        y: Math.round((ani.frames[0].hotspotY || 0) * (cell / (native || cell))),
      },
      nativeWidth: native,
      nativeHeight: ani.height,
      animated: true,
    }
  }
  const best = bestFrame(buffer, 'cur')
  const factor = Math.max(1, Math.round(NOMINAL_CELL / best.width) || 1)
  const frame = nearestUpscale(best, factor)
  return {
    png: encodePng({ width: frame.width, height: frame.height, data: frame.data }),
    cell: frame.width,
    cols: 1,
    rows: 1,
    frames: 1,
    frameDelayMs: 0,
    hotspot: {
      x: Math.round(best.hotspotX * factor),
      y: Math.round(best.hotspotY * factor),
    },
    nativeWidth: best.width,
    nativeHeight: best.height,
    animated: false,
  }
}

function pickSource(files, candidates) {
  for (const name of candidates) {
    for (const ext of ['.cur', '.ico', '.ani']) {
      const hit = files.find((f) => f.toLowerCase() === `${name}${ext}`.toLowerCase())
      if (hit) return hit
    }
  }
  return null
}

/* --------------------------------------------------------- README 预览图 */

const PREVIEW_COLS = 6
const PREVIEW_CELL = 128
const PREVIEW_PAD = 18

/** 把某个主题的全部状态首帧拼成一张图（给 README 用）。 */
function composePreview(frames, theme) {
  const rows = Math.ceil(frames.length / PREVIEW_COLS)
  const cell = PREVIEW_CELL
  const pad = PREVIEW_PAD
  const width = PREVIEW_COLS * (cell + pad) + pad
  const height = rows * (cell + pad) + pad
  const bg = theme === 'dark' ? [16, 17, 22, 255] : [245, 246, 249, 255]
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = bg[0]
    out[i * 4 + 1] = bg[1]
    out[i * 4 + 2] = bg[2]
    out[i * 4 + 3] = bg[3]
  }
  frames.forEach((frame, index) => {
    const col = index % PREVIEW_COLS
    const row = Math.floor(index / PREVIEW_COLS)
    const originX = pad + col * (cell + pad)
    const originY = pad + row * (cell + pad)
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const from = (y * frame.width + x) * 4
        const a = frame.data[from + 3] / 255
        if (a === 0) continue
        const to = ((originY + y) * width + originX + x) * 4
        out[to] = Math.round(frame.data[from] * a + out[to] * (1 - a))
        out[to + 1] = Math.round(frame.data[from + 1] * a + out[to + 1] * (1 - a))
        out[to + 2] = Math.round(frame.data[from + 2] * a + out[to + 2] * (1 - a))
        out[to + 3] = 255
      }
    }
  })
  return encodePng({ width, height, data: out })
}

/**
 * 烘焙一个主题。
 * @param {string} sourceDir Cur/Vision Cursor Black|White
 * @param {string} outDir    assets/cursors/light|dark
 * @param {() => void} [log]
 */
export async function buildTheme(sourceDir, outDir, log = () => {}) {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile()).map((e) => e.name)
  await mkdir(outDir, { recursive: true })

  const states = {}
  const previews = []
  for (const [state, candidates] of Object.entries(STATE_SOURCES)) {
    const file = pickSource(files, candidates)
    if (!file) {
      log(`  ! ${state}: 素材包内没有可用文件（${candidates.join(' / ')}）`)
      continue
    }
    const buffer = await readFile(join(sourceDir, file))
    let asset
    try {
      asset = normalizeAsset(buffer)
    } catch (error) {
      log(`  ! ${state}: ${file} 解码失败（${error.message}），跳过`)
      continue
    }
    const pngName = `${state}.png`
    await writeFile(join(outDir, pngName), asset.png)
    previews.push({ state, width: asset.cell, height: asset.cell, data: decodePng(asset.png).data })
    states[state] = {
      file: pngName,
      source: file,
      frames: asset.frames,
      cols: asset.cols,
      rows: asset.rows,
      cell: asset.cell,
      frameDelayMs: asset.frameDelayMs,
      hotspot: asset.hotspot,
      nativeWidth: asset.nativeWidth,
      nativeHeight: asset.nativeHeight,
      animated: asset.animated,
    }
    log(`  · ${state.padEnd(13)} ← ${file.padEnd(18)} ${asset.frames} 帧 ${asset.cell}px`)
  }
  return { states, previews }
}

/**
 * 烘焙所有主题，写 manifest.json。
 * @param {{root?:string, sources?:Record<string,string>, outRoot?:string, log?:(m:string)=>void}} [options]
 */
export async function buildCursorAssets(options = {}) {
  const root = options.root || process.cwd()
  const outRoot = options.outRoot || join(root, 'assets', 'cursors')
  const sources = options.sources || THEME_SOURCES
  const log = options.log || (() => {})

  const manifest = {
    version: 1,
    generator: 'agent-computer-input/build-cursors',
    cell: NOMINAL_CELL,
    themes: {},
  }

  for (const [theme, dirName] of Object.entries(sources)) {
    const sourceDir = join(root, 'Cur', dirName)
    if (!existsSync(sourceDir)) {
      log(`- 主题 ${theme}: 找不到素材目录 ${sourceDir}`)
      continue
    }
    log(`- 主题 ${theme} ← Cur/${dirName}`)
    const outDir = join(outRoot, theme)
    await rm(outDir, { recursive: true, force: true })
    const { states, previews } = await buildTheme(sourceDir, outDir, log)
    await writeFile(join(outRoot, `preview-${theme}.png`), composePreview(previews, theme))
    log(`  · preview-${theme}.png（${previews.length} 个状态）`)
    manifest.themes[theme] = { dir: theme, source: `Cur/${dirName}`, states, preview: `preview-${theme}.png` }
  }

  await mkdir(outRoot, { recursive: true })
  await writeFile(join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  log(`- manifest → ${join(outRoot, 'manifest.json')}`)
  return manifest
}

/** manifest 是否比素材新（用来决定要不要自动重烘焙）。 */
export async function assetsFresh(root, manifestPath = join(root, 'assets', 'cursors', 'manifest.json')) {
  try {
    const manifestStat = await stat(manifestPath)
    for (const dirName of Object.values(THEME_SOURCES)) {
      const sourceDir = join(root, 'Cur', dirName)
      if (!existsSync(sourceDir)) continue
      for (const name of await readdir(sourceDir)) {
        const fileStat = await stat(join(sourceDir, name))
        if (fileStat.mtimeMs > manifestStat.mtimeMs) return false
      }
    }
    return true
  } catch {
    return false
  }
}

/** 确保资产存在；过期就重烘焙（一次，不递归）。 */
export async function ensureCursorAssets(root, log = () => {}) {
  const manifestPath = join(root, 'assets', 'cursors', 'manifest.json')
  if (existsSync(manifestPath) && (await assetsFresh(root, manifestPath))) return { built: false }
  if (!existsSync(join(root, 'Cur'))) return { built: false, reason: 'no-source' }
  log('光标资产缺失或素材有更新，重新烘焙……')
  await buildCursorAssets({ root, log })
  return { built: true }
}
