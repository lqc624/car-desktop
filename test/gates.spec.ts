/**
 * 双门禁用例（立项书 N-D1/N-D2 + S1 规划 WBS S1-S2）
 *
 *  - seam 门禁（N-D2）：@lqc123qwe/car-runtime 仅允许 src/host-core/ 域 import，
 *    且仅顶层入口与 exports map 明文子路径 './package.json'——其余深路径
 *    （含 ./src/* 通配，真实存在的绕行面）禁行，门禁即反证；
 *  - renderer IPC 门禁（N-D1）：src/renderer/ 零 electron/ipcRenderer/require 逃逸；
 *    ipcRenderer 全仓仅允许出现在 src/main/preload.ts（白名单桥唯一持有者）；
 *  - 扫描启发式（显式登记）：逐行剥离注释形态行（行首为双斜杠、块注释开闭符、
 *    块注释续行星号者跳过）后匹配——门禁扫代码不扫文档；本启发式的残余面
 *    （行尾内联注释夹带违规 import）由评审兜底，不构成安全边界本体
 *    （安全边界 = Electron contextIsolation 结构）。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'
import { join, relative, sep } from 'node:path'

const SRC_ROOT = join(import.meta.dirname, '..', 'src')
const KERNEL_PKG = '@lqc123qwe/car-runtime'
/** exports map 明文允许的子路径（package.json 元数据读取用）；其余一律深路径禁行 */
const KERNEL_ALLOWED_SUBPATH = `'${KERNEL_PKG}/package.json'`

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

/** 剥注释形态行（启发式，见文件头登记） */
function codeLines(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/'))
    })
    .join('\n')
}

const srcFiles = walk(SRC_ROOT)
const relOf = (f) => relative(SRC_ROOT, f).split(sep).join('/')

test('seam 门禁：内核包仅宿主核心域可 import 且仅顶层入口/合法子路径', () => {
  assert.ok(srcFiles.length > 0, 'src/ 扫描面为空——门禁失效')
  for (const f of srcFiles) {
    const rel = relOf(f)
    const text = codeLines(readFileSync(f, 'utf8'))
    if (!text.includes(KERNEL_PKG)) continue
    assert.ok(
      rel.startsWith('host-core/'),
      `seam 门禁违规：${rel} 位于宿主核心域之外却引用内核包（N-D2：仅 src/host-core/ 可消费 seam）`,
    )
    const stripped = text.replaceAll(KERNEL_ALLOWED_SUBPATH, '').replaceAll(`"${KERNEL_PKG}/package.json"`, '')
    assert.ok(
      !stripped.includes(`${KERNEL_PKG}/`),
      `seam 门禁违规：${rel} 存在深路径 import（仅顶层入口与 ./package.json 子路径合法——exports ./src/* 通配禁行）`,
    )
  }
})

test('seam 门禁：宿主核心至少一处真实消费（门禁不是空转）', () => {
  const hostFiles = srcFiles.filter((f) => relOf(f).startsWith('host-core/'))
  assert.ok(
    hostFiles.some((f) => readFileSync(f, 'utf8').includes(`from '${KERNEL_PKG}'`)),
    '宿主核心域未发现内核顶层入口 import——消费面缺失或被改写',
  )
})

test('renderer IPC 门禁：渲染层零 electron/ipcRenderer/require 逃逸', () => {
  for (const f of srcFiles) {
    const rel = relOf(f)
    if (!rel.startsWith('renderer/')) continue
    const text = codeLines(readFileSync(f, 'utf8'))
    assert.ok(!text.includes("'electron'"), `IPC 门禁违规：${rel} 渲染层 import electron（N-D1）`)
    assert.ok(!text.includes('ipcRenderer'), `IPC 门禁违规：${rel} 渲染层触及 ipcRenderer（N-D1：仅经 preload 桥）`)
    assert.ok(!text.includes('require('), `IPC 门禁违规：${rel} 渲染层出现 require（N-D1：零 Node 能力）`)
  }
})

test('renderer IPC 门禁：ipcRenderer 全仓仅 preload 持有', () => {
  const holders = srcFiles
    .filter((f) => codeLines(readFileSync(f, 'utf8')).includes('ipcRenderer'))
    .map(relOf)
    .sort()
  assert.deepEqual(
    holders,
    ['main/preload.ts'],
    `IPC 门禁违规：ipcRenderer 出现在 preload 之外（${holders.join(', ')}）`,
  )
})
