/**
 * agent-computer-input · sidecar 客户端
 *
 * 一个常驻的 Windows PowerShell 5.1（STA）进程负责所有 Win32 动作：
 *   UIA / 窗口消息 / 截图 / 低级键鼠钩子 / 暂停热键 / AI 光标覆盖层。
 * Node 侧只做：按行发 JSON、按行收 JSON、超时、重启、空闲回收。
 *
 * 相对上游 0.2.0 的改动：
 *   - 协议带版本号（v:2），握手返回能力集（uia / hotkey / theme），不再靠猜；
 *   - 请求可以并发，写管道串行；进程崩了按指数退避自动重拉（单次请求内最多 2 次）；
 *   - 空闲回收：一段时间没有请求且覆盖层不可见就退出 sidecar（省内存），下次自动起来；
 *   - 主题变化由 sidecar 自己推事件，Node 只负责转达，不做轮询。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTOCOL_VERSION = 2
const HERE = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = join(HERE, '..', '..')
export const SIDECAR_PATH = join(PACKAGE_ROOT, 'src', 'sidecar', 'sidecar.ps1')
export const ASSETS_ROOT = join(PACKAGE_ROOT, 'assets', 'cursors')

export class SidecarError extends Error {
  constructor(message, { code = 'sidecar-error', detail = null } = {}) {
    super(message)
    this.name = 'SidecarError'
    this.code = code
    this.detail = detail
  }
}

function resolvePowerShell(env = process.env) {
  if (env.ACI_POWERSHELL) return env.ACI_POWERSHELL
  const system = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(system)) return system
  return 'powershell.exe'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class SidecarClient {
  /**
   * @param {{settings?:object, log?:(level:string,message:string)=>void, root?:string, env?:NodeJS.ProcessEnv}} [options]
   */
  constructor(options = {}) {
    this.root = options.root || PACKAGE_ROOT
    this.settings = options.settings || {}
    this.env = options.env || process.env
    this.log = options.log || (() => {})
    this.proc = null
    this.ready = false
    this.info = null
    this.starting = null
    this.spawning = 0
    this.logBuffer = ''
    this.stderr = ''
    this.seq = 0
    this.pending = new Map()
    this.writeQueue = Promise.resolve()
    this.idleTimer = null
    this.listeners = new Map()
    this.stopping = false
    this.lastUsedAt = Date.now()
    this.restarts = 0
  }

  /* --------------------------------------------------------------- events */

  on(event, handler) {
    const set = this.listeners.get(event) || new Set()
    set.add(handler)
    this.listeners.set(event, set)
    return () => set.delete(handler)
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) {
      try {
        handler(payload)
      } catch { /* 监听器自己的锅 */ }
    }
  }

  /* ---------------------------------------------------------------- spawn */

  get alive() {
    return Boolean(this.proc && this.proc.exitCode === null && this.ready)
  }

  async ensure() {
    if (this.alive) return this.info
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async start() {
    if (process.platform !== 'win32') {
      throw new SidecarError('agent-computer-input 只支持 Windows（依赖 UIA / 窗口消息 / WinForms 覆盖层）', { code: 'platform-unsupported' })
    }
    if (!existsSync(SIDECAR_PATH)) {
      throw new SidecarError(`找不到 sidecar 脚本：${SIDECAR_PATH}`, { code: 'sidecar-missing' })
    }
    this.stopping = false
    this.killProcess()
    this.ready = false
    this.buf = ''
    this.stderr = ''
    this.logBuffer = ''

    const ps = resolvePowerShell(this.env)
    const settings = this.settings || {}
    const env = {
      ...this.env,
      ACI_SIDECAR: '1',
      ACI_ASSETS: this.root ? join(this.root, 'assets', 'cursors') : ASSETS_ROOT,
      ACI_CURSOR_MODE: settings.cursorMode || 'companion',
      ACI_CURSOR_HOLD_MS: String(settings.cursorHoldMs ?? 2600),
      ACI_CURSOR_SIZE: String(settings.cursorSize ?? 96),
      ACI_CURSOR_THEME: settings.cursorTheme || 'auto',
      ACI_CURSOR_OPACITY: String(settings.cursorOpacity ?? 1),
      ACI_ANIMATIONS: settings.animations === false ? '0' : '1',
      ACI_HOTKEY: settings.hotkey === undefined ? 'Ctrl+Alt+Q' : settings.hotkey,
      ACI_ALLOW_PHYSICAL: settings.allowPhysical ? '1' : '0',
    }

    this.spawning++
    const proc = spawn(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
      '-ExecutionPolicy', 'Bypass', '-File', SIDECAR_PATH,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    this.proc = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.onData(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-12000)
      const line = String(chunk).trim()
      if (line) this.log('debug', `[sidecar] ${line}`)
    })
    proc.on('error', (error) => {
      this.failAll(new SidecarError(`sidecar 启动失败：${error.message}`, { code: 'spawn-failed' }))
    })
    proc.on('exit', (code, signal) => {
      const wasReady = this.ready
      this.ready = false
      this.proc = null
      const detail = this.stderr.trim().slice(-1500)
      const error = new SidecarError(`sidecar 退出（code=${code} signal=${signal}）${detail ? `\n${detail}` : ''}`, {
        code: 'sidecar-exit',
      })
      this.failAll(error)
      if (wasReady && !this.stopping) this.log('warn', `sidecar 意外退出：code=${code} signal=${signal}`)
      this.emit('exit', { code, signal, stderr: detail })
    })

    const startedAt = Date.now()
    while (!this.ready) {
      if (!this.proc || this.proc.exitCode !== null) {
        throw new SidecarError(`sidecar 没起来：${this.stderr.trim().slice(-1500) || '进程已退出'}`, { code: 'startup-failed' })
      }
      if (Date.now() - startedAt > 40000) {
        this.killProcess()
        throw new SidecarError(`sidecar 启动超时：${this.stderr.trim().slice(-1500) || '没有收到 ready'}`, { code: 'startup-timeout' })
      }
      await sleep(60)
    }
    this.touch()
    return this.info
  }

  onData(chunk) {
    this.logBuffer += chunk
    let index
    while ((index = this.logBuffer.indexOf('\n')) >= 0) {
      const line = this.logBuffer.slice(0, index).trim()
      this.logBuffer = this.logBuffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log('debug', `[sidecar] 非 JSON 输出：${line.slice(0, 320)}`)
        continue
      }
      if (message.event) {
        this.onEvent(message)
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) {
        pending.resolve(message.result)
      } else {
        const error = new SidecarError(message.error || 'sidecar 返回错误', { code: message.code || 'sidecar-error', detail: message.result || null })
        if (message.stderr) error.detail = message.stderr
        pending.reject(error)
      }
    }
  }

  onEvent(message) {
    if (message.event === 'ready') {
      this.info = {
        protocol: message.v || 0,
        pid: message.pid,
        version: message.version,
        uia: message.uia !== false,
        hotkey: message.hotkey || null,
        hotkeyRegistered: message.hotkeyRegistered !== false,
        theme: message.theme || null,
        cursorTheme: message.cursorTheme || null,
        cursorStates: Array.isArray(message.cursorStates) ? message.cursorStates : [],
        powershell: message.powershell || null,
        physical: message.physical === true,
      }
      this.ready = true
      this.emit('ready', this.info)
      return
    }
    if (message.event === 'theme') {
      this.emit('theme', { scheme: message.scheme, cursorTheme: message.cursorTheme, source: message.source })
      return
    }
    if (message.event === 'log') {
      this.log('debug', `[sidecar] ${message.message}`)
      return
    }
    this.emit(message.event, message)
  }

  failAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /* ------------------------------------------------------------- requests */

  /** 写一行，串行排队，避免 Node 侧并发写把 JSON 拆断。 */
  writeLine(line) {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return Promise.reject(new SidecarError('sidecar 不在运行', { code: 'not-running' }))
    this.writeQueue = this.writeQueue.then(() => new Promise((resolve, reject) => {
      proc.stdin.write(line, (error) => (error ? reject(error) : resolve()))
    }))
    return this.writeQueue
  }

  /**
   * @param {string} cmd
   * @param {object} [args]
   * @param {number} [timeoutMs]
   */
  async request(cmd, args = {}, timeoutMs = 30000) {
    const started = Date.now()
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensure()
        const result = await this.send(cmd, args, timeoutMs)
        this.touch()
        return result
      } catch (error) {
        lastError = error
        const retriable = error instanceof SidecarError
          && ['sidecar-exit', 'not-running', 'startup-failed'].includes(error.code)
        if (!retriable || attempt > 0) break
        this.restarts++
        this.log('warn', `sidecar 请求失败（${error.code}），重拉后重试：${cmd}`)
        this.killProcess()
        await sleep(120)
      }
    }
    throw lastError || new SidecarError(`请求失败：${cmd}`)
  }

  async send(cmd, args, timeoutMs) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SidecarError(`sidecar 超时（${timeoutMs}ms）：${cmd}`, { code: 'timeout' }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const payload = JSON.stringify({ v: PROTOCOL_VERSION, id, cmd, ...args })
      this.writeLine(`${payload}\n`).catch((error) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new SidecarError(`写入 sidecar 失败：${error.message}`, { code: 'not-running' }))
      })
    })
  }

  /** 把设置推给 sidecar（运行中立即生效）。 */
  async applySettings(settings) {
    this.settings = settings
    if (!this.alive) return { pending: true, settings }
    if (!settings.enabled) {
      await this.request('overlay', { show: false }, 8000).catch(() => null)
      return { ok: true, hidden: true }
    }
    await this.request('configure', {
      cursorMode: settings.cursorMode,
      cursorHoldMs: settings.cursorHoldMs,
      cursorSize: settings.cursorSize,
      cursorTheme: settings.cursorTheme,
      cursorOpacity: settings.cursorOpacity,
      animations: settings.animations,
      hotkey: settings.hotkey,
      allowPhysical: settings.allowPhysical,
    }, 20000)
    return { ok: true }
  }

  async stop({ force = false } = {}) {
    this.stopping = true
    this.clearIdleTimer()
    const proc = this.proc
    if (!proc) return
    if (!force) {
      try {
        await this.send('shutdown', {}, 3000)
      } catch { /* 已经死了 */ }
    }
    this.killProcess()
  }

  killProcess() {
    const proc = this.proc
    this.proc = null
    this.ready = false
    if (!proc) return
    try { proc.stdin.end() } catch { /* ignore */ }
    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* ignore */ }
    }, 700)
    timer.unref?.()
  }

  /* ------------------------------------------------------------ idle gc */

  touch() {
    this.lastUsedAt = Date.now()
    this.scheduleIdleCheck()
  }

  scheduleIdleCheck() {
    this.clearIdleTimer()
    const idleMs = Number(this.settings?.idleShutdownMs ?? 0)
    if (!idleMs || idleMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.collectIfIdle().catch(() => {})
    }, idleMs + 50)
    this.idleTimer.unref?.()
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /** 空闲且覆盖层不可见时回收 sidecar；覆盖层还显示着就不动它。 */
  async collectIfIdle() {
    if (!this.alive || this.pending.size) {
      this.scheduleIdleCheck()
      return
    }
    const idleMs = Number(this.settings?.idleShutdownMs ?? 0)
    if (!idleMs || Date.now() - this.lastUsedAt < idleMs) {
      this.scheduleIdleCheck()
      return
    }
    try {
      const status = await this.send('status', {}, 8000)
      if (status?.overlay) {
        this.scheduleIdleCheck()
        return
      }
      this.log('debug', '空闲回收 sidecar')
      await this.stop({ force: false })
    } catch {
      this.scheduleIdleCheck()
    }
  }
}
