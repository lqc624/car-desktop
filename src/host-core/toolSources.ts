/**
 * S4-S1 · 工具源装载面（立项书 F-D4；零 Electron）
 *
 * 口径：
 *  - 插件装载源 = **桌面登记文件** userData/plugin-paths.json（D-S4-2：内核 config schema 无
 *    plugins 键，桌面不改写工作区 car.config）；装载走内核 mountPlugin 全纪律（manifest 校验 /
 *    erasable-only 门 / ApiImpl 收集）；
 *  - MCP 装载源 = 工作区 car.config `mcp.servers`（K-3 schema 已有）→ McpGateway.register
 *    （stdio/HTTP 双传输，逐 server 隔离 try/catch——单 server 失败不阻塞其余装载，R-2）；
 *  - **T-22 缺省 write**：ToolReg/McpToolDefinition 未声明按最高约束（内核侧已收敛，桥面二次兜底）；
 *  - 跨源同名**显式报错**（禁静默覆盖——内核 tools.ts 同纪律，合并由本面去重保护）；
 *  - 五阶段装载报告：内核 PluginManager（含 Sigstore 签名门 + LoadReportVO）未在 seam 出面
 *    ——v0.1 呈现桌面装配状态（discover/parse/register 真实结果 + verify/topo 标注 SKIPPED），
 *    **K-S4-1 候选登记：seam 出面 PluginManager.reload + LoadReportVO**（执行期发现，v0.2 内核批）；
 *  - 网络轴消费：远程 MCP 工具 = net 类——server url 由本面记录（session authorize 经
 *    engine.decideNetwork 判定域名/URL 前缀规则）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mountPlugin, McpGateway, createStdioClientTransport, createHttpMcpTransport, resolveMcpHeaders } from '@lqc123qwe/car-runtime'
import type { HostToolDef } from './types.ts'

// ── 插件登记存储 ─────────────────────────────────────────────────────────

export interface PluginRegistration {
  id: string
  /** 插件模块文件（默认导出工厂 (api) => void；erasable-only 门在内核 mountPlugin） */
  file: string
  /** manifest（最低 { name, version }——mountPlugin 内 parseManifest 全校验） */
  manifest: unknown
}

export function pluginRegistryStore(userDataDir: string): {
  get(): PluginRegistration[]
  add(entry: Omit<PluginRegistration, 'id'> & { id?: string }): PluginRegistration[]
  remove(id: string): PluginRegistration[]
} {
  const file = path.join(userDataDir, 'plugin-paths.json')
  const load = (): PluginRegistration[] => {
    if (!existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed['plugins']) ? parsed['plugins'] : []
    } catch {
      return [] // 登记文件损坏按空处理（重新登记即可，无事实损失）
    }
  }
  const persist = (plugins: PluginRegistration[]): PluginRegistration[] => {
    mkdirSync(userDataDir, { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ plugins }, null, 2), 'utf8')
    renameSync(tmp, file)
    return plugins
  }
  let current = load()
  return {
    get: () => current,
    add(entry) {
      if (current.some((p) => p.file === entry.file)) {
        throw new Error(`CAR-E-DESKTOP: 插件已登记（${entry.file}）`)
      }
      const id = entry.id?.trim() || 'p-' + Date.now().toString(36)
      current = persist([...current, { id, file: entry.file, manifest: entry.manifest }])
      return current
    },
    remove(id) {
      current = persist(current.filter((p) => p.id !== id))
      return current
    },
  }
}

// ── 插件装载（mountPlugin → ToolReg 桥） ─────────────────────────────────

export interface PluginState {
  id: string
  name: string | null
  version: string | null
  status: 'loaded' | 'failed'
  tools: string[]
  error?: string
}

export interface PluginLoadResult {
  states: PluginState[]
  tools: HostToolDef[]
}

let pluginEpoch = 0

export async function loadPlugins(entries: readonly PluginRegistration[]): Promise<PluginLoadResult> {
  const states: PluginState[] = []
  const tools: HostToolDef[] = []
  const names = new Set<string>()
  const epoch = ++pluginEpoch // reload 击穿 ESM 缓存（每次服务装载 +1）
  for (const entry of entries) {
    try {
      const plugin = await mountPlugin({ file: entry.file, manifest: entry.manifest, reloadEpoch: epoch })
      const collected: Array<{ name: string; run: (args: Record<string, unknown>) => Promise<unknown>; description?: string; parameters?: unknown; declaredSideEffect?: 'readonly' | 'write' }> = []
      plugin.bindCore({
        registerTool: (t: { name: string; run: (args: Record<string, unknown>) => Promise<unknown>; description?: string; parameters?: unknown; declaredSideEffect?: 'readonly' | 'write' }) => collected.push(t),
        getRegisteredTools: () => collected,
      })
      const state: PluginState = { id: entry.id, name: plugin.manifest.name, version: plugin.manifest.version, status: 'loaded', tools: [] }
      for (const t of collected) {
        if (names.has(t.name)) throw new Error(`CAR-E-DESKTOP: 跨源工具同名冲突（${t.name}）——禁静默覆盖`)
        names.add(t.name)
        tools.push({
          name: t.name,
          // T-22：未声明按最高约束（write）——桥面二次兜底（内核 tools.ts 同款缺省）
          declaredSideEffect: t.declaredSideEffect ?? 'write',
          run: t.run,
          ...(t.description !== undefined ? { description: t.description } : {}),
          ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
        })
        state.tools.push(t.name)
      }
      states.push(state)
    } catch (err) {
      states.push({
        id: entry.id,
        name: null,
        version: null,
        status: 'failed',
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { states, tools }
}

// ── MCP 面（McpGateway 双传输 → ToolDef 桥） ─────────────────────────────

export interface McpServerSpecRaw {
  command?: string
  url?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpServerState {
  serverId: string
  transport: 'stdio' | 'http'
  status: 'connected' | 'failed'
  url: string | null
  tools: string[]
  error?: string
}

export interface McpFace {
  registerAll(): Promise<McpServerState[]>
  tools(): HostToolDef[]
  /** 工具名 → 远程 server url（网络轴判定数据源；stdio = null） */
  urlOf(toolName: string): string | null
  states(): McpServerState[]
  close(): void
}

export function createMcpFace(servers: Record<string, McpServerSpecRaw>): McpFace {
  const gateway = new McpGateway()
  const names = new Set<string>()
  const transports: Array<{ close(): void }> = []
  const states: McpServerState[] = []
  const tools: HostToolDef[] = []
  const urlByTool = new Map<string, string>()

  const registerAll = async (): Promise<McpServerState[]> => {
    for (const [serverId, spec] of Object.entries(servers)) {
      const isHttp = typeof spec.url === 'string' && !!spec.url
      try {
        const transport = isHttp
          ? createHttpMcpTransport({ url: spec.url!, ...(spec.headers ? { headers: resolveMcpHeaders(spec.headers) } : {}) })
          : createStdioClientTransport({ command: spec.command!, args: spec.args })
        transports.push(transport)
        const defs = await gateway.register({
          serverId,
          transport,
          ...(spec.env ? { env: spec.env } : {}),
        })
        for (const def of defs) {
          const name = `mcp_${serverId}_${def.name}`
          if (names.has(name)) throw new Error(`CAR-E-DESKTOP: 跨源工具同名冲突（${name}）——禁静默覆盖`)
          tools.push({
            name,
            // T-22：内核 register 已收敛缺省 write——桥面显式兜底
            declaredSideEffect: def.declaredSideEffect ?? 'write',
            run: async (args) => {
              const r = await gateway.callTool(serverId, def.name, args)
              if (!r.ok) throw new Error(r.error ?? `MCP 调用失败（${serverId}.${def.name}）`)
              return r.result
            },
            ...(def.description !== undefined ? { description: def.description } : {}),
            ...(def.inputSchema !== undefined ? { parameters: def.inputSchema } : {}),
          })
          if (isHttp) urlByTool.set(name, spec.url!)
        }
        states.push({
          serverId,
          transport: isHttp ? 'http' : 'stdio',
          status: 'connected',
          url: isHttp ? spec.url! : null,
          tools: defs.map((d) => d.name),
        })
      } catch (err) {
        // R-2：单 server 失败隔离——状态呈现，不阻塞其余装载
        states.push({
          serverId,
          transport: isHttp ? 'http' : 'stdio',
          status: 'failed',
          url: isHttp ? spec.url ?? null : null,
          tools: [],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return states
  }

  return {
    registerAll,
    tools: () => tools,
    urlOf: (toolName) => urlByTool.get(toolName) ?? null,
    states: () => states,
    close: () => {
      // 生命周期收口：stdio 子进程/stdin 流不收口会钉住宿主事件环（测试挂起源）
      for (const t of transports) {
        try { t.close() } catch { /* 收口容错 */ }
      }
      transports.length = 0
    },
  }
}

/** 合并工具源（内置 + 插件 + MCP）——跨源同名显式报错（禁静默覆盖） */
export function mergeToolSources(...sources: HostToolDef[][]): HostToolDef[] {
  const out: HostToolDef[] = []
  const names = new Set<string>()
  for (const src of sources) {
    for (const t of src) {
      if (names.has(t.name)) throw new Error(`CAR-E-DESKTOP: 跨源工具同名冲突（${t.name}）——禁静默覆盖`)
      names.add(t.name)
      out.push(t)
    }
  }
  return out
}
