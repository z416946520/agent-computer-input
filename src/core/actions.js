/**
 * agent-computer-input · 动作层
 *
 * 这里只有一件事：把「agent 说要做什么」翻译成 sidecar 命令，再把结果写成
 * 一句 agent 能看懂的话（+ 可选截图附件）。
 *
 * 不依赖任何宿主：MCP / HTTP / CLI / DSH 插件都调同一个 `runAction`。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { SidecarClient, SidecarError } from './sidecar.js'
import { detectWindowsTheme, resolveCursorTheme } from './theme.js'
import { shotsDir, normalizeSettings, saveSettings } from './settings.js'

export const ACTIONS = [
  'status', 'windows', 'inspect', 'capture',
  'click', 'type', 'key', 'scroll', 'drag', 'move',
  'pause', 'resume', 'overlay', 'settings',
]

export const CURSOR_STATES = [
  'pointer', 'work', 'busy', 'unavailiable', 'link', 'text', 'cross',
  'move', 'vert', 'horz', 'help', 'handwriting', 'dgn1', 'dgn2', 'alternate',
  'person', 'pin',
]

const ACTION_TIMEOUTS = {
  status: 15000,
  windows: 20000,
  inspect: 15000,
  capture: 45000,
  click: 40000,
  type: 90000,
  key: 40000,
  scroll: 40000,
  drag: 120000,
  move: 15000,
  pause: 15000,
  resume: 15000,
  overlay: 20000,
  settings: 25000,
}

function toSafeJson(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(toSafeJson)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = toSafeJson(item)
  return out
}

/* ------------------------------------------------------------ 结果文案 */

function cursorModeLine(meta) {
  const size = meta?.cursorSize ?? 96
  const state = meta?.cursorState || 'pointer'
  const theme = meta?.cursorTheme ? ` · ${meta.cursorTheme === 'light' ? '浅色主题/深色光标' : '深色主题/浅色光标'}` : ''
  if (meta?.cursorMode === 'clean') return `整洁模式（动作后约 ${meta?.cursorHoldMs || 2600}ms 收起，${size}px · ${state}${theme}）`
  return `陪伴模式（一直显示，${size}px · ${state}${theme}）`
}

export function statusText(status, extra = {}) {
  if (!status || typeof status !== 'object') return '没读到输入 sidecar 状态。'
  const paused = status.paused ? `已暂停（${status.pauseReason || '主人接管'}）` : '运行中'
  const age = Number.isFinite(status.lastUserInputAgeMs) && status.lastUserInputAgeMs >= 0
    ? `${Math.round(status.lastUserInputAgeMs)}ms 前`
    : '还没记录'
  const fg = status.foreground?.title || status.foreground?.className || '未知'
  const realCursor = status.cursor ? `(${status.cursor.x}, ${status.cursor.y})` : '未知'
  const theme = extra.theme || {}
  const lines = [
    `输入通道：${paused}${status.physicalAllowed ? '' : ' · 严格模式（不碰真实光标 / 不抢焦点）'}`,
    `主人最近一次真实输入：${age}`,
    `真实光标：${realCursor}（不会被移动）· AI 光标：${status.overlay ? '显示' : '隐藏'}`,
    `AI 光标：${cursorModeLine({ ...status, cursorTheme: extra.cursorTheme })}`,
    `光标素材主题：${extra.cursorTheme === 'light' ? 'light（浅色主题 → 深色光标）' : 'dark（深色主题 → 浅色光标）'}` +
      ` · Windows 应用主题：${theme.scheme || '未知'}（${theme.source || '?'}）`,
    `前台窗口：${fg}${status.foreground?.hwnd ? `（hwnd ${status.foreground.hwnd}）` : ''}`,
    `UIA：${status.uia ? '可用' : '不可用（只剩窗口消息）'} · 暂停热键：${status.hotkey || '未注册'}${status.hotkeyRegistered === false ? '（注册失败）' : ''}`,
  ]
  if (status.paused) {
    lines.push('⚠ 已被暂停：不要继续操作；等主人说“继续”，再 action:"resume"。')
  } else {
    lines.push(`主人随时可按 ${status.hotkey || 'Ctrl+Alt+Q'} 暂停；主人在用键鼠不会自动打断你。`)
  }
  return lines.join('\n')
}

export function windowsText(result, limit = 24) {
  const list = Array.isArray(result?.windows) ? result.windows : []
  if (!list.length) return '没读到可用窗口。'
  const lines = list.slice(0, limit).map((w) => {
    const rect = w.rect ? `${w.rect.x},${w.rect.y} ${w.rect.w}x${w.rect.h}` : '?'
    const mark = w.foreground ? ' ★前台' : ''
    return `hwnd ${w.hwnd} · ${w.title} · ${rect} · ${w.process || ''}${mark}`.trim()
  })
  if (list.length > limit) lines.push(`……还有 ${list.length - limit} 个窗口未列出`)
  return lines.join('\n')
}

function actionText(action, result, context) {
  if (!result || typeof result !== 'object') return `已执行 ${action}。`
  if (result.paused) {
    return `⚠ 已暂停/接管，动作没有执行。\n${result.note || '等主人说继续，再 action:"resume"。'}`
  }
  if (result.ok === false) {
    const bits = [`未完成（${result.reason || '未知原因'}）`]
    if (result.name) bits.push(`目标：${result.name}`)
    if (result.type) bits.push(`类型：${result.type}`)
    if (result.note) bits.push(result.note)
    if (result.strictNoRealMouse || result.strictNoFocusSteal) bits.push('严格模式：不碰真实光标、不抢输入焦点。')
    if (result.needsPhysical) bits.push('如需真实输入，请在设置里打开 allowPhysical（会动你的鼠标/键盘焦点）。')
    return bits.join('\n')
  }
  if (action === 'capture') {
    return `截图已保存：${result.path}\n${result.attached ? '图已附在本条结果里。' : '可以用图片查看工具打开它。'}${result.rect ? `\n区域：${result.rect}` : ''}`
  }
  if (action === 'move' || action === 'overlay') {
    if (result.visible === false) return 'AI 光标已隐藏；真实光标没有移动。'
    return `AI 光标已到 (${result.x ?? '?'}, ${result.y ?? '?'}) · ${cursorModeLine({ ...result, ...context })}；真实光标没有移动。`
  }
  if (action === 'inspect') {
    const rect = result.rect ? `${result.rect.x},${result.rect.y} ${result.rect.w}x${result.rect.h}` : '?'
    return `hwnd ${result.hwnd} · ${result.title || '(无标题)'} · 类名 ${result.className || '?'} · ${rect}` +
      `${result.foreground ? ' ★前台' : ''}${result.iconic ? ' · 已最小化' : ''}${result.visible === false ? ' · 不可见' : ''}`
  }
  if (action === 'settings') {
    return `设置已更新并生效：${JSON.stringify(result.settings || {}, null, 2)}`
  }
  const via = result.via || 'unknown'
  const target = result.title ? `“${result.title}”` : (result.hwnd ? `hwnd ${result.hwnd}` : '目标')
  if (via === 'uia') return `UIA 已执行（${result.pattern || 'pattern'}）${result.name ? `：${result.name}` : ''}${result.type ? ` · ${result.type}` : ''}`
  if (via === 'uia-hwnd') return `目标窗口内 UIA 已执行（${result.pattern || 'pattern'}）${result.name ? `：${result.name}` : ''}`
  if (via === 'bm_click') return '已向按钮发 BM_CLICK；没有移动鼠标，也没有抢焦点。'
  if (via === 'wm_settext') return `已直接写入控件${result.verified ? '（已回读确认）' : ''}；没有移动光标，也没有抢焦点。`
  if (via === 'uia+message') return `已向目标窗口投递文字${result.verified ? '（已确认）' : '（需截图确认）'}；没有抢焦点。`
  if (via === 'message-hwnd') return `已向 ${target} 投递窗口消息${result.verified ? '（已确认）' : '（不一定被处理，建议截图确认）'}；没有抢焦点、没有移动真实鼠标。`
  if (via === 'message') return `窗口消息已投递给 ${target}${result.verified ? '（已确认）' : '（不一定被处理，建议截图确认）'}。`
  if (via === 'overlay') return `AI 光标已到 (${result.x ?? '?'}, ${result.y ?? '?'})。`
  if (via === 'physical') return `physical 已执行（会动真实光标/抢焦点，仅在你显式允许时出现）。`
  return `已执行 ${action}：${JSON.stringify(result).slice(0, 600)}`
}

/* --------------------------------------------------------------- capture */

function normalizeRectValue(rect) {
  if (typeof rect !== 'string') return ''
  const value = rect.trim()
  if (!value) return ''
  if (value.toLowerCase() === 'full') return '0,0,0,0'
  return value
}

async function capture({ sidecar, settings, args, env }) {
  let rect = normalizeRectValue(args.rect)
  if (!rect && Number.isFinite(args.hwnd)) {
    const info = await sidecar.request('winInfo', { hwnd: Math.trunc(args.hwnd) }, 12000)
    if (info?.rect && info.rect.w > 0 && info.rect.h > 0) {
      rect = `${info.rect.x},${info.rect.y},${info.rect.w},${info.rect.h}`
    }
  }
  if (!rect) {
    const status = await sidecar.request('status', {}, 12000)
    const hwnd = status?.foreground?.hwnd
    if (hwnd) {
      const info = await sidecar.request('winInfo', { hwnd }, 12000)
      const r = info?.rect
      if (r && r.w > 0 && r.h > 0) rect = `${r.x},${r.y},${r.w},${r.h}`
    }
  }
  if (!rect) rect = '0,0,0,0'

  const dir = shotsDir(settings, env)
  const requested = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : ''
  const path = requested
    ? (isAbsolute(requested) ? requested : resolve(process.cwd(), requested))
    : join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
  await mkdir(dirname(path), { recursive: true })

  const saved = await sidecar.request('capture', { path, rect }, ACTION_TIMEOUTS.capture)
  let images = []
  if (args.attach !== false) {
    try {
      const data = await readFile(path)
      images = [{ mediaType: 'image/png', data: data.toString('base64'), name: path.split(/[\\/]/).pop() }]
    } catch { /* 读不回来不影响截图本身 */ }
  }
  return {
    result: { ok: true, path: saved.path || path, rect, attached: images.length > 0 },
    images,
    meta: { ok: true, path: saved.path || path, rect },
  }
}

/* ------------------------------------------------------------- prepare args */

function pickNumber(...values) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return undefined
}

function pickHwnd(args) {
  return pickNumber(args.hwnd, args.window, args.handle)
}

/* ------------------------------------------------------------------ runner */

/**
 * 创建一个动作执行器（共享一个 sidecar 进程 + 一份设置）。
 * @param {{settings:object, log?:Function, env?:NodeJS.ProcessEnv, root?:string}} options
 */
export function createInputRunner(options = {}) {
  const env = options.env || process.env
  let settings = options.settings
  const log = options.log || (() => {})
  const sidecar = new SidecarClient({ settings, log, env, root: options.root })
  let queue = Promise.resolve()

  sidecar.on('theme', (payload) => {
    log('debug', `主题变化：${payload.scheme} → ${payload.cursorTheme} 光标`)
  })

  /** 串行执行：鼠标键盘动作不能并发，否则 hwnd/坐标会互相踩。 */
  function serialize(task) {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  async function statusSnapshot() {
    const status = await sidecar.request('status', {}, ACTION_TIMEOUTS.status)
    const theme = detectWindowsTheme()
    const cursorTheme = resolveCursorTheme(settings?.cursorTheme, theme)
    return { status, theme, cursorTheme }
  }

  async function runSettingsPatch(patch) {
    const next = normalizeSettings(patch, settings)
    // 写盘：agent 改的设置要能活过重启（不写 ACI_* 环境变量覆盖出来的值）
    try {
      saveSettings(next, env)
    } catch (error) {
      log('warn', `设置写盘失败（本次仍然生效）：${error?.message || error}`)
    }
    await sidecar.applySettings(next)
    settings = next
    return { ok: true, via: 'api', settings: next }
  }

  /**
   * @param {object} args
   * @returns {Promise<{text:string, meta:object, images:Array}>}
   */
  async function runAction(args = {}) {
    const action = String(args.action || 'status').toLowerCase()
    const context = { cursorMode: settings?.cursorMode, cursorHoldMs: settings?.cursorHoldMs, cursorSize: settings?.cursorSize }

    return serialize(async () => {
      try {
        if (!settings?.enabled && action !== 'status' && action !== 'resume') {
          return finish(`输入通道已关闭：在设置里打开「启用」再操作（settings.json 或 action:"settings" enabled:true）。`, {
            ok: false,
            enabled: false,
          })
        }
        const wantsPhysical = String(args.mode || '').toLowerCase() === 'physical'
        if (wantsPhysical && !settings?.allowPhysical) {
          return finish('physical 已禁用：真实鼠标会动主人的光标、真实键盘会抢焦点。请用 mode:"auto"（目标 hwnd + UIA / 窗口消息）；确需真实输入，先把 allowPhysical 打开。', {
            ok: false,
            reason: 'physical-forbidden',
            strictNoRealMouse: true,
            strictNoFocusSteal: true,
          })
        }
        if (!ACTION_TIMEOUTS[action]) {
          return finish(`未知 action。可用：${ACTIONS.join(' / ')}`, { ok: false, action })
        }

        if (action === 'status') {
          const snap = await statusSnapshot()
          return finish(statusText(snap.status, { theme: snap.theme, cursorTheme: snap.cursorTheme }), {
            ...snap.status,
            theme: snap.theme,
            cursorTheme: snap.cursorTheme,
            settings,
          })
        }

        if (action === 'settings') {
          const patch = {}
          for (const key of ['enabled', 'cursorMode', 'cursorHoldMs', 'cursorSize', 'cursorTheme', 'cursorOpacity', 'animations', 'hotkey', 'allowPhysical', 'idleShutdownMs']) {
            if (args[key] !== undefined) patch[key] = args[key]
          }
          if (args.set && typeof args.set === 'object') Object.assign(patch, args.set)
          const result = await runSettingsPatch(patch)
          return finish(actionText('settings', result, context), { ...result, settings })        }

        if (action === 'windows') {
          const result = await sidecar.request('windows', {}, ACTION_TIMEOUTS.windows)
          let list = Array.isArray(result?.windows) ? result.windows : []
          const query = String(args.query || '').trim().toLowerCase()
          if (query) {
            list = list.filter((w) => `${w.title} ${w.process} ${w.className}`.toLowerCase().includes(query))
          }
          const trimmed = { ...result, windows: list }
          return finish(windowsText(trimmed), trimmed)
        }

        if (action === 'inspect') {
          const hwnd = pickHwnd(args)
          if (!hwnd) return finish('inspect 需要 hwnd（先用 action:"windows" 拿）。', { ok: false, reason: 'need-hwnd' })
          const result = await sidecar.request('winInfo', { hwnd }, ACTION_TIMEOUTS.inspect)
          return finish(actionText('inspect', result, context), result)
        }

        if (action === 'pause') {
          const result = await sidecar.request('pause', {}, ACTION_TIMEOUTS.pause)
          return finish(`已暂停。\n${statusText(result, { cursorTheme: resolveCursorTheme(settings?.cursorTheme) })}`, result)
        }

        if (action === 'resume') {
          const result = await sidecar.request('resume', {}, ACTION_TIMEOUTS.resume)
          return finish(`已恢复。\n${statusText(result, { cursorTheme: resolveCursorTheme(settings?.cursorTheme) })}`, result)
        }

        if (action === 'move') {
          const x = pickNumber(args.x)
          const y = pickNumber(args.y)
          if (x === undefined || y === undefined) return finish('move 需要 x、y。', { ok: false, reason: 'need-point' })
          const result = await sidecar.request('move', { x, y, cursorState: args.cursorState }, ACTION_TIMEOUTS.move)
          const meta = { ...result, ...context, cursorState: result.cursorState || args.cursorState || 'pointer' }
          return finish(actionText('move', meta, context), meta)
        }

        if (action === 'overlay') {
          if (args.cursorSize !== undefined) {
            await sidecar.request('setCursorSize', { size: Math.round(Number(args.cursorSize)) }, 12000)
          }
          if (args.cursorOpacity !== undefined) {
            await sidecar.request('setCursorOpacity', { opacity: Number(args.cursorOpacity) }, 12000)
          }
          if (args.cursorTheme !== undefined) {
            await sidecar.request('setCursorTheme', { theme: String(args.cursorTheme) }, 15000)
          }
          if (args.show === false) {
            const result = await sidecar.request('overlay', { show: false }, ACTION_TIMEOUTS.overlay)
            return finish(actionText('overlay', { ...result, visible: false }, context), { ...result, visible: false })
          }
          const x = pickNumber(args.x)
          const y = pickNumber(args.y)
          const result = await sidecar.request('overlay', {
            show: true,
            x,
            y,
            cursorState: args.cursorState,
          }, ACTION_TIMEOUTS.overlay)
          const meta = { ...result, ...context, cursorState: result.cursorState || args.cursorState || 'pointer' }
          return finish(actionText('overlay', meta, context), meta)
        }

        if (action === 'click') {
          const hwnd = pickHwnd(args)
          const result = await sidecar.request('click', {
            x: pickNumber(args.x),
            y: pickNumber(args.y),
            button: args.button || 'left',
            count: pickNumber(args.count) || 1,
            mode: args.mode || 'auto',
            hwnd,
            cursorState: args.cursorState,
          }, ACTION_TIMEOUTS.click)
          return finish(actionText('click', result, context), result)
        }

        if (action === 'type') {
          const result = await sidecar.request('type', {
            x: pickNumber(args.x),
            y: pickNumber(args.y),
            text: String(args.text ?? ''),
            replace: args.replace === true,
            mode: args.mode || 'auto',
            hwnd: pickHwnd(args),
            cursorState: args.cursorState,
          }, ACTION_TIMEOUTS.type)
          return finish(actionText('type', result, context), result)
        }

        if (action === 'key') {
          const result = await sidecar.request('key', {
            keys: String(args.keys || ''),
            mode: args.mode || 'auto',
            hwnd: pickHwnd(args),
            cursorState: args.cursorState,
          }, ACTION_TIMEOUTS.key)
          return finish(actionText('key', result, context), result)
        }

        if (action === 'scroll') {
          const result = await sidecar.request('scroll', {
            x: pickNumber(args.x),
            y: pickNumber(args.y),
            delta: pickNumber(args.delta) ?? -120,
            mode: args.mode || 'auto',
            hwnd: pickHwnd(args),
            cursorState: args.cursorState,
          }, ACTION_TIMEOUTS.scroll)
          return finish(actionText('scroll', result, context), result)
        }

        if (action === 'drag') {
          const result = await sidecar.request('drag', {
            x: pickNumber(args.x),
            y: pickNumber(args.y),
            toX: pickNumber(args.toX),
            toY: pickNumber(args.toY),
            durationMs: pickNumber(args.durationMs) ?? 400,
            mode: args.mode || 'auto',
            hwnd: pickHwnd(args),
            cursorState: args.cursorState,
          }, ACTION_TIMEOUTS.drag)
          return finish(actionText('drag', result, context), result)
        }

        if (action === 'capture') {
          const { result, images, meta } = await capture({ sidecar, settings, args, env })
          return {
            text: actionText('capture', result, context),
            meta: toSafeJson(meta),
            images,
          }
        }

        return finish(`未知 action：${action}。可用：${ACTIONS.join(' / ')}`, { ok: false, action })
      } catch (error) {
        const code = error instanceof SidecarError ? error.code : 'error'
        const detail = error instanceof SidecarError && error.detail ? `\n${String(error.detail).slice(0, 800)}` : ''
        return finish(`没完成：${error?.message || error}${detail}`, { ok: false, action, code })
      }
    })
  }

  function finish(text, meta) {
    return { text, meta: toSafeJson(meta || {}), images: [] }
  }

  async function updateSettings(nextSettings) {
    settings = nextSettings
    const result = await sidecar.applySettings(nextSettings)
    return result
  }

  async function dispose() {
    await sidecar.stop({ force: true })
  }

  function info() {
    return { sidecar: sidecar.info, settings, alive: sidecar.alive }
  }

  return { runAction, updateSettings, dispose, info, sidecar, get settings() { return settings } }
}
