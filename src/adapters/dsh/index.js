/**
 * agent-computer-input · DSH 插件适配层（可选）
 *
 * 核心能力在 src/core + src/server，这里只做「DSH 需要什么就补什么」：
 *   - tools.register 一个 `computer_input` 工具（schema 来自 tool-spec）
 *   - 设置页 HTTP API（/agent-computer-input/api）
 *   - 光标素材预视图（/agent-computer-input/assets/:theme/:state.png）
 *   - 截图 → DSH attachments
 *
 * 不用 DSH 的话，MCP / HTTP / CLI 三条路完全不依赖这个文件。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSettings, saveSettings, normalizeSettings, settingsPath } from '../../core/settings.js'
import { createInputRunner, ACTIONS, CURSOR_STATES } from '../../core/actions.js'
import { detectWindowsTheme, resolveCursorTheme } from '../../core/theme.js'
import { TOOL_NAME, TOOL_DESCRIPTION, flatParameters, OUTPUT_SCHEMA } from '../../core/tool-spec.js'
import { ASSETS_ROOT, PACKAGE_ROOT } from '../../core/sidecar.js'
import { ensureCursorAssets } from '../../core/cursor-build.js'

export const name = 'agent-computer-input'
export const inject = ['tools', 'attachments', 'webServer']

const API_PREFIX = '/agent-computer-input/api'
const ASSET_PREFIX = '/agent-computer-input/assets'

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod?.defineTool) return mod.defineTool
  } catch { /* 单元测试 / 独立运行 */ }
  return (definition) => definition
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export async function apply(ctx, rawConfig = {}) {
  const defineTool = await loadDefineTool()
  const log = (level, message) => {
    try {
      const fn = level === 'warn' || level === 'error' ? (ctx?.logger?.warn || ctx?.logger?.info) : ctx?.logger?.info
      fn?.call(ctx?.logger, `[agent-computer-input] ${message}`)
    } catch { /* ignore */ }
  }

  await ensureCursorAssets(PACKAGE_ROOT, (line) => log('info', line)).catch((error) => log('warn', `光标烘焙失败：${error.message}`))

  const loaded = loadSettings({ patch: rawConfig })
  let settings = loaded.settings
  const runner = createInputRunner({ settings, log })

  const tool = {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: flatParameters(),
    async execute(args = {}) {
      const outcome = await runner.runAction(args)
      const images = []
      for (const image of outcome.images || []) {
        try {
          const svc = ctx?.attachments
          if (svc?.saveImage) {
            const ref = await svc.saveImage.call(svc, {
              data: Buffer.from(image.data, 'base64'),
              mediaType: image.mediaType,
              name: image.name || `agent-computer-input-${Date.now()}.png`,
            })
            images.push(ref)
          }
        } catch (error) {
          log('warn', `截图附件保存失败：${error?.message || error}`)
        }
      }
      return { text: outcome.text, images, meta: outcome.meta }
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const blocks = []
        for (const image of value.images || []) blocks.push({ type: 'image', attachment: image })
        blocks.push({ type: 'text', text: value.text })
        return blocks
      },
    },
    timeoutMs: 180000,
    isConcurrencySafe() {
      return false
    },
  }

  const dispose = ctx.tools.register(defineTool(tool))

  const runtimeInfo = () => {
    const theme = detectWindowsTheme()
    return {
      theme,
      cursorTheme: resolveCursorTheme(settings.cursorTheme, theme),
      cursorStates: CURSOR_STATES,
      actions: ACTIONS,
      settingsFile: settingsPath(),
      sidecar: runner.info(),
    }
  }

  const apiHandler = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) {
      if (typeof next === 'function') return next()
      return json(res, 404, { ok: false, error: 'not found' })
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && route === '/settings') {
        return json(res, 200, { ok: true, settings, runtime: runtimeInfo() })
      }
      if (req.method === 'POST' && route === '/settings') {
        const body = await readBody(req)
        settings = saveSettings(normalizeSettings(body, settings))
        await runner.updateSettings(settings)
        return json(res, 200, { ok: true, settings, runtime: runtimeInfo() })
      }
      if (req.method === 'POST' && route === '/hide') {
        const outcome = await runner.runAction({ action: 'overlay', show: false })
        return json(res, 200, { ok: true, text: outcome.text })
      }
      if (req.method === 'POST' && route === '/show') {
        if (!settings.enabled) return json(res, 409, { ok: false, error: '总开关关着，先在设置里启用。' })
        const outcome = await runner.runAction({ action: 'overlay', show: true })
        return json(res, 200, { ok: true, text: outcome.text, meta: outcome.meta })
      }
      if (req.method === 'POST' && route === '/call') {
        const body = await readBody(req)
        const outcome = await runner.runAction(body)
        return json(res, 200, { ok: outcome.meta?.ok !== false, text: outcome.text, meta: outcome.meta })
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      log('warn', `HTTP ${req.method} ${route} 失败：${error?.message || error}`)
      return json(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  const assetHandler = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(ASSET_PREFIX)) {
      if (typeof next === 'function') return next()
      return json(res, 404, { ok: false, error: 'not found' })
    }
    try {
      const rel = url.pathname.slice(ASSET_PREFIX.length).replace(/^\//, '')
      if (rel === 'manifest.json') {
        const buffer = await readFile(join(ASSETS_ROOT, 'manifest.json'))
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        return res.end(buffer)
      }
      const match = /^(light|dark)\/([a-z0-9_-]+)\.png$/i.exec(rel)
      if (!match) return json(res, 404, { ok: false, error: 'not found' })
      const [, theme, state] = match
      const buffer = await readFile(join(ASSETS_ROOT, theme.toLowerCase(), `${state.toLowerCase()}.png`))
      res.statusCode = 200
      res.setHeader('content-type', 'image/png')
      res.setHeader('cache-control', 'public, max-age=3600')
      return res.end(buffer)
    } catch {
      return json(res, 404, { ok: false, error: 'not found' })
    }
  }

  try {
    if (ctx?.webServer && typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }), 'agent-computer-input: api')
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ASSET_PREFIX, handler: assetHandler }), 'agent-computer-input: assets')
    } else {
      log('warn', 'webServer 不可用：设置页 API 没挂上')
    }
  } catch (error) {
    log('warn', `设置页 API 挂载失败：${error?.message || error}`)
  }

  return async () => {
    try { dispose?.() } catch { /* ignore */ }
    await runner.dispose()
  }
}
