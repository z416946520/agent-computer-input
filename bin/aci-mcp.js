#!/usr/bin/env node
/** MCP stdio server 入口：任何 MCP 客户端都可以指向这个文件。 */
import { startMcpServer } from '../src/server/mcp.js'

await startMcpServer()
