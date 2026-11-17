import test from 'node:test'
import assert from 'node:assert/strict'
import { detectWindowsTheme, resolveCursorTheme, clearThemeCache } from '../src/core/theme.js'

test('detectWindowsTheme：浅色主题 → 用深色光标（light 目录）', () => {
  clearThemeCache()
  const theme = detectWindowsTheme({ force: true, env: { ACI_WINDOWS_THEME: 'light' } })
  assert.equal(theme.scheme, 'light')
  assert.equal(theme.cursorTheme, 'light')
  assert.equal(theme.source, 'env')
})

test('detectWindowsTheme：深色主题 → 用浅色光标（dark 目录）', () => {
  clearThemeCache()
  const theme = detectWindowsTheme({ force: true, env: { ACI_WINDOWS_THEME: 'dark' } })
  assert.equal(theme.scheme, 'dark')
  assert.equal(theme.cursorTheme, 'dark')
})

test('resolveCursorTheme：手动覆盖优先于系统主题', () => {
  clearThemeCache()
  const detected = detectWindowsTheme({ force: true, env: { ACI_WINDOWS_THEME: 'light' } })
  assert.equal(resolveCursorTheme('auto', detected), 'light')
  assert.equal(resolveCursorTheme('dark', detected), 'dark')
  assert.equal(resolveCursorTheme('light', detected), 'light')
  assert.equal(resolveCursorTheme(undefined, detected), 'light')
})

test('detectWindowsTheme：默认带缓存，force 会绕过', () => {
  clearThemeCache()
  const first = detectWindowsTheme({ force: true, env: { ACI_WINDOWS_THEME: 'dark' } })
  const cached = detectWindowsTheme({ env: { ACI_WINDOWS_THEME: 'light' } })
  assert.equal(cached.scheme, first.scheme, '5s 内走缓存')
  const forced = detectWindowsTheme({ force: true, env: { ACI_WINDOWS_THEME: 'light' } })
  assert.equal(forced.scheme, 'light')
})
