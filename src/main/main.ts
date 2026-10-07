/**
 * 主进程入口（Electron 胶水薄壳——宿主逻辑全部在 host-core，见 D-S1-1）
 *
 * 安全基线四件套（立项书 R-D4，S1 骨架一次到位）：
 *  1. contextIsolation: true（显式声明，不依赖默认值口径漂移）
 *  2. nodeIntegration: false
 *  3. preload 白名单桥（preload.cjs 仅映射 ipc-contract.ts 契约通道）
 *  4. sandbox: true（preload 受限集：contextBridge + ipcRenderer）
 * CSP 由 renderer index.html meta 承载（file:// 形态）。
 *
 * 宿主进程 = utilityProcess（R-D3）：main.cjs 只做窗口/生命周期/IPC 转发。
 * S2：请求/响应（ipcMain.handle ↔ reqId 映射）+ 推送转发（宿主 push → 全部窗口
 * webContents.send，主题白名单 = IpcPushTopic）。
 */
import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron'
import path from 'node:path'
import { IpcChannel, IpcPushTopic, type IpcPushTopicName, type WorkspaceInfo } from '../shared/ipc-contract.ts'

const HOST_TIMEOUT_MS = 20_000

let hostProc: ReturnType<typeof utilityProcess.fork> | null = null
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let reqSeq = 0

function ensureHost(): ReturnType<typeof utilityProcess.fork> {
  if (hostProc) return hostProc
  hostProc = utilityProcess.fork(path.join(__dirname, 'host-entry.cjs'), [], {
    serviceName: 'car-host',
    // D-S1-4：工作区索引/后续加密凭据落 userData；smoke 形态下 main 已重定向到临时目录
    env: { ...process.env, CAR_USER_DATA: app.getPath('userData') },
  })
  hostProc.on('message', (raw: unknown) => {
    const msg = raw as { reqId?: number; result?: unknown; error?: string; push?: boolean; topic?: string; payload?: unknown }
    // S2 推送面：宿主 emit → 全部窗口广播（主题白名单校验——非契约主题丢弃）
    if (msg?.push === true) {
      if (typeof msg.topic !== 'string' || !Object.values(IpcPushTopic).includes(msg.topic as IpcPushTopicName)) return
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(msg.topic, msg.payload)
      }
      return
    }
    if (typeof msg?.reqId !== 'number' || !pending.has(msg.reqId)) return
    const p = pending.get(msg.reqId)!
    pending.delete(msg.reqId)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  })
  hostProc.on('exit', () => {
    // 宿主进程退出：所有在途请求 fail-visible（禁悬挂）
    hostProc = null
    for (const [, p] of pending) p.reject(new Error('CAR-E-DESKTOP: 宿主进程退出（在途请求中止）'))
    pending.clear()
  })
  return hostProc
}

function callHost<T>(channel: string, payload?: unknown): Promise<T> {
  const hp = ensureHost()
  const reqId = ++reqSeq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject })
    hp.postMessage({ reqId, channel, payload })
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId)
        reject(new Error(`CAR-E-DESKTOP: 宿主响应超时（${channel}，>${HOST_TIMEOUT_MS}ms）`))
      }
    }, HOST_TIMEOUT_MS)
  })
}

function registerIpc(): void {
  ipcMain.handle(IpcChannel.HostProbe, () => callHost(IpcChannel.HostProbe))

  // 系统目录选择器属 main 侧能力（host-core 零 Electron 纪律）；选中后转宿主装载校验
  ipcMain.handle(IpcChannel.WorkspacePick, async (event): Promise<WorkspaceInfo | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(win!, {
      title: '选择工作区文件夹（将装载/校验 car.config.ts）',
      properties: ['openDirectory'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return callHost<WorkspaceInfo>(IpcChannel.WorkspaceRegister, { path: picked.filePaths[0] })
  })

  ipcMain.handle(IpcChannel.WorkspaceRegister, (_event, payload: { path: string }) =>
    callHost<WorkspaceInfo>(IpcChannel.WorkspaceRegister, payload),
  )
  ipcMain.handle(IpcChannel.WorkspaceList, () => callHost<WorkspaceInfo[]>(IpcChannel.WorkspaceList))
  ipcMain.handle(IpcChannel.SessionCreate, (_event, payload: { workspaceId: string }) =>
    callHost(IpcChannel.SessionCreate, payload),
  )
  ipcMain.handle(IpcChannel.SessionList, (_event, payload: { workspaceId: string }) =>
    callHost(IpcChannel.SessionList, payload),
  )
  ipcMain.handle(IpcChannel.SessionOpen, (_event, payload: { workspaceId: string; sessionId: string }) =>
    callHost(IpcChannel.SessionOpen, payload),
  )
  ipcMain.handle(IpcChannel.TurnSend, (_event, payload: { workspaceId: string; sessionId: string; text: string }) =>
    callHost(IpcChannel.TurnSend, payload),
  )
  ipcMain.handle(IpcChannel.TurnAbort, (_event, payload: { workspaceId: string; sessionId: string }) =>
    callHost(IpcChannel.TurnAbort, payload),
  )
  ipcMain.handle(
    IpcChannel.AuthzRespond,
    (_event, payload: { workspaceId: string; sessionId: string; requestId: string; decision: 'once' | 'session' | 'deny' }) =>
      callHost(IpcChannel.AuthzRespond, payload),
  )
  ipcMain.handle(IpcChannel.SessionUsage, (_event, payload: { workspaceId: string; sessionId: string }) =>
    callHost(IpcChannel.SessionUsage, payload),
  )
  ipcMain.handle(IpcChannel.SessionRename, (_event, payload: { workspaceId: string; sessionId: string; title: string }) =>
    callHost(IpcChannel.SessionRename, payload),
  )
  ipcMain.handle(IpcChannel.SessionDelete, (_event, payload: { workspaceId: string; sessionId: string }) =>
    callHost(IpcChannel.SessionDelete, payload),
  )
  ipcMain.handle(IpcChannel.SessionSetModel, (_event, payload: { workspaceId: string; sessionId: string; model: string }) =>
    callHost(IpcChannel.SessionSetModel, payload),
  )
}

async function createWindow(show: boolean): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show,
    title: 'CAR Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'))
  return win
}

app.whenReady().then(async () => {
  registerIpc()
  const smoke = process.env.CAR_SMOKE === '1'
  const win = await createWindow(!smoke)
  if (smoke) {
    // 无头冒烟（CAR_SMOKE=1，窗口 show:false）：桥在位 + probe 全链
    // （renderer preload 桥 → ipcMain → utilityProcess → host-core → seam 顶层入口）
    try {
      const bridgeOk = await win.webContents.executeJavaScript(
        "!!window.car && typeof window.car.probe === 'function' && typeof window.car.sendTurn === 'function' && typeof window.car.onSessionEvent === 'function'",
      )
      const probe = (await win.webContents.executeJavaScript('window.car.probe()')) as {
        seamVersion?: string
        symbolCount?: number
      } | null
      const ok = bridgeOk === true && typeof probe?.seamVersion === 'string' && /^\d+\.\d+\.\d+/.test(probe.seamVersion)
      console.log(`CAR_SMOKE_OK ${JSON.stringify({ bridgeOk, seamVersion: probe?.seamVersion, symbolCount: probe?.symbolCount })}`)
      app.exit(ok ? 0 : 1)
    } catch (err) {
      console.error(`CAR_SMOKE_FAIL ${String(err)}`)
      app.exit(1)
    }
    return
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(true)
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
