/**
 * 无头冒烟（CAR_SMOKE=1）：以 Electron 跑 main.cjs，窗口 show:false，
 * 断言 preload 桥在位 + probe 全链（renderer 桥 → ipcMain → utilityProcess →
 * host-core → seam 顶层入口）返回 seam 版本。GUI 冒烟（S1-GO 第 4 项）仍归用户终端。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
if (typeof electronBin !== 'string') {
  console.error('smoke: electron 二进制路径解析失败（是否在 electron 运行时内调用了本脚本？）')
  process.exit(1)
}

const r = spawnSync(electronBin, ['.', ...(process.env.CAR_SMOKE_ARGS ? process.env.CAR_SMOKE_ARGS.split(' ').filter(Boolean) : [])], {
  env: { ...process.env, CAR_SMOKE: '1' },
  encoding: 'utf8',
  timeout: 120_000,
})

if (r.stdout) console.log('--- smoke stdout ---\n' + r.stdout)
if (r.stderr) console.log('--- smoke stderr ---\n' + r.stderr)

const ok = r.status === 0 && typeof r.stdout === 'string' && r.stdout.includes('CAR_SMOKE_OK')
console.log(ok ? 'SMOKE PASS' : `SMOKE FAIL (status=${r.status}${r.error ? ' error=' + String(r.error) : ''})`)
process.exit(ok ? 0 : 1)
