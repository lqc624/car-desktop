/**
 * utilityProcess 入口（CJS shim，S1 规划 D-S1-3 回退链第 1 落点）
 *
 * 形态裁决：utilityProcess 入口用 CJS + 动态 import() 装载 ESM 宿主核心
 * （host-core.mjs）——该组合在全部 Electron 版本上通用，不押注 utilityProcess
 * 的 ESM 直入支持矩阵；宿主核心保持 ESM 原生（与内核 dist/seam.js 同构）。
 * 本文件为纯转发 shim（无业务逻辑），不进 tsc strict 检查面
 * （类型契约两端由 shared/ipc-contract.ts 与 host-core dispatch switch 承载），
 * 行为正确性由 CAR_SMOKE 全链冒烟 + node:test E2E 覆盖。
 *
 * 消息协议（与 main.ts 对拍）：
 *  - 请求：{ reqId, channel, payload } → { reqId, result } | { reqId, error }
 *  - 推送：{ push: true, topic, payload }（S2：会话事件流 / 授权 pending+resolved）
 */
'use strict'

let servicePromise = null

// 宿主进程级兜底：未捕获拒绝/异常必须留痕（此前形态 = 进程静默退出，句柄全失 → 下次
// 续写走 resume 把引导队列误标 interrupted；stderr 已由 main 接管输出）
process.on('unhandledRejection', (err) => {
  console.error('[host] unhandledRejection:', (err && err.stack) || String(err))
})
process.on('uncaughtException', (err) => {
  console.error('[host] uncaughtException:', (err && err.stack) || String(err))
})

function getService() {
  if (!servicePromise) {
    servicePromise = import('./host-core.mjs').then((mod) => {
      const svc = mod.createHostService({ userDataDir: process.env.CAR_USER_DATA || '' })
      // 推送出口：宿主 emit → parentPort → main → webContents.send → preload 订阅
      svc.onPush((m) => process.parentPort.postMessage({ push: true, topic: m.topic, payload: m.payload }))
      return svc
    })
  }
  return servicePromise
}

process.parentPort.on('message', (event) => {
  const data = (event && event.data) || {}
  const { reqId, channel, payload } = data
  if (typeof reqId !== 'number') return
  getService()
    .then((svc) => svc.dispatch(channel, payload))
    .then((result) => process.parentPort.postMessage({ reqId, result }))
    .catch((err) => process.parentPort.postMessage({ reqId, error: String((err && err.message) || err) }))
})
