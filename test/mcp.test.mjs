import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('MCP stdio：initialize / tools/list 返回 computer_input', { timeout: 60000 }, async () => {
  const proc = spawn(process.execPath, [join(ROOT, 'bin', 'aci-mcp.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ACI_HOME: join(ROOT, 'test', '.aci-home') },
  })
  const responses = new Map()
  const rl = createInterface({ input: proc.stdout })
  let stderr = ''
  proc.stderr.on('data', (chunk) => { stderr += chunk })
  rl.on('line', (line) => {
    if (!line.trim()) return
    const message = JSON.parse(line)
    if (message.id !== undefined) responses.set(message.id, message)
  })

  const send = (message) => proc.stdin.write(`${JSON.stringify(message)}\n`)
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

    const started = Date.now()
    while (!responses.has(2) && Date.now() - started < 30000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const init = responses.get(1)
    assert.ok(init, `没有 initialize 响应：${stderr}`)
    assert.equal(init.result.serverInfo.name, 'agent-computer-input')
    assert.ok(['2025-06-18', '2025-03-26', '2024-11-05'].includes(init.result.protocolVersion))

    const list = responses.get(2)
    assert.ok(list, '没有 tools/list 响应')
    assert.equal(list.result.tools.length, 1)
    const tool = list.result.tools[0]
    assert.equal(tool.name, 'computer_input')
    assert.ok(tool.inputSchema.properties.action.enum.includes('capture'))
    assert.ok(tool.description.includes('AI 光标'))
  } finally {
    try { proc.stdin.end() } catch { /* ignore */ }
    try { proc.kill() } catch { /* ignore */ }
  }
})
