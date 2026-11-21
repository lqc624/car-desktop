/**
 * Electron 侧构建（esbuild）：
 *  - main.cjs / preload.cjs：CJS bundle（preload 沙箱要求 CJS；package.json type:module
 *    形态下 .cjs 后缀显式声明模块格式）
 *  - host-core.mjs：宿主核心 ESM bundle，内核包 external（运行时 ESM loader 解析，
 *    与 dist/seam.js 同构——D-S1-3 回退链第 1 落点的对侧）
 *  - host-entry.cjs：纯转发 shim，源文件直拷（无 import 需打包）
 *
 * 2026-11-15 存量发现修复（桌面打包态——dep 1.23.0 起首次真实捆绑触发）：内核 1.22.1（F1
 * 修复）dist/ptc/runCode.js 以 `fileURLToPath(import.meta.url)` 解析 worker 入口——esbuild
 * CJS bundle 把 import.meta 吞成 `{}` → fileURLToPath(undefined) **模块加载即抛**（App threw
 * an error during load，main 静默挂死形态）。onLoad 插件把该表达式改写为内核真实文件路径
 * （package.json resolve 锚定——exports 白名单只放行顶层 + ./package.json 子路径）；结果 =
 * WORKER_PATH 指向 node_modules 内真实 worker-entry.js（语义保真）。PTC 工具派发面在
 * host-core.mjs（内核 external、import.meta 原生在位）——main bundle 只须加载不崩，改写后
 * 即使派发也可用。内核侧 bundled 形态守卫（try/catch + fail-visible）登记内核候选 F3。
 */
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'

const nodeTarget = 'node22.19'
mkdirSync('dist-electron', { recursive: true })

/** CJS bundle 的 import.meta.url 改写（内核 runCode.js / repl.js worker 入口——见头注；0.14.0 泛化双文件） */
const importMetaUrlCjsPlugin = {
  name: 'import-meta-url-cjs',
  setup(b) {
    b.onLoad({ filter: /node_modules[\\/]+@lqc123qwe[\\/]car-runtime[\\/]+dist[\\/]+ptc[\\/](runCode|repl)\.js$/ }, async (args) => {
      const base = args.path.split(/[\\/]/).pop() || ''
      return {
        contents: readFileSync(args.path, 'utf8').replace(
          'fileURLToPath(import.meta.url)',
          `fileURLToPath(require("node:url").pathToFileURL(require.resolve("@lqc123qwe/car-runtime/package.json")).href.replace(/package\\.json$/, 'dist/ptc/${base}'))`,
        ),
        loader: 'js',
      }
    })
  },
}

await build({
  entryPoints: ['src/main/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: nodeTarget,
  outfile: 'dist-electron/main.cjs',
  external: ['electron'],
  plugins: [importMetaUrlCjsPlugin],
})

await build({
  entryPoints: ['src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: nodeTarget,
  outfile: 'dist-electron/preload.cjs',
  external: ['electron'],
})

await build({
  entryPoints: ['src/host-core/service.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: nodeTarget,
  outfile: 'dist-electron/host-core.mjs',
  external: ['@lqc123qwe/car-runtime'],
})

copyFileSync('src/main/host-entry.cjs', 'dist-electron/host-entry.cjs')
console.log('build-main: main.cjs / preload.cjs / host-core.mjs / host-entry.cjs ✓')
