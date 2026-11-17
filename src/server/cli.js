/**
 * agent-computer-input · CLI
 *
 * 任何 agent（或人）都能直接命令行调用：
 *   aci status
 *   aci windows --query chrome
 *   aci click --hwnd 12345 --x 400 --y 300
 *   aci type --hwnd 12345 --x 400 --y 300 --text "hello" --replace
 *   aci capture --hwnd 12345 --path shot.png
 *   aci overlay --cursor-theme dark --cursor-size 128
 *   aci settings --set cursorMode=clean --set cursorSize=112
 *   aci mcp            # 起 MCP stdio server
 *   aci serve          # 起本地 HTTP API
 */

import { loadSettings, saveSettings as persistSettings, DEFAULT_SETTINGS, resolveHome } from '../core/settings.js'
import { createInputRunner, ACTIONS } from '../core/actions.js'
import { buildCursorAssets, ensureCursorAssets } from '../core/cursor-build.js'
import { detectWindowsTheme, resolveCursorTheme } from '../core/theme.js'
import { TOOL_NAME, PACKAGE_NAME } from '../core/tool-spec.js'
import { PACKAGE_ROOT, ASSETS_ROOT } from '../core/sidecar.js'

const FLAG_TO_ARG = {
  '--hwnd': 'hwnd',
  '--x': 'x',
  '--y': 'y',
  '--to-x': 'toX',
  '--to-y': 'toY',
  '--button': 'button',
  '--count': 'count',
  '--text': 'text',
  '--keys': 'keys',
  '--mode': 'mode',
  '--delta': 'delta',
  '--duration': 'durationMs',
  '--path': 'path',
  '--rect': 'rect',
  '--query': 'query',
  '--cursor-state': 'cursorState',
  '--cursor-mode': 'cursorMode',
  '--cursor-size': 'cursorSize',
  '--cursor-theme': 'cursorTheme',
  '--cursor-opacity': 'cursorOpacity',
}

const BOOLEAN_FLAGS = {
  '--replace': ['replace', true],
  '--no-attach': ['attach', false],
  '--show': ['show', true],
  '--hide': ['show', false],
  '--enabled': ['enabled', true],
  '--disabled': ['enabled', false],
  '--allow-physical': ['allowPhysical', true],
  '--no-animations': ['animations', false],
}

const NUMERIC_KEYS = new Set(['hwnd', 'x', 'y', 'toX', 'toY', 'count', 'delta', 'durationMs', 'cursorSize', 'cursorOpacity'])

export const HELP = `${PACKAGE_NAME} · 独立鼠标键盘（不碰真实光标 / 不抢焦点）
Windows 桌面操作工具：MCP / HTTP / CLI / DSH 插件共用同一套动作。

用法:
  aci <action> [flags] [--json]
  aci settings [--set key=value]... [--json]
  aci mcp | serve | build-cursors | themes | help

actions: ${ACTIONS.join(' / ')}

flags:
  --hwnd <id>       目标窗口句柄（click/type/key/scroll/drag 必填）
  --x --y <n>       屏幕坐标
  --to-x --to-y     拖拽终点
  --text <s>        输入文字
  --keys <s>        组合键，如 "ctrl+c"
  --button left|right|middle
  --count <n>       点击次数，2 = 双击
  --mode auto|uia|message|physical
  --delta <n>       滚轮量（默认 -120）
  --duration <ms>   拖拽时长（默认 400）
  --path <file>     截图路径
  --rect x,y,w,h|full
  --query <s>       windows 过滤
  --cursor-state <s>  强制光标状态
  --cursor-theme auto|light|dark
  --cursor-size <px> 24–192
  --cursor-opacity <f> 0.2–1
  --show / --hide   overlay 显示或收起
  --replace         type 覆盖而不是追加
  --no-attach       capture 不返回图片附件
  --enabled / --disabled   总开关
  --allow-physical 允许 physical（会动真实光标）
  --set k=v         settings 批量改动
  --json            输出 JSON（meta 里带完整结果）
`

function parseArgs(argv) {
  const positional = []
  const args = {}
  const settingsSet = []
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--json') { json = true; continue }
    if (token === '--help' || token === '-h') { positional.push('help'); continue }
    if (token === '--set') {
      const pair = argv[++i] || ''
      const [key, ...rest] = pair.split('=')
      if (key) settingsSet.push([key, rest.join('=')])
      continue
    }
    if (BOOLEAN_FLAGS[token]) {
      const [key, value] = BOOLEAN_FLAGS[token]
      args[key] = value
      continue
    }
    if (FLAG_TO_ARG[token]) {
      const key = FLAG_TO_ARG[token]
      const value = argv[++i]
      args[key] = NUMERIC_KEYS.has(key) ? Number(value) : value
      continue
    }
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
      args[key] = NUMERIC_KEYS.has(key) && value !== true ? Number(value) : value
      continue
    }
    positional.push(token)
  }
  return { positional, args, settingsSet, json }
}

function coerce(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value)
  return value
}

function printResult(outcome, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ text: outcome.text, meta: outcome.meta, images: (outcome.images || []).map((i) => ({ name: i.name, mediaType: i.mediaType })) }, null, 2)}\n`)
    return
  }
  process.stdout.write(`${outcome.text}\n`)
  for (const image of outcome.images || []) {
    if (image.mediaType === 'image/png' && outcome.meta?.path) process.stdout.write(`(图: ${outcome.meta.path})\n`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, args, settingsSet, json } = parseArgs(argv)
  const command = (positional[0] || 'status').toLowerCase()

  if (command === 'help' || command === '--help') {
    process.stdout.write(HELP)
    return 0
  }

  if (command === 'themes') {
    const theme = detectWindowsTheme({ force: true })
    const { settings } = loadSettings({})
    const active = resolveCursorTheme(settings.cursorTheme, theme)
    let manifest = null
    try {
      const { readFile } = await import('node:fs/promises')
      manifest = JSON.parse(await readFile(`${ASSETS_ROOT}/manifest.json`, 'utf8'))
    } catch { /* 还没烘焙 */ }
    const summary = {
      windowsTheme: theme,
      activeTheme: active,
      settings,
      states: manifest ? Object.fromEntries(Object.entries(manifest.themes).map(([k, v]) => [k, Object.keys(v.states)])) : {},
    }
    if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    else {
      process.stdout.write(`Windows 应用主题：${theme.scheme}（${theme.source}）\n`)
      process.stdout.write(`实际使用光标：${active}（${active === 'light' ? '深色光标 · Vision Cursor Black' : '浅色光标 · Vision Cursor White'}）\n`)
      for (const [name, list] of Object.entries(summary.states)) {
        process.stdout.write(`  ${name}: ${list.join(', ')}\n`)
      }
    }
    return 0
  }

  if (command === 'build-cursors') {
    await buildCursorAssets({ root: PACKAGE_ROOT, log: (line) => process.stdout.write(`${line}\n`) })
    return 0
  }

  if (command === 'mcp') {
    const { startMcpServer } = await import('./mcp.js')
    await startMcpServer()
    return null // 常驻
  }

  if (command === 'serve') {
    const { startHttpServer } = await import('./http.js')
    const loaded = loadSettings({})
    let settings = loaded.settings
    const runner = createInputRunner({ settings, log: (level, message) => process.stderr.write(`[${level}] ${message}\n`) })
    const server = await startHttpServer({
      runner,
      getSettings: () => settings,
      saveSettings: async (patch) => {
        settings = persistSettings({ ...settings, ...patch })
        await runner.updateSettings(settings)
        return settings
      },
      log: (level, message) => process.stderr.write(`[${level}] ${message}\n`),
    })
    process.stdout.write(`HTTP API: http://${server.host}:${server.port}\n`)
    const stop = async () => {
      await server.close()
      await runner.dispose()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return null
  }

  await ensureCursorAssets(PACKAGE_ROOT, (line) => process.stderr.write(`${line}\n`))
  const loaded = loadSettings({ patch: args.settingsPatch || {} })
  let settings = loaded.settings

  if (command === 'settings') {
    if (args.reset === true) {
      settings = persistSettings({ ...DEFAULT_SETTINGS })
      if (!json) process.stdout.write('已恢复默认设置。\n')
    }
    if (settingsSet.length) {
      const patch = {}
      for (const [key, value] of settingsSet) patch[key] = coerce(value)
      settings = persistSettings({ ...settings, ...patch })
      if (!json) process.stdout.write('设置已保存。\n')
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({ settings, file: loaded.file, home: resolveHome() }, null, 2)}\n`)
    } else {
      process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`)
      process.stdout.write(`设置文件：${loaded.file}\n数据目录：${resolveHome()}\n`)
    }
    return 0
  }

  const runner = createInputRunner({ settings, log: (level, message) => { if (level !== 'debug') process.stderr.write(`[${level}] ${message}\n`) } })
  try {
    const outcome = await runner.runAction({ action: command, ...args })
    printResult(outcome, json)
    return outcome.meta?.ok === false ? 1 : 0
  } finally {
    await runner.dispose()
  }
}

export { TOOL_NAME }
