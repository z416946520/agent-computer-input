#!/usr/bin/env node
import { main } from '../src/server/cli.js'

const code = await main(process.argv.slice(2))
if (typeof code === 'number') process.exit(code)
