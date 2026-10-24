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
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { clearEndpoint, loadEndpointMeta, revealEndpointKey, saveEndpoint } from './credentials.ts'
import { checkForUpdates, downloadUpdate, initUpdater, installUpdate, openReleases } from './updater.ts'
import { IpcChannel, IpcPushTopic, type IpcPushTopicName, type WorkspaceInfo } from '../shared/ipc-contract.ts'

const HOST_TIMEOUT_MS = 20_000

let hostProc: ReturnType<typeof utilityProcess.fork> | null = null
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let reqSeq = 0

function ensureHost(): ReturnType<typeof utilityProcess.fork> {
  if (hostProc) return hostProc
  hostProc = utilityProcess.fork(path.join(__dirname, 'host-entry.cjs'), [], {
    serviceName: 'car-host',
    // 宿主 stderr/stdout 显式接管：宿主崩溃原因必须可见（此前默认形态下崩溃零线索）
    stdio: 'pipe',
    // D-S1-4：工作区索引/后续加密凭据落 userData；smoke 形态下 main 已重定向到临时目录
    env: { ...process.env, CAR_USER_DATA: app.getPath('userData') },
  })
  hostProc.stdout?.on('data', (d: Buffer) => console.log('[host:out]', String(d).trimEnd()))
  hostProc.stderr?.on('data', (d: Buffer) => console.error('[host:err]', String(d).trimEnd()))
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
  // —— S5：立即压缩（内核 applyCompaction——append-only compact 事件） ——
  ipcMain.handle(IpcChannel.SessionCompact, (_event, payload: unknown) => callHost(IpcChannel.SessionCompact, payload))
  // —— S6：白盒记忆面（K-MEM-1 消费面——写操作落链承载 = 活跃会话，D-S6-1） ——
  ipcMain.handle(IpcChannel.MemoryList, (_event, payload: unknown) => callHost(IpcChannel.MemoryList, payload))
  ipcMain.handle(IpcChannel.MemoryWrite, (_event, payload: unknown) => callHost(IpcChannel.MemoryWrite, payload))
  ipcMain.handle(IpcChannel.MemoryEdit, (_event, payload: unknown) => callHost(IpcChannel.MemoryEdit, payload))
  ipcMain.handle(IpcChannel.MemoryRemove, (_event, payload: unknown) => callHost(IpcChannel.MemoryRemove, payload))
  ipcMain.handle(IpcChannel.MemoryRollback, (_event, payload: unknown) => callHost(IpcChannel.MemoryRollback, payload))
  // —— T-24/T-25：能力库条目面 + 附件面（宿主通道透传） ——
  ipcMain.handle(IpcChannel.CapabilityList, (_event, payload: unknown) => callHost(IpcChannel.CapabilityList, payload))
  ipcMain.handle(IpcChannel.CapabilityWrite, (_event, payload: unknown) => callHost(IpcChannel.CapabilityWrite, payload))
  ipcMain.handle(IpcChannel.CapabilityEdit, (_event, payload: unknown) => callHost(IpcChannel.CapabilityEdit, payload))
  ipcMain.handle(IpcChannel.CapabilityDelete, (_event, payload: unknown) => callHost(IpcChannel.CapabilityDelete, payload))
  ipcMain.handle(IpcChannel.CapabilityRefAdd, (_event, payload: unknown) => callHost(IpcChannel.CapabilityRefAdd, payload))
  ipcMain.handle(IpcChannel.CapabilityRefRemove, (_event, payload: unknown) => callHost(IpcChannel.CapabilityRefRemove, payload))
  ipcMain.handle(IpcChannel.AttachmentAdd, (_event, payload: unknown) => callHost(IpcChannel.AttachmentAdd, payload))
  ipcMain.handle(IpcChannel.AttachmentRemove, (_event, payload: unknown) => callHost(IpcChannel.AttachmentRemove, payload))
  // —— S3：文件安全设置面 / 安全中心设置 / 会话策略（宿主持久化与校验） ——
  ipcMain.handle(IpcChannel.FileSecurityGet, () => callHost(IpcChannel.FileSecurityGet))
  ipcMain.handle(IpcChannel.FileSecuritySet, (_event, payload: unknown) => callHost(IpcChannel.FileSecuritySet, payload))
  ipcMain.handle(IpcChannel.FileSecurityReset, () => callHost(IpcChannel.FileSecurityReset))
  ipcMain.handle(IpcChannel.SecuritySettingsGet, () => callHost(IpcChannel.SecuritySettingsGet))
  ipcMain.handle(IpcChannel.SecuritySettingsSet, (_event, payload: unknown) => callHost(IpcChannel.SecuritySettingsSet, payload))
  ipcMain.handle(IpcChannel.SessionSetPolicy, (_event, payload: unknown) => callHost(IpcChannel.SessionSetPolicy, payload))
  // 打开备份目录：main 侧 shell 能力（同 workspace:pick 先例——host-core 零 Electron）
  ipcMain.handle(IpcChannel.BackupOpenDir, async () => {
    const dir = path.join(app.getPath('userData'), 'backups')
    mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true }
  })
  // —— S3-S4：审计报告 / 取证包导出（宿主载入面 + 内核链校验单点） ——
  ipcMain.handle(IpcChannel.AuditReport, (_event, payload: unknown) => callHost(IpcChannel.AuditReport, payload))
  ipcMain.handle(IpcChannel.AuditExport, (_event, payload: unknown) => callHost(IpcChannel.AuditExport, payload))
  // —— S3-S5：计量聚合（价目未同步金额 = null，渲染层「价目未同步」） ——
  ipcMain.handle(IpcChannel.MeteringSummary, (_event, payload: unknown) => callHost(IpcChannel.MeteringSummary, payload))
  // —— S4-S1：插件/MCP 只读装载面 ——
  ipcMain.handle(IpcChannel.PluginsList, () => callHost(IpcChannel.PluginsList))
  ipcMain.handle(IpcChannel.PluginsAdd, (_event, payload: unknown) => callHost(IpcChannel.PluginsAdd, payload))
  ipcMain.handle(IpcChannel.PluginsRemove, (_event, payload: unknown) => callHost(IpcChannel.PluginsRemove, payload))
  ipcMain.handle(IpcChannel.McpList, (_event, payload: unknown) => callHost(IpcChannel.McpList, payload))
  // —— S4-S2：自定义端点凭据（main 侧 safeStorage 独占——Key 解密后推宿主装配，渲染层不触达） ——
  ipcMain.handle(IpcChannel.CredentialsSave, (_event, payload: { baseUrl: string; model: string; key: string; contextWindow?: number }) => {
    const meta = saveEndpoint(app.getPath('userData'), { ...payload, contextWindow: payload.contextWindow ?? null })
    // Key 内存流转：解密后推宿主装配（credentials:key-push——宿主缓存，不落盘不打印）
    return callHost(IpcChannel.CredentialsKeyPush, { ...meta, key: payload.key }).then(() => meta)
  })
  ipcMain.handle(IpcChannel.CredentialsMeta, () => loadEndpointMeta(app.getPath('userData')))
  ipcMain.handle(IpcChannel.CredentialsClear, () => {
    clearEndpoint(app.getPath('userData'))
    return callHost(IpcChannel.CredentialsKeyPush, { clear: true })
  })
  // —— S4-S2：doctor 全项 + 模型元数据（值不打印；元数据表 Key 永不出面——终验红条修补：main 路由漏注册） ——
  ipcMain.handle(IpcChannel.DoctorRun, (_event, payload: unknown) => callHost(IpcChannel.DoctorRun, payload))
  // S5：models:meta 载荷透传（workspaceId → 池成员分组数据面——此前无载荷形态丢弃了 workspaceId）
  ipcMain.handle(IpcChannel.ModelsMeta, (_event, payload: unknown) => callHost(IpcChannel.ModelsMeta, payload))
  // —— T-23：自动更新（main 侧能力——同 workspace:pick 先例，不入宿主 dispatch） ——
  ipcMain.handle(IpcChannel.UpdateCheck, () => checkForUpdates().then(() => ({ ok: true })))
  ipcMain.handle(IpcChannel.UpdateDownload, () => downloadUpdate().then(() => ({ ok: true })))
  ipcMain.handle(IpcChannel.UpdateInstall, () => {
    installUpdate()
    return { ok: true }
  })
  ipcMain.handle(IpcChannel.UpdateOpenReleases, () => openReleases().then(() => ({ ok: true })))
  // —— T-25：附件文件选择器（main 侧 dialog 能力——同 workspace:pick 先例，选中后转宿主登记落链） ——
  ipcMain.handle(IpcChannel.AttachmentPick, async (event): Promise<string[] | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(win!, {
      title: '选择附件（文本类 ≤200KB 全文注入；其余路径登记，模型经 fs_read 按需读取）',
      properties: ['openFile', 'multiSelections'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return picked.filePaths
  })
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
  // T-23：自动更新初始化 + 启动检查（CAR_SMOKE 无头冒烟跳过——不触网；dev 形态 updater 短路 disabled）
  const smoke = process.env.CAR_SMOKE === '1'
  if (!smoke) {
    initUpdater((s) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IpcPushTopic.UpdateStatus, s)
      }
    })
    void checkForUpdates()
  }
  // 启动即推端点 Key（safeStorage 解密 → 宿主内存——跨重启的自定义端点续用）
  const storedKey = revealEndpointKey(app.getPath('userData'))
  if (storedKey) {
    const meta = loadEndpointMeta(app.getPath('userData'))
    if (meta) {
      try {
        await callHost(IpcChannel.CredentialsKeyPush, { ...meta, key: storedKey })
      } catch (err) {
        console.error('[main] 端点 Key 推送失败（宿主未就绪）：', err instanceof Error ? err.message : err)
      }
    }
  }
  const win = await createWindow(!smoke)
  if (smoke) {
    // 无头冒烟（CAR_SMOKE=1，窗口 show:false）：桥在位 + probe 全链
    // （renderer preload 桥 → ipcMain → utilityProcess → host-core → seam 顶层入口）
    try {
      const bridgeOk = await win.webContents.executeJavaScript(
        "!!window.car && typeof window.car.probe === 'function' && typeof window.car.sendTurn === 'function' && typeof window.car.onSessionEvent === 'function' && typeof window.car.auditReport === 'function' && typeof window.car.meteringSummary === 'function' && typeof window.car.fileSecurityGet === 'function'",
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
