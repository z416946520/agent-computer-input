/**
 * agent-computer-input · 工具定义（单一来源）
 *
 * 一份 schema 同时喂给 MCP（JSON Schema）、DSH 插件（扁平参数表）和 HTTP/CLI 文档，
 * 避免三套描述漂移。
 */

export const TOOL_NAME = 'computer_input'
export const PACKAGE_NAME = 'agent-computer-input'

export const TOOL_DESCRIPTION = [
  '在自己的 Windows 桌面上操作鼠标/键盘，但**不移动主人的真实光标、不抢键盘焦点**：',
  '所有动作只向指定窗口 `hwnd` 发 UIA / 窗口消息，另有一个置顶、点击穿透的 AI 光标作为视觉提示。',
  '',
  '推荐顺序：',
  '1. `status`：看是否 paused、前台窗口、真实光标位置、AI 光标主题（浅色主题自动用深色光标，反之亦然）。paused 就停手。',
  '2. `windows`（可带 `query` 按标题/进程过滤）：拿目标窗口 `hwnd`；`capture` 拿坐标。',
  '3. `click` / `type` / `key` / `scroll` / `drag`：**必须带目标 `hwnd`**，默认 `mode:"auto"`（UIA → 窗口消息）。',
  '4. 每个动作后 `capture` 确认，不要假设点中了。',
  '',
  'AI 光标：`move` 或任意动作会把它叫出来。`companion`（默认，一直显示）/ `clean`（动作后约 2.6s 收起）；',
  '外观按操作自动切换（移动/点击 pointer、输入 text、可点元素 link、滚动 vert/horz、拖拽 move/dgn1/dgn2、',
  '暂停 unavailiable、失败 help），不用手选；主题跟随 Windows 深浅色自动换（深色主题用白色光标，浅色主题用黑色光标）。',
  '`overlay({show:false})` 收起，`overlay({cursorTheme:"dark"})` 可强制主题。',
  '',
  '安全规则：',
  '- 默认严格模式：**不动真实鼠标、不抢焦点**，所有动作只落到目标 `hwnd`。',
  '- `physical` 默认禁用；确需真实输入先把 `allowPhysical` 打开（会移动真实光标/切焦点）。',
  '- 主人随时按 **Ctrl+Alt+Q** 暂停；返回 `paused:true` 就必须停下，等主人说“继续”再 `resume`。',
  '- 破坏性操作（删文件、关窗口、支付、发送）先问主人。',
  '',
  `actions: ${['status', 'windows', 'inspect', 'capture', 'click', 'type', 'key', 'scroll', 'drag', 'move', 'pause', 'resume', 'overlay', 'settings'].join(' / ')}`,
].join('\n')

/** 标准 JSON Schema（MCP / HTTP 用） */
export const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'windows', 'inspect', 'capture', 'click', 'type', 'key', 'scroll', 'drag', 'move', 'pause', 'resume', 'overlay', 'settings'],
      description: '要执行的动作。',
    },
    hwnd: { type: 'integer', description: '目标窗口句柄（click/type/key/scroll/drag 必填；用 action:"windows" 拿）。' },
    x: { type: 'number', description: '屏幕绝对 x（click/type/scroll/drag 起点/move/overlay）。' },
    y: { type: 'number', description: '屏幕绝对 y。' },
    toX: { type: 'number', description: 'drag 终点 x。' },
    toY: { type: 'number', description: 'drag 终点 y。' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click 用哪颗键，默认 left。' },
    count: { type: 'integer', minimum: 1, maximum: 3, description: '点击次数，默认 1；2 = 双击。' },
    text: { type: 'string', description: 'type 要输入的文字。' },
    replace: { type: 'boolean', description: 'type：true 覆盖原内容，false（默认）追加。' },
    keys: { type: 'string', description: 'key：组合键，如 "ctrl+c"、"alt+tab"、"enter"、"ctrl+shift+t"。' },
    mode: { type: 'string', enum: ['auto', 'uia', 'message', 'physical'], description: 'auto（默认）| uia | message | physical（需 allowPhysical）。' },
    delta: { type: 'number', description: 'scroll 滚轮量：正数向上、负数向下，默认 -120。' },
    durationMs: { type: 'number', description: 'drag 持续时间，默认 400ms。' },
    path: { type: 'string', description: 'capture 保存 PNG 的路径；省略则放 ~/.agent-computer-input/shots/。' },
    rect: { type: 'string', description: 'capture 区域："x,y,w,h" 或 "full"；省略则截 hwnd/前台窗口。' },
    attach: { type: 'boolean', description: 'capture 是否把图作为附件返回，默认 true。' },
    query: { type: 'string', description: 'windows：按标题/进程/类名过滤。' },
    show: { type: 'boolean', description: 'overlay：false 隐藏 AI 光标。' },
    cursorState: { type: 'string', description: '强制某个光标状态（默认按操作自动切换）。' },
    cursorMode: { type: 'string', enum: ['companion', 'clean'], description: 'overlay/settings：陪伴 or 整洁。' },
    cursorSize: { type: 'number', description: 'AI 光标边长像素，24–192（默认 96）。' },
    cursorTheme: { type: 'string', enum: ['auto', 'light', 'dark'], description: '光标主题：auto 跟随 Windows 深浅色。' },
    cursorOpacity: { type: 'number', description: 'AI 光标不透明度 0.2–1。' },
    enabled: { type: 'boolean', description: 'settings：总开关。' },
    allowPhysical: { type: 'boolean', description: 'settings：是否允许 physical（默认 false）。' },
    hotkey: { type: 'string', description: 'settings：暂停热键，如 "Ctrl+Alt+Q"，空串 = 不注册。' },
    animations: { type: 'boolean', description: 'settings：是否播放 work/busy 动画。' },
  },
  required: ['action'],
  additionalProperties: true,
}

/** DSH 插件用的扁平参数表（从 JSON Schema 转） */
export function flatParameters(schema = PARAMETERS_SCHEMA) {
  const required = new Set(schema.required || [])
  const out = {}
  for (const [key, value] of Object.entries(schema.properties)) {
    out[key] = { ...value, required: required.has(key) }
  }
  return out
}

/** 工具结果结构（DSH 需要显式声明） */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    images: { type: 'array', items: { type: 'object', additionalProperties: true } },
    meta: { type: 'object', additionalProperties: true },
  },
}
