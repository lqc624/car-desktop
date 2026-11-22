#!/usr/bin/env node
/**
 * car-browser-mcp bin 入口：以 --experimental-transform-types 重拉 TS server（子进程
 * stdio inherit——JSON-RPC 协议通道直通）。发布形态（npm bin）与本地形态（car.config
 * 直接 command: node --experimental-transform-types <pkg>/src/server.ts）等价。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'server.ts')
const r = spawnSync(process.execPath, ['--experimental-transform-types', server, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
