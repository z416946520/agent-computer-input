/**
 * agent-computer-input · 本地 HTTP API
 *
 * 给「不是 MCP 客户端」的 agent / 脚本用：
 *   GET  /health                 → 存活 + sidecar 状态
 *   GET  /settings               → 当前设置
 *   POST /settings               → 改设置并立即生效
 *   POST /call                   → 执行一个动作，body 就是工具参数
 *   GET  /themes                 → 主题 / 状态 / 素材信息
 *   GET  /cursors/:theme/:state.png
 *
 * 默认只听 127.0.0.1；要暴露到局域网请自己加反代，并设置 ACI_HTTP_TOKEN。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ASSETS_ROOT } from '../core/sidecar.js'
import { TOOL_NAME, PACKAGE_NAME } from '../core/tool-spec.js'

const MAX_BODY = 256 * 1024

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
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
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type, authorization')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.end(body)
}

/**
 * @param {{runner:ReturnType<import('../core/actions.js').createInputRunner>,
 *          getSettings:()=>object, saveSettings:(patch:object)=>Promise<object>,
 *          log?:Function, token?:string, host?:string, port?:number}} options
 */
export async function startHttpServer(options) {
  const { runner, getSettings, saveSettings } = options
  const log = options.log || (() => {})
  const token = options.token || process.env.ACI_HTTP_TOKEN || ''
  const host = options.host || process.env.ACI_HTTP_HOST || '127.0.0.1'
  const port = Number(options.port ?? process.env.ACI_HTTP_PORT ?? 4517)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-headers', 'content-type, authorization')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      return res.end()
    }
    if (token) {
      const given = req.headers.authorization || ''
      if (given !== `Bearer ${token}`) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    }

    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        return sendJson(res, 200, {
          ok: true,
          name: PACKAGE_NAME,
          tool: TOOL_NAME,
          settings: getSettings(),
          sidecar: runner.info(),
        })
      }
      if (req.method === 'GET' && url.pathname === '/settings') {
        return sendJson(res, 200, { ok: true, settings: getSettings() })
      }
      if (req.method === 'POST' && url.pathname === '/settings') {
        const body = await readJson(req)
        const settings = await saveSettings(body)
        return sendJson(res, 200, { ok: true, settings })
      }
      if (req.method === 'POST' && (url.pathname === '/call' || url.pathname === '/actions')) {
        const body = await readJson(req)
        const outcome = await runner.runAction(body)
        return sendJson(res, 200, {
          ok: outcome.meta?.ok !== false,
          text: outcome.text,
          meta: outcome.meta,
          images: outcome.images,
        })
      }
      if (req.method === 'GET' && url.pathname === '/themes') {
        try {
          const manifest = JSON.parse(await readFile(join(ASSETS_ROOT, 'manifest.json'), 'utf8'))
          return sendJson(res, 200, { ok: true, manifest })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: `读取 manifest 失败：${error.message}` })
        }
      }
      const cursorMatch = /^\/cursors\/(light|dark)\/([a-z0-9_-]+)\.png$/i.exec(url.pathname)
      if (req.method === 'GET' && cursorMatch) {
        const [, theme, state] = cursorMatch
        const file = join(ASSETS_ROOT, theme.toLowerCase(), `${state.toLowerCase()}.png`)
        if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'no-such-cursor' })
        const buffer = await readFile(file)
        res.statusCode = 200
        res.setHeader('content-type', 'image/png')
        res.setHeader('cache-control', 'public, max-age=600')
        res.setHeader('content-length', buffer.length)
        res.setHeader('access-control-allow-origin', '*')
        return res.end(buffer)
      }
      return sendJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      log('warn', `HTTP ${req.method} ${url.pathname} 失败：${error?.message || error}`)
      return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  log('info', `HTTP API 监听 http://${host}:${address.port}（POST /call 执行动作）`)
  return { server, port: address.port, host, close: () => new Promise((resolve) => server.close(resolve)) }
}
