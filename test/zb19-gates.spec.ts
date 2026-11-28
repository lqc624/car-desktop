/**
 * v0.19 F-P1 防回归门 · IPC 注册配对静态扫描
 *
 * 背景：v0.19.0 发布物渲染层三新 UI 面（RepoWiki 回流开关 / @页面引用 / 安全中心命令规则段）
 * 全死——preload 桥与宿主 dispatch 双在而 main.ts ipcMain.handle 注册层漏 +7 条（E2E 测试走
 * svc.dispatch 直连宿主面、SMOKE 不触新通道，双门禁皆盲；终端验收 CDP 首触即「No handler
 * registered」抓出）。
 *
 * 门禁语义：preload.ts 每个 `invoke(IpcChannel.X` 调用点 = 渲染层→main 请求面，必须在 main.ts
 * 存在对应 `ipcMain.handle(IpcChannel.X` 注册（main 侧自留通道不进 preload invoke 集——
 * 反向不扫描）。扫代码形态行（剥注释启发式与 gates.spec 同款），构造期抓错不待运行期。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')

/** 剥注释形态行（gates.spec 同款启发式——门禁扫代码不扫文档） */
function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/'))
    })
    .join('\n')
}

test('F-P1 防回归门：preload invoke 通道 ↔ main handle 注册全配对', () => {
  const preload = codeLines(readFileSync(join(ROOT, 'src', 'main', 'preload.ts'), 'utf8'))
  const main = codeLines(readFileSync(join(ROOT, 'src', 'main', 'main.ts'), 'utf8'))
  const invoked = [...preload.matchAll(/invoke\(\s*IpcChannel\.([A-Za-z0-9]+)/g)].map((m) => m[1]!)
  assert.ok(invoked.length > 0, 'preload invoke 扫描面为空——门禁失效')
  const handled = new Set([...main.matchAll(/ipcMain\.handle\(\s*IpcChannel\.([A-Za-z0-9]+)/g)].map((m) => m[1]!))
  assert.ok(handled.size > 0, 'main handle 扫描面为空——门禁失效')
  const missing = [...new Set(invoked)].filter((name) => !handled.has(name))
  assert.deepEqual(
    missing,
    [],
    `IPC 注册配对违规：preload invoke 但 main.ts 无 ipcMain.handle（${missing.join(', ')}）——渲染层通道全死形态（F-P1 同款）`,
  )
})
