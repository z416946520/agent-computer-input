#!/usr/bin/env node
/** 本地 HTTP API 入口：POST /call 执行动作，给非 MCP 的 agent / 脚本用。 */
import { main } from '../src/server/cli.js'

await main(['serve'])
