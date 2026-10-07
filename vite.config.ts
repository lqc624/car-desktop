import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// renderer 构建产物经 main 进程 loadFile 以 file:// 加载——base 必须 './'（相对资源路径）；
// root 指向 src/renderer（index.html 所在），outDir 相对 root 回到仓库 dist/renderer
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
})
