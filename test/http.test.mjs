import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHttpServer } from '../src/server/http.js'
import { createInputRunner } from '../src/core/actions.js'
import { loadSettings, saveSettings } from '../src/core/settings.js'

test('HTTP API：health / themes / settings / call', { timeout: 180000 }, async () => {
  if (process.platform !== 'win32') return
  const home = mkdtempSync(join(tmpdir(), 'aci-http-'))
  const env = { ...process.env, ACI_HOME: home, ACI_IDLE_SHUTDOWN_MS: '0' }
  const { settings } = loadSettings({ env })
  const runner = createInputRunner({ settings, log: () => {}, env })
  let current = settings
  const server = await startHttpServer({
    runner,
    getSettings: () => current,
    saveSettings: async (patch) => {
      current = saveSettings({ ...current, ...patch }, env)
      await runner.updateSettings(current)
      return current
    },
    log: () => {},
    port: 0,
  })
  const base = `http://127.0.0.1:${server.port}`
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json())
    assert.equal(health.ok, true)
    assert.equal(health.tool, 'computer_input')

    const themes = await fetch(`${base}/themes`).then((r) => r.json())
    assert.equal(themes.ok, true)
    assert.ok(themes.manifest.themes.light.states.pointer)
    assert.ok(themes.manifest.themes.dark.states.pointer)

    const png = await fetch(`${base}/cursors/light/pointer.png`)
    assert.equal(png.status, 200)
    assert.equal(png.headers.get('content-type'), 'image/png')
    const bytes = Buffer.from(await png.arrayBuffer())
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG')

    const call = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    }).then((r) => r.json())
    assert.equal(call.ok, true)
    assert.ok(call.text.includes('输入通道'))

    const saved = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cursorMode: 'clean', cursorSize: 120 }),
    }).then((r) => r.json())
    assert.equal(saved.settings.cursorMode, 'clean')
    assert.equal(saved.settings.cursorSize, 120)

    const notFound = await fetch(`${base}/nope`)
    assert.equal(notFound.status, 404)
  } finally {
    await server.close()
    await runner.dispose().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})
