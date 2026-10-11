/**
 * 仓库级密钥扫描（fail-closed；内核 scripts/secrets-scan.ts 同纪律——commit 后必须复跑）。
 * 扫描范围 = 仓库文本文件（跳过 node_modules / 构建产物 / .git）；命中即退出码 1。
 *
 * 行级豁免（显式配置且留痕——检测不可静默关闭的封闭豁免面）：行内含 `secrets-scan:allow`
 * 标记的行跳过扫描，标记处必须注明理由。豁免预期只出现在测试 fixture（假密钥靶料——
 * 脱敏/检测断言需要真实形态的靶子，非真实凭据）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.git'])
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.npmrc'])
const ALLOW_MARKER = 'secrets-scan:allow'
const PATTERNS = [
  ['sk- 形态密钥', /sk-[A-Za-z0-9]{20,}/],
  ['AWS AccessKey', /AKIA[0-9A-Z]{16}/],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['内联凭据赋值', /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i],
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (EXTS.has(extname(name))) out.push(p)
  }
  return out
}

let hits = 0
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) continue // 行级豁免：显式标记 + 理由留痕
    for (const [label, re] of PATTERNS) {
      const m = line.match(re)
      if (m) {
        console.error(`SECRET HIT [${label}] ${relative(ROOT, file)}:${i + 1}: ${m[0].slice(0, 16)}…`)
        hits++
      }
    }
  }
}
if (hits > 0) {
  console.error(`secrets-scan: ${hits} 处命中——fail-closed 拒绝（如为测试 fixture 靶料，行内加 ${ALLOW_MARKER} 标记并注明理由）`)
  process.exit(1)
}
console.log('secrets-scan: 0 命中')
