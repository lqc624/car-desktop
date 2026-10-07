/**
 * Electron 侧构建（esbuild）：
 *  - main.cjs / preload.cjs：CJS bundle（preload 沙箱要求 CJS；package.json type:module
 *    形态下 .cjs 后缀显式声明模块格式）
 *  - host-core.mjs：宿主核心 ESM bundle，内核包 external（运行时 ESM loader 解析，
 *    与 dist/seam.js 同构——D-S1-3 回退链第 1 落点的对侧）
 *  - host-entry.cjs：纯转发 shim，源文件直拷（无 import 需打包）
 */
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

const nodeTarget = 'node22.19'
mkdirSync('dist-electron', { recursive: true })

await build({
  entryPoints: ['src/main/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: nodeTarget,
  outfile: 'dist-electron/main.cjs',
  external: ['electron'],
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
