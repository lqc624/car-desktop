# CAR Desktop（桌面壳）

CAR 桌面端 v0.1（壳基座 S1）。独立新壳消费内核 seam（`@lqc123qwe/car-runtime` 库形态），
不是平台 dashboard 换皮——立项书与迭代规划见 `car-docs/30-桌面v1/`（workspace 侧）。

## 结构

```
src/shared/     IPC 契约单一源（通道白名单 + DTO；渲染/主/宿主三端唯一类型源）
src/host-core/  宿主核心（零 Electron import，node:test 直测）：
                seam 装载与探测 / 工作区注册（loadCarConfig fail-visible）/
                会话生命周期（SessionLog + SessionFileStore）
src/main/       Electron 胶水薄壳：main.cjs（窗口/IPC 转发/utilityProcess 装配）、
                preload.cjs（contextBridge 白名单桥）、host-entry.cjs（utilityProcess 入口 shim）
src/renderer/   React 18 + Vite 渲染层（薄皮，逻辑下沉宿主）
test/           宿主核心行为测试 + 双门禁（seam 深路径 / renderer IPC 逃逸）
```

## 命令

```
npm test        宿主核心 + 门禁（node:test，TAP）
npm run build   esbuild（main/preload/host-core）+ vite（renderer）
npm start       启动桌面壳（先 build）
npm run smoke   无头冒烟（CAR_SMOKE=1，show:false：桥在位 + probe 全链）
npm run typecheck / npm run secrets-scan
```

## 纪律锚点

- 安全基线四件套（R-D4）：contextIsolation / nodeIntegration off / preload 白名单桥 / CSP；凭据 safeStorage（S4 消费）。
- seam 唯一消费面（N-D2）：仅 `src/host-core/` 可 import 内核包，仅顶层入口，CI 门禁强制。
- 会话事实源 = 内核 SessionLog/SessionFileStore，桌面端不另设事实源；落盘 `<workspace>/.car/sessions/`。
- `.npmrc` 的 electron_mirror 为 github.com:443 阻断环境的下载通道（github 可达环境可移除）。
