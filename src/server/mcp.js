/**
 * agent-computer-input · MCP stdio server
 *
 * 任何支持 MCP 的 agent（Claude Code / Claude Desktop / Cursor / Codex / ZCode / 其它）
 * 都能接这一层：一个 `computer_input` 工具，newline-delimited JSON-RPC。
 *
 * 用法（客户端配置）：
 *   { "mcpServers": { "agent-computer-input": { "command": "node", "args": ["<pkg>/bin/aci-mcp.js"] } } }
 */

import { createInterface } from 'node:readline'
import { TOOL_NAME, TOOL_DESCRIPTION, PARAMETERS_SCHEMA, PACKAGE_NAME } from '../core/tool-spec.js'
import { loadSettings } from '../core/settings.js'
import { createInputRunner } from '../core/actions.js'

const SERVER_INFO = { name: PACKAGE_NAME, version: '0.3.0' }
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

class McpServer {
  constructor({ settings, log }) {
    this.runner = createInputRunner({ settings, log })
    this.log = log
  }

  send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }

  ok(id, result) {
    this.send({ jsonrpc: '2.0', id, result })
  }

  fail(id, code, message) {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  async handle(message) {
    const { id, method, params } = message
    if (method === undefined) return // 客户端回应
    if (id === undefined) {
      // 通知：不用回
      return
    }
    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]
          this.ok(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: TOOL_DESCRIPTION,
          })
          return
        }
        case 'ping':
          this.ok(id, {})
          return
        case 'tools/list':
          this.ok(id, {
            tools: [{
              name: TOOL_NAME,
              title: 'Agent Computer Input',
              description: TOOL_DESCRIPTION,
              inputSchema: PARAMETERS_SCHEMA,
            }],
          })
          return
        case 'tools/call': {
          const name = params?.name
          if (name !== TOOL_NAME) {
            this.fail(id, -32602, `未知工具：${name}（只有 ${TOOL_NAME}）`)
            return
          }
          const args = params?.arguments || {}
          const outcome = await this.runner.runAction(args)
          const content = []
          for (const image of outcome.images || []) {
            content.push({ type: 'image', data: image.data, mimeType: image.mediaType })
          }
          content.push({ type: 'text', text: outcome.text })
          this.ok(id, {
            content,
            structuredContent: { text: outcome.text, meta: outcome.meta, images: outcome.images?.length || 0 },
            isError: outcome.meta?.ok === false,
          })
          return
        }
        case 'shutdown':
          await this.runner.dispose()
          this.ok(id, {})
          process.exit(0)
          return
        default:
          this.fail(id, -32601, `未实现的方法：${method}`)
      }
    } catch (error) {
      this.log('error', `MCP ${method} 失败：${error?.message || error}`)
      this.fail(id, -32603, String(error?.message || error))
    }
  }

  async close() {
    await this.runner.dispose()
  }
}

export async function startMcpServer(options = {}) {
  const { settings } = loadSettings({ patch: options.patch || {}, env: options.env })
  const log = options.log || ((level, message) => {
    if (level === 'error' || level === 'warn') process.stderr.write(`[agent-computer-input] ${message}\n`)
  })
  const server = new McpServer({ settings, log })

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (/^content-length:/i.test(trimmed)) return // 兼容用 Content-Length 框架的客户端
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      server.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    if (Array.isArray(message)) {
      for (const item of message) server.handle(item)
      return
    }
    server.handle(message)
  })
  const bye = async () => {
    try { await server.close() } catch { /* ignore */ }
    process.exit(0)
  }
  rl.on('close', bye)
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
  return server
}
