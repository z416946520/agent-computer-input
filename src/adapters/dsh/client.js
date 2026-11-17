// 设置 → Agent Computer Input（DSH 客户端 chunk，无构建）
// 只负责调 /api/settings，真活都在 Node 侧。
window.__ModuleLoader__.load({
  id: 'agent-computer-input',
  factory(require) {
    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    const API = '/agent-computer-input/api'
    const ASSET = '/agent-computer-input/assets'

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8e8ee)',
      sub: 'var(--dsw-alias-label-secondary, #b8b8c4)',
      faint: 'var(--dsw-alias-label-tertiary, #8d8d9c)',
      border: 'var(--dsw-alias-border-primary, rgba(255,255,255,.12))',
      bg: 'var(--dsw-alias-bg-secondary, #191920)',
      input: 'var(--dsw-alias-bg-primary, #101016)',
      accent: 'var(--dsw-alias-brand-primary, #6aa9ff)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      ok: 'var(--dsw-alias-state-success-primary, #59d18b)',
    }

    const S = {
      page: { maxWidth: '820px', color: C.text },
      lead: { fontSize: '12px', color: C.sub, lineHeight: 1.8, marginBottom: '14px' },
      card: { border: `1px solid ${C.border}`, borderRadius: '12px', padding: '14px', background: C.bg, marginBottom: '12px' },
      title: { fontSize: '13px', fontWeight: 700, color: C.text, marginBottom: '4px' },
      hint: { fontSize: '11px', color: C.faint, lineHeight: 1.7, marginBottom: '10px' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      pill: (on) => ({
        border: `1px solid ${on ? C.accent : C.border}`,
        background: on ? C.accent : 'transparent',
        color: on ? '#08111f' : C.text,
        borderRadius: '8px',
        padding: '7px 12px',
        fontSize: '12px',
        cursor: 'pointer',
        fontWeight: on ? 700 : 400,
      }),
      btn: { border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: '8px', padding: '7px 12px', fontSize: '12px', cursor: 'pointer' },
      primary: { border: `1px solid ${C.accent}`, background: C.accent, color: '#08111f', borderRadius: '8px', padding: '7px 14px', fontSize: '12px', cursor: 'pointer', fontWeight: 700 },
      num: { width: '76px', background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: '7px', padding: '6px 8px', fontSize: '12px' },
      range: { width: '100%', accentColor: C.accent, cursor: 'pointer' },
      note: { fontSize: '12px', color: C.ok, minHeight: '18px', lineHeight: 1.6 },
      error: { fontSize: '12px', color: C.danger, minHeight: '18px', lineHeight: 1.6 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' },
      thumbWrap: (dark) => ({
        background: dark ? '#101014' : '#f4f4f6',
        borderRadius: '8px',
        padding: '6px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }),
      thumb: { width: '44px', height: '44px', imageRendering: 'pixelated', display: 'block' },
      stateName: { fontSize: '11.5px', color: C.text, lineHeight: 1.35 },
      stateWhy: { fontSize: '10.5px', color: C.faint, lineHeight: 1.35 },
    }

    const STATE_ROWS = [
      ['pointer', '指针', '默认 / 移动 / 普通点击'],
      ['link', '链接', '点到可点的按钮或链接'],
      ['text', '文本', '输入文字 / 按键'],
      ['vert', '上下', '竖向滚动 / 竖向拖拽'],
      ['horz', '左右', '横向滚动 / 横向拖拽'],
      ['move', '移动', '拖动'],
      ['dgn1', '斜向1', '斜向拖拽（正斜率）'],
      ['dgn2', '斜向2', '斜向拖拽（负斜率）'],
      ['cross', '十字', '精确点击（physical）'],
      ['unavailiable', '禁止', '暂停 / 已接管'],
      ['help', '帮助', '没点中 / 需要处理'],
      ['busy', '忙碌', '执行中（动画）'],
      ['work', '工作', '后台任务（动画）'],
      ['person', '人形', '等待主人'],
      ['pin', '图钉', '标记落点'],
    ]

    async function api(path, options = {}) {
      const init = { method: options.method || 'GET', headers: { 'content-type': 'application/json' }, cache: 'no-store' }
      if (options.body !== undefined) init.body = JSON.stringify(options.body)
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch {
        throw new Error('连不上 agent-computer-input 插件')
      }
      const raw = await response.text().catch(() => '')
      let data = null
      try { data = raw ? JSON.parse(raw) : null } catch { throw new Error('后端返回的不是 JSON') }
      if (!data?.ok) throw new Error(data?.error || `请求失败 ${response.status}`)
      return data
    }

    function Card(props) {
      return h('div', { style: S.card }, props.children)
    }

    function Page() {
      const [settings, setSettings] = useState(null)
      const [runtime, setRuntime] = useState(null)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const apply = (data) => {
        if (data?.settings) setSettings(data.settings)
        if (data?.runtime) setRuntime(data.runtime)
      }

      const load = async () => apply(await api('/settings'))

      useEffect(() => { load().catch((e) => setError(e.message)) }, [])

      const update = (patch) => setSettings((cur) => (cur ? { ...cur, ...patch } : cur))

      const save = async (extra) => {
        if (!settings) return
        setBusy(true); setError(''); setNote('')
        try {
          const body = extra ? { ...settings, ...extra } : settings
          const data = await api('/settings', { method: 'POST', body })
          apply(data)
          setNote('已保存并立即生效。')
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }

      const toggleEnabled = async () => {
        if (!settings) return
        const enabled = !settings.enabled
        update({ enabled })
        await save({ enabled })
        setNote(enabled ? '已启用：动作只落到目标窗口，不动真实光标。' : '已关闭：所有动作停用。')
      }

      const hide = async () => {
        setError('')
        try { await api('/hide', { method: 'POST', body: {} }); setNote('AI 光标已收起。') } catch (e) { setError(e.message) }
      }
      const show = async () => {
        setError('')
        try { await api('/show', { method: 'POST', body: {} }); setNote('AI 光标已出现；真实光标没有移动。') } catch (e) { setError(e.message) }
      }

      if (!settings) {
        return h('div', { style: S.page },
          h('div', { style: S.lead }, error ? `加载失败：${error}` : '正在读取设置……'),
          h('button', { style: S.btn, onClick: () => { setError(''); load().catch((e) => setError(e.message)) } }, '重试'),
        )
      }

      const isClean = settings.cursorMode === 'clean'
      const windowsTheme = runtime?.theme
      const activeTheme = runtime?.cursorTheme || 'light'

      return h('div', { style: S.page },
        h('div', { style: S.title }, 'Agent Computer Input'),
        h('div', { style: S.lead },
          '任何 agent 都能操作这台机器：默认只向目标窗口发 UIA / 窗口消息，不移动你的真实光标、不抢键盘焦点。',
          '光标素材来自 Cur 素材包，按 Windows 深浅色自动切换。'),

        h(Card, null,
          h('div', { style: S.title }, '总开关'),
          h('div', { style: S.hint }, settings.enabled
            ? '已启用：所有动作只用 AI 光标 + UIA / 窗口消息，严格不动真实鼠标。'
            : '已关闭：插件不执行任何动作，也不会显示 AI 光标。'),
          h('button', { style: S.pill(settings.enabled), disabled: busy, onClick: toggleEnabled },
            settings.enabled ? '已启用（点此关闭）' : '已关闭（点此启用）'),
        ),

        h(Card, null,
          h('div', { style: S.title }, '显示方式'),
          h('div', { style: S.hint }, `陪伴 = 一直显示；整洁 = 每次动作后约 ${settings.cursorHoldMs}ms 自动收起。`),
          h('div', { style: S.row },
            h('button', { style: S.pill(!isClean), onClick: () => update({ cursorMode: 'companion' }) }, '陪伴（一直显示）'),
            h('button', { style: S.pill(isClean), onClick: () => update({ cursorMode: 'clean' }) }, '整洁（动作后收起）'),
          ),
          isClean ? h('div', { style: { ...S.row, marginTop: '10px' } },
            h('span', { style: S.hint }, '收起前停留'),
            h('input', {
              type: 'number', min: 300, max: 10000, step: 100, style: S.num, value: settings.cursorHoldMs,
              onChange: (e) => update({ cursorHoldMs: Math.max(300, Math.min(10000, Number(e.target.value) || 2600)) }),
            }),
            h('span', { style: S.hint }, 'ms'),
          ) : null,
        ),

        h(Card, null,
          h('div', { style: S.title }, '深浅色适配'),
          h('div', { style: S.hint },
            `Windows 应用主题：${windowsTheme ? (windowsTheme.scheme === 'dark' ? '深色' : '浅色') : '未知'}（${windowsTheme?.source || '?'}）· `,
            `当前使用：${activeTheme === 'light' ? '浅色主题 → 深色光标（Vision Cursor Black）' : '深色主题 → 浅色光标（Vision Cursor White）'}`),
          h('div', { style: S.row },
            h('button', { style: S.pill(settings.cursorTheme === 'auto'), onClick: () => update({ cursorTheme: 'auto' }) }, '自动跟随系统'),
            h('button', { style: S.pill(settings.cursorTheme === 'light'), onClick: () => update({ cursorTheme: 'light' }) }, '始终深色光标'),
            h('button', { style: S.pill(settings.cursorTheme === 'dark'), onClick: () => update({ cursorTheme: 'dark' }) }, '始终浅色光标'),
          ),
          h('div', { style: S.hint, marginTop: '8px' }, '改了主题不用重启：覆盖层每 1.5s 自查一次系统主题。'),
        ),

        h(Card, null,
          h('div', { style: S.title }, '光标大小与不透明度'),
          h('div', { style: S.hint }, `当前 ${settings.cursorSize}px · 不透明度 ${Math.round((settings.cursorOpacity || 1) * 100)}%；暂停时自动换成红色“禁止”。`),
          h('div', { style: S.row },
            h('input', {
              type: 'range', min: 24, max: 192, step: 4, style: S.range, value: settings.cursorSize,
              onChange: (e) => update({ cursorSize: Number(e.target.value) || 96 }),
            }),
            h('input', {
              type: 'number', min: 24, max: 192, step: 4, style: S.num, value: settings.cursorSize,
              onChange: (e) => update({ cursorSize: Math.max(24, Math.min(192, Number(e.target.value) || 96)) }),
            }),
          ),
          h('div', { style: { ...S.row, marginTop: '8px' } },
            [48, 64, 96, 128, 160].map((n) => h('button', { key: n, style: S.btn, onClick: () => update({ cursorSize: n }) }, `${n}px`)),
          ),
          h('div', { style: { ...S.row, marginTop: '10px' } },
            h('span', { style: S.hint }, '不透明度'),
            h('input', {
              type: 'range', min: 0.2, max: 1, step: 0.05, style: S.range, value: settings.cursorOpacity ?? 1,
              onChange: (e) => update({ cursorOpacity: Number(e.target.value) || 1 }),
            }),
            h('button', { style: S.pill(settings.animations !== false), onClick: () => update({ animations: settings.animations === false }) },
              settings.animations === false ? '动画已关' : '动画已开'),
          ),
        ),

        h(Card, null,
          h('div', { style: S.title }, '状态一览（按操作自动切换）'),
          h('div', { style: S.hint }, '同一套光标的 17 个状态，不用手选。左：浅色主题用的深色光标；右：深色主题用的浅色光标。'),
          h('div', { style: S.grid },
            STATE_ROWS.map(([id, label, why]) => h('div', { key: id, style: { ...S.row, alignItems: 'center' } },
              h('div', { style: S.thumbWrap(false) }, h('img', { src: `${ASSET}/light/${id}.png`, alt: id, style: S.thumb })),
              h('div', { style: S.thumbWrap(true) }, h('img', { src: `${ASSET}/dark/${id}.png`, alt: id, style: S.thumb })),
              h('div', { style: { minWidth: 0, flex: '1' } },
                h('div', { style: S.stateName }, label),
                h('div', { style: S.stateWhy }, why),
              ),
            )),
          ),
        ),

        h('div', { style: S.row },
          h('button', { style: S.primary, disabled: busy, onClick: () => save() }, busy ? '保存中…' : '保存并生效'),
          h('button', { style: S.btn, disabled: busy, onClick: () => save({ cursorMode: 'companion', cursorHoldMs: 2600, cursorSize: 96, cursorOpacity: 1, cursorTheme: 'auto', animations: true }) }, '恢复默认'),
          h('button', { style: S.btn, onClick: show }, '在屏幕上试一下'),
          h('button', { style: S.btn, onClick: hide }, '收起光标'),
        ),
        h('div', { style: S.note }, note),
        h('div', { style: S.error }, error),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'agent-computer-input',
          order: 70,
          label: () => '计算机输入',
        }, Page))
      },
    }
  },
})
