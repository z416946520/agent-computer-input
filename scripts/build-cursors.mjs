#!/usr/bin/env node
/**
 * 烘焙光标资产：Cur/Vision Cursor {Black,White} → assets/cursors/{light,dark}/*.png
 * 用法：node scripts/build-cursors.mjs [--root <dir>]
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCursorAssets } from '../src/core/cursor-build.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
let root = join(HERE, '..')
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i])
}

const manifest = await buildCursorAssets({ root, log: (line) => console.log(line) })
for (const [theme, info] of Object.entries(manifest.themes)) {
  console.log(`✓ ${theme}: ${Object.keys(info.states).length} 个状态`)
}
