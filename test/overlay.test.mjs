import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSettings } from '../src/core/settings.js'
import { createInputRunner } from '../src/core/actions.js'

test('sidecar：主题切换 / 尺寸 / 不透明度 / 动画 / 热点', { timeout: 180000 }, async () => {
  if (process.platform !== 'win32') return
  const { settings } = loadSettings({ patch: { enabled: true, idleShutdownMs: 0, cursorSize: 96, cursorTheme: 'auto' } })
  const runner = createInputRunner({ settings, log: () => {} })
  try {
    const status = await runner.runAction({ action: 'status' })
    assert.equal(status.meta.ok !== false, true, status.text)
    assert.ok(status.meta.cursorStates.includes('pointer'))
    assert.ok(status.meta.cursorStates.includes('pin'), '素材包多出的状态也应暴露出来')

    // 强制浅色主题用的光标（深色箭头，light 目录）
    await runner.runAction({ action: 'overlay', cursorTheme: 'light', x: 400, y: 300 })
    let s = await runner.runAction({ action: 'status' })
    assert.equal(s.meta.activeCursorTheme, 'light')

    // 强制深色主题用的光标（浅色箭头，dark 目录）
    await runner.runAction({ action: 'overlay', cursorTheme: 'dark', x: 400, y: 300 })
    s = await runner.runAction({ action: 'status' })
    assert.equal(s.meta.activeCursorTheme, 'dark')

    // 回到 auto：应等于当前 Windows 应用主题
    await runner.runAction({ action: 'overlay', cursorTheme: 'auto' })
    s = await runner.runAction({ action: 'status' })
    assert.equal(s.meta.activeCursorTheme, s.meta.theme.scheme, 'auto 应跟随系统主题')

    // 尺寸 + 热点偏移：pointer 热点 8/128，96px → 6
    await runner.runAction({ action: 'overlay', cursorSize: 96, cursorState: 'pointer', x: 500, y: 400 })
    s = await runner.runAction({ action: 'status' })
    assert.equal(s.meta.cursorSize, 96)
    assert.deepEqual(s.meta.overlayOffset, [6, 6], `pointer@96 热点偏移应等比缩放：${s.meta.overlayOffset}`)

    // 尺寸 192 → 偏移 12
    await runner.runAction({ action: 'overlay', cursorSize: 192 })
    s = await runner.runAction({ action: 'status' })
    assert.deepEqual(s.meta.overlayOffset, [12, 12])

    // 对称状态热点在中心：cross 64/128 → 96px 时 48
    await runner.runAction({ action: 'overlay', cursorSize: 96, cursorState: 'cross' })
    s = await runner.runAction({ action: 'status' })
    assert.deepEqual(s.meta.overlayOffset, [48, 48], `cross 热点应在中心：${s.meta.overlayOffset}`)

    // 不透明度
    await runner.runAction({ action: 'overlay', cursorOpacity: 0.5 })
    s = await runner.runAction({ action: 'status' })
    assert.equal(s.meta.cursorOpacity, 0.5)

    // 隐藏后 status 应反映
    await runner.runAction({ action: 'overlay', show: false })
    s = await runner.runAction({ action: 'status' })
    assert.equal(s.meta.overlay, false)

    // 设置整体下发（configure）
    const configured = await runner.updateSettings({ ...settings, cursorSize: 128, cursorTheme: 'light', cursorOpacity: 0.8, animations: false, cursorMode: 'clean', cursorHoldMs: 900 })
    assert.equal(configured.ok, true)
    s = await runner.runAction({ action: 'status' })
    assert.equal(s.meta.cursorSize, 128)
    assert.equal(s.meta.activeCursorTheme, 'light')
    assert.equal(s.meta.animations, false)
    assert.equal(s.meta.cursorMode, 'clean')
    assert.equal(s.meta.cursorHoldMs, 900)
  } finally {
    await runner.dispose().catch(() => {})
  }
})
