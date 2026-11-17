import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeSettings, loadSettings, saveSettings, envOverrides, DEFAULT_SETTINGS, settingsPath,
} from '../src/core/settings.js'

test('normalizeSettings：非法值被夹到合法区间', () => {
  const s = normalizeSettings({
    cursorSize: 9999,
    cursorHoldMs: 1,
    cursorMode: 'nonsense',
    cursorTheme: 'darkish',
    cursorOpacity: 9,
    idleShutdownMs: -5,
    enabled: 'yes',
  })
  assert.equal(s.cursorSize, 192)
  assert.equal(s.cursorHoldMs, 300)
  assert.equal(s.cursorMode, 'companion')
  assert.equal(s.cursorTheme, 'auto')
  assert.equal(s.cursorOpacity, 1)
  assert.equal(s.idleShutdownMs, 0)
  assert.equal(s.enabled, true, '非 boolean 保持默认')
})

test('normalizeSettings：合并保留未知键以外的一切默认值', () => {
  const s = normalizeSettings({ cursorSize: 128 })
  assert.equal(s.cursorSize, 128)
  assert.equal(s.cursorMode, DEFAULT_SETTINGS.cursorMode)
  assert.equal(s.allowPhysical, false)
  assert.equal(s.hotkey, 'Ctrl+Alt+Q')
})

test('envOverrides：ACI_* 环境变量生效且不写回磁盘', () => {
  const env = {
    ACI_CURSOR_SIZE: '144',
    ACI_CURSOR_MODE: 'clean',
    ACI_CURSOR_THEME: 'dark',
    ACI_ANIMATIONS: '0',
    ACI_ALLOW_PHYSICAL: '1',
  }
  const overrides = envOverrides(env)
  assert.equal(overrides.cursorSize, 144)
  assert.equal(overrides.cursorMode, 'clean')
  assert.equal(overrides.cursorTheme, 'dark')
  assert.equal(overrides.animations, false)
  assert.equal(overrides.allowPhysical, true)

  const home = mkdtempSync(join(tmpdir(), 'aci-settings-'))
  try {
    const localEnv = { ...env, ACI_HOME: home }
    const { settings, file } = loadSettings({ env: localEnv })
    assert.equal(settings.cursorSize, 144)
    assert.equal(file, settingsPath(localEnv))
    assert.ok(file.startsWith(home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('saveSettings：落盘后可读回，且被夹取', () => {
  const home = mkdtempSync(join(tmpdir(), 'aci-save-'))
  try {
    const env = { ACI_HOME: home }
    const saved = saveSettings({ cursorSize: 500, cursorMode: 'clean', cursorTheme: 'light' }, env)
    assert.equal(saved.cursorSize, 192)
    assert.equal(saved.cursorMode, 'clean')

    const back = loadSettings({ env })
    assert.equal(back.settings.cursorSize, 192)
    assert.equal(back.settings.cursorMode, 'clean')
    assert.equal(back.settings.cursorTheme, 'light')
    assert.equal(back.settings.hotkey, DEFAULT_SETTINGS.hotkey)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('settings 动作：落地到磁盘（agent 改的设置能活过重启）', async () => {
  const { createInputRunner } = await import('../src/core/actions.js')
  const home = mkdtempSync(join(tmpdir(), 'aci-action-'))
  try {
    const env = { ...process.env, ACI_HOME: home, ACI_IDLE_SHUTDOWN_MS: '0' }
    const { settings } = loadSettings({ env })
    const runner = createInputRunner({ settings, env, log: () => {} })
    try {
      const outcome = await runner.runAction({ action: 'settings', cursorMode: 'clean', cursorSize: 136, cursorTheme: 'dark' })
      assert.equal(outcome.meta.ok, true, outcome.text)
      assert.equal(outcome.meta.settings.cursorSize, 136)
      const back = loadSettings({ env })
      assert.equal(back.settings.cursorSize, 136)
      assert.equal(back.settings.cursorMode, 'clean')
      assert.equal(back.settings.cursorTheme, 'dark')
    } finally {
      await runner.dispose()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
