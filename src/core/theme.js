/**
 * agent-computer-input · 主题探测（Node 侧）
 *
 * 只做两件事：
 *   1. 读 Windows「应用主题」→ light / dark，用来在状态里报告、给设置页挑缩略图；
 *   2. 把用户设置（auto/light/dark）解析成实际使用的光标主题目录名。
 *
 * 覆盖层的真正换肤在 sidecar 里做（它自己读注册表、自己换图，主题变了不用 Node 参与），
 * 这里的结果只用于展示和「设置页预览」。两边用同一条规则：
 *   浅色主题 → 深色光标（Vision Cursor Black）  → 目录 light
 *   深色主题 → 浅色光标（Vision Cursor White）  → 目录 dark
 */

import { execFileSync } from 'node:child_process'

const PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
const CACHE_TTL_MS = 5000

let cache = { at: 0, value: null }

function queryDword(name) {
  try {
    const out = execFileSync('reg', ['query', PERSONALIZE_KEY, '/v', name], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    })
    const match = /0x([0-9a-f]+)/i.exec(out)
    if (!match) return null
    return parseInt(match[1], 16)
  } catch {
    return null
  }
}

/**
 * @param {{force?:boolean, env?:NodeJS.ProcessEnv}} [options]
 * @returns {{scheme:'light'|'dark', appsUseLightTheme:number|null, systemUsesLightTheme:number|null,
 *            source:'registry'|'env'|'assume', platform:string, cursorTheme:'light'|'dark'}}
 */
export function detectWindowsTheme(options = {}) {
  const env = options.env || process.env
  const now = Date.now()
  if (!options.force && cache.value && now - cache.at < CACHE_TTL_MS) return cache.value

  let result
  const forced = String(env.ACI_WINDOWS_THEME || '').toLowerCase()
  if (forced === 'light' || forced === 'dark') {
    result = {
      scheme: forced,
      appsUseLightTheme: forced === 'light' ? 1 : 0,
      systemUsesLightTheme: forced === 'light' ? 1 : 0,
      source: 'env',
      platform: process.platform,
      cursorTheme: forced === 'light' ? 'light' : 'dark',
    }
  } else if (process.platform !== 'win32') {
    result = {
      scheme: 'dark',
      appsUseLightTheme: null,
      systemUsesLightTheme: null,
      source: 'assume',
      platform: process.platform,
      cursorTheme: 'dark',
    }
  } else {
    const apps = queryDword('AppsUseLightTheme')
    const system = queryDword('SystemUsesLightTheme')
    const scheme = apps === 0 ? 'dark' : 'light'
    result = {
      scheme,
      appsUseLightTheme: apps,
      systemUsesLightTheme: system,
      source: apps === null ? 'assume' : 'registry',
      platform: process.platform,
      cursorTheme: scheme === 'light' ? 'light' : 'dark',
    }
  }

  cache = { at: now, value: result }
  return result
}

/**
 * 把设置里的 cursorTheme 解析成实际目录。
 * @param {'auto'|'light'|'dark'} setting
 * @param {ReturnType<typeof detectWindowsTheme>} [detected]
 */
export function resolveCursorTheme(setting, detected = detectWindowsTheme()) {
  if (setting === 'light' || setting === 'dark') return setting
  return detected.cursorTheme
}

export function clearThemeCache() {
  cache = { at: 0, value: null }
}
