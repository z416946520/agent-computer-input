/**
 * agent-computer-input · 设置
 *
 * 单一设置源：`~/.agent-computer-input/settings.json`（可用 ACI_HOME 覆盖根目录）。
 * 优先级：显式参数 > 环境变量 > settings.json > 默认值。
 *
 * 这里不依赖任何 agent 宿主；DSH 插件、MCP server、HTTP server、CLI 共用同一份设置。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CURSOR_MODES = ['companion', 'clean']
export const CURSOR_THEMES = ['auto', 'light', 'dark']

export const DEFAULT_SETTINGS = Object.freeze({
  /** 总开关：false 时任何动作都不执行 */
  enabled: true,
  /** companion = 一直显示；clean = 动作后停留 cursorHoldMs 再收起 */
  cursorMode: 'companion',
  cursorHoldMs: 2600,
  /** 覆盖层边长（px），素材按 nativeWidth 等比缩放 */
  cursorSize: 96,
  /** auto = 跟随 Windows 应用主题；light/dark 强制覆盖 */
  cursorTheme: 'auto',
  /** 覆盖层不透明度 0.2–1 */
  cursorOpacity: 1,
  /** 是否播放 .ani 动画状态（work/busy） */
  animations: true,
  /** 暂停热键，空字符串 = 不注册 */
  hotkey: 'Ctrl+Alt+Q',
  /** 是否允许 physical（真实鼠标/键盘）。默认 false：会动真实光标、抢焦点 */
  allowPhysical: false,
  /** 无请求多久后自动退出 sidecar，0 = 不退出 */
  idleShutdownMs: 10 * 60 * 1000,
  /** 截图目录，null = ~/.agent-computer-input/shots */
  shotsDir: null,
})

const ENV_MAP = {
  ACI_ENABLED: (v) => parseBool(v),
  ACI_CURSOR_MODE: (v) => (String(v).toLowerCase() === 'clean' ? 'clean' : 'companion'),
  ACI_CURSOR_HOLD_MS: (v) => parseIntIn(v, 300, 60000),
  ACI_CURSOR_SIZE: (v) => parseIntIn(v, 24, 192),
  ACI_CURSOR_THEME: (v) => (CURSOR_THEMES.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : null),
  ACI_CURSOR_OPACITY: (v) => parseFloatIn(v, 0.2, 1),
  ACI_ANIMATIONS: (v) => parseBool(v),
  ACI_HOTKEY: (v) => String(v),
  ACI_ALLOW_PHYSICAL: (v) => parseBool(v),
  ACI_IDLE_SHUTDOWN_MS: (v) => parseIntIn(v, 0, 24 * 60 * 60 * 1000),
}

function parseBool(value) {
  const s = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true
  if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false
  return null
}

function parseIntIn(value, min, max) {
  const n = Number.parseInt(String(value), 10)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

function parseFloatIn(value, min, max) {
  const n = Number.parseFloat(String(value))
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/** 插件/sidecar 数据根目录。 */
export function resolveHome(env = process.env) {
  return env.ACI_HOME || join(homedir(), '.agent-computer-input')
}

export function settingsPath(env = process.env) {
  return join(resolveHome(env), 'settings.json')
}

export function shotsDir(settings, env = process.env) {
  return settings?.shotsDir || join(resolveHome(env), 'shots')
}

/**
 * 合并 & 夹取，任何输入都不会得到非法设置。
 * @param {object} patch
 * @param {object} [base]
 */
export function normalizeSettings(patch = {}, base = DEFAULT_SETTINGS) {
  const merged = { ...DEFAULT_SETTINGS, ...(base || {}), ...(patch || {}) }
  const out = {
    enabled: typeof merged.enabled === 'boolean' ? merged.enabled : DEFAULT_SETTINGS.enabled,
    cursorMode: CURSOR_MODES.includes(merged.cursorMode) ? merged.cursorMode : DEFAULT_SETTINGS.cursorMode,
    cursorHoldMs: clampInt(merged.cursorHoldMs, 300, 60000, DEFAULT_SETTINGS.cursorHoldMs),
    cursorSize: clampInt(merged.cursorSize, 24, 192, DEFAULT_SETTINGS.cursorSize),
    cursorTheme: CURSOR_THEMES.includes(merged.cursorTheme) ? merged.cursorTheme : 'auto',
    cursorOpacity: clampFloat(merged.cursorOpacity, 0.2, 1, DEFAULT_SETTINGS.cursorOpacity),
    animations: typeof merged.animations === 'boolean' ? merged.animations : DEFAULT_SETTINGS.animations,
    hotkey: typeof merged.hotkey === 'string' ? merged.hotkey.trim() : DEFAULT_SETTINGS.hotkey,
    allowPhysical: typeof merged.allowPhysical === 'boolean' ? merged.allowPhysical : DEFAULT_SETTINGS.allowPhysical,
    idleShutdownMs: clampInt(merged.idleShutdownMs, 0, 24 * 60 * 60 * 1000, DEFAULT_SETTINGS.idleShutdownMs),
    shotsDir: typeof merged.shotsDir === 'string' && merged.shotsDir.trim() ? merged.shotsDir : null,
  }
  return out
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 只读环境变量覆盖（环境变量不该被写回磁盘）。 */
export function envOverrides(env = process.env) {
  const out = {}
  for (const [key, parse] of Object.entries(ENV_MAP)) {
    if (env[key] === undefined || env[key] === '') continue
    const value = parse(env[key])
    if (value === null) continue
    out[envKeyToSetting(key)] = value
  }
  return out
}

function envKeyToSetting(key) {
  const map = {
    ACI_ENABLED: 'enabled',
    ACI_CURSOR_MODE: 'cursorMode',
    ACI_CURSOR_HOLD_MS: 'cursorHoldMs',
    ACI_CURSOR_SIZE: 'cursorSize',
    ACI_CURSOR_THEME: 'cursorTheme',
    ACI_CURSOR_OPACITY: 'cursorOpacity',
    ACI_ANIMATIONS: 'animations',
    ACI_HOTKEY: 'hotkey',
    ACI_ALLOW_PHYSICAL: 'allowPhysical',
    ACI_IDLE_SHUTDOWN_MS: 'idleShutdownMs',
  }
  return map[key]
}

export function readSettingsFile(env = process.env) {
  const file = settingsPath(env)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeSettingsFile(settings, env = process.env) {
  const file = settingsPath(env)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return file
}

/** 磁盘 + 环境变量 + 显式 patch 合成最终设置。 */
export function loadSettings({ patch = {}, env = process.env, persist = false } = {}) {
  const base = normalizeSettings(readSettingsFile(env))
  const withEnv = normalizeSettings(envOverrides(env), base)
  const final = normalizeSettings(patch, withEnv)
  return { settings: final, file: settingsPath(env), envOverrides: envOverrides(env), onDisk: readSettingsFile(env), persist }
}

/** 把改动写盘（只写用户意图，不写环境变量覆盖出来的值）。 */
export function saveSettings(patch, env = process.env) {
  const current = readSettingsFile(env)
  const next = normalizeSettings(patch, normalizeSettings(current))
  writeSettingsFile(next, env)
  return next
}
