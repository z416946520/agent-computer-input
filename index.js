/**
 * agent-computer-input · 公共入口
 *
 * 库用法（自己写 agent 时）：
 *   import { createInputRunner, loadSettings } from 'agent-computer-input'
 *   const { settings } = loadSettings({})
 *   const runner = createInputRunner({ settings })
 *   const out = await runner.runAction({ action: 'windows' })
 *   console.log(out.text)
 *   await runner.dispose()
 *
 * 接入方式：
 *   - MCP：  node bin/aci-mcp.js          （startMcpServer）
 *   - HTTP： node bin/aci-serve.js        （startHttpServer）
 *   - CLI：  npx aci status               （src/server/cli.js）
 *   - DSH：  import 'agent-computer-input/dsh'
 */

export { createInputRunner, ACTIONS, CURSOR_STATES, statusText, windowsText } from './src/core/actions.js'
export {
  loadSettings, saveSettings, readSettingsFile, writeSettingsFile, normalizeSettings,
  settingsPath, resolveHome, shotsDir, DEFAULT_SETTINGS, CURSOR_MODES, CURSOR_THEMES,
} from './src/core/settings.js'
export { SidecarClient, SidecarError, SIDECAR_PATH, ASSETS_ROOT, PACKAGE_ROOT } from './src/core/sidecar.js'
export { buildCursorAssets, ensureCursorAssets, STATE_SOURCES, THEME_SOURCES, NOMINAL_CELL } from './src/core/cursor-build.js'
export { detectWindowsTheme, resolveCursorTheme } from './src/core/theme.js'
export { parseIconFile, parseAni, bestFrame, renderCursorAsset, encodePng, decodePng, packSpriteSheet } from './src/core/cur.js'
export { TOOL_NAME, TOOL_DESCRIPTION, PARAMETERS_SCHEMA, flatParameters, PACKAGE_NAME } from './src/core/tool-spec.js'
export { startMcpServer } from './src/server/mcp.js'
export { startHttpServer } from './src/server/http.js'
