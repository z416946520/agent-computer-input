import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInputRunner } from '../src/core/actions.js'
import { loadSettings } from '../src/core/settings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TESTAPP = join(HERE, 'testapp.ps1')
const LOG = join(HERE, 'testapp.log')
const META = join(HERE, 'testapp.json')
const SHOT = join(HERE, 'shot-test.png')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function logLines() {
  try {
    return readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

async function waitForFile(file, timeoutMs = 20000) {
  const started = Date.now()
  while (!existsSync(file)) {
    if (Date.now() - started > timeoutMs) throw new Error(`等不到 ${file}`)
    await sleep(100)
  }
}

/** 等到日志里出现某行（窗口消息是异步的，不能只 sleep 固定时长）。 */
async function waitForLog(predicate, timeoutMs = 4000) {
  const started = Date.now()
  let lines = []
  while (Date.now() - started < timeoutMs) {
    lines = logLines()
    if (lines.some(predicate)) return lines
    await sleep(100)
  }
  return lines
}

test('端到端：窗口消息 / UIA / 输入 / AI 光标 / 截图', { timeout: 300000 }, async () => {
  if (process.platform !== 'win32') {
    test.skip?.('只在 Windows 上跑')
    return
  }
  const app = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', TESTAPP,
  ], { windowsHide: false, env: { ...process.env, ACI_TESTAPP_BACKGROUND: '0' } })
  app.stderr.setEncoding('utf8')
  app.stderr.on('data', (chunk) => process.stderr.write(`[testapp] ${chunk}`))
  for (const stale of [META, SHOT]) {
    try { if (existsSync(stale)) unlinkSync(stale) } catch { /* ignore */ }
  }

  let runner = null
  try {
    await waitForFile(META)
    await sleep(600)
    const meta = JSON.parse(readFileSync(META, 'utf8'))
    assert.ok(meta.hwnd > 0)

    const { settings } = loadSettings({ patch: { enabled: true, cursorSize: 96, idleShutdownMs: 0 } })
    runner = createInputRunner({ settings, log: () => {} })

    const status = await runner.runAction({ action: 'status' })
    assert.equal(status.meta.ok !== false, true, status.text)
    assert.equal(status.meta.uia, true, 'UIA 应可用')
    assert.ok(['light', 'dark'].includes(status.meta.activeCursorTheme), status.text)
    assert.ok(status.text.includes('光标素材主题'))

    const windows = await runner.runAction({ action: 'windows' })
    assert.ok(Array.isArray(windows.meta.windows))
    const mine = windows.meta.windows.find((w) => w.hwnd === meta.hwnd)
    assert.ok(mine, '窗口列表里应有测试窗口')

    const inspect = await runner.runAction({ action: 'inspect', hwnd: meta.hwnd })
    assert.equal(inspect.meta.hwnd, meta.hwnd)
    assert.ok(inspect.meta.rect.w > 0)

    // 1) 窗口消息点击（不动真实光标）
    writeFileSync(LOG, '')
    const click1 = await runner.runAction({
      action: 'click', hwnd: meta.hwnd, x: meta.button.x, y: meta.button.y, mode: 'message',
    })
    assert.equal(click1.meta.ok, true, click1.text)
    let log = await waitForLog((line) => line === 'button')
    assert.ok(log.includes('button'), `消息点击没生效（via=${click1.meta.via}）：${log.join('|')}`)

    // 2) UIA 点击
    writeFileSync(LOG, '')
    const click2 = await runner.runAction({
      action: 'click', hwnd: meta.hwnd, x: meta.button.x, y: meta.button.y, mode: 'uia',
    })
    assert.equal(click2.meta.ok, true, click2.text)
    log = await waitForLog((line) => line === 'button')
    assert.ok(log.includes('button'), `UIA 点击没生效（via=${click2.meta.via}）：${log.join('|')}`)

    // 3) 输入文字（UIA Value / WM_SETTEXT），再用按钮回读
    const typed = await runner.runAction({
      action: 'type', hwnd: meta.textboxHwnd, x: meta.textbox.x, y: meta.textbox.y,
      text: 'hello agent', replace: true,
    })
    await sleep(250)
    assert.equal(typed.meta.ok, true, typed.text)
    writeFileSync(LOG, '')
    await runner.runAction({ action: 'click', hwnd: meta.hwnd, x: meta.read.x, y: meta.read.y, mode: 'uia' })
    log = await waitForLog((line) => line.startsWith('text='))
    assert.ok(log.includes('text=hello agent'), `输入没落地（via=${typed.meta.via}）：${log.join('|')}`)

    // 4) AI 光标：出现、置顶、热点偏移生效
    const move = await runner.runAction({ action: 'move', x: meta.button.x, y: meta.button.y })
    assert.equal(move.meta.ok, true, move.text)
    await sleep(300)
    const shown = await runner.runAction({ action: 'status' })
    assert.equal(shown.meta.overlay, true, '覆盖层应可见')
    const dbg = await runner.sidecar.request('debug', {}, 15000)
    assert.equal(dbg.topmost, true)
    assert.equal(dbg.transparent, true, '应点击穿透')
    assert.equal(dbg.noactivate, true, '应不抢焦点')
    assert.ok(Array.isArray(shown.meta.overlayOffset))
    assert.ok(shown.meta.overlayOffset[0] >= 0)

    // 5) 光标状态可被显式指定（自动切换的入口）
    const forced = await runner.runAction({ action: 'overlay', x: meta.button.x + 40, y: meta.button.y + 40, cursorState: 'link' })
    assert.equal(forced.meta.cursorState, 'link', forced.text)

    // 6) 截图：能截到目标窗口且是合法 PNG
    const shot = await runner.runAction({ action: 'capture', hwnd: meta.hwnd, path: SHOT })
    assert.equal(shot.meta.ok, true, shot.text)
    assert.ok(existsSync(SHOT))
    const bytes = readFileSync(SHOT)
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.ok(bytes.length > 2000)

    // 7) 暂停 / 恢复
    const paused = await runner.runAction({ action: 'pause' })
    assert.equal(paused.meta.paused, true)
    const blocked = await runner.runAction({
      action: 'click', hwnd: meta.hwnd, x: meta.button.x, y: meta.button.y, mode: 'message',
    })
    assert.equal(blocked.meta.paused, true, '暂停后必须拒绝动作')
    const resumed = await runner.runAction({ action: 'resume' })
    assert.equal(resumed.meta.paused, false)

    // 8) physical 默认禁用
    const physical = await runner.runAction({
      action: 'click', hwnd: meta.hwnd, x: meta.button.x, y: meta.button.y, mode: 'physical',
    })
    assert.equal(physical.meta.ok, false)
    assert.equal(physical.meta.strictNoRealMouse, true)

    await runner.runAction({ action: 'overlay', show: false })
  } finally {
    try { app.kill() } catch { /* ignore */ }
    if (runner) await runner.dispose().catch(() => {})
    for (const file of [SHOT, META]) {
      try { if (existsSync(file)) unlinkSync(file) } catch { /* ignore */ }
    }
  }
})
