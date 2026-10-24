/**
 * 生产模型回调装配（cli.ts:185-215 生产调用点蓝本——桌面侧逐件对齐，零自创装配）
 *
 * 口径：
 *  - 模型配置 = mergeLlmConfig(env, car.config llm)（桌面无 flag 层；优先级 env > config）；
 *  - RuntimeCore + bindContext(new Context()) + registerLlmAdapter({default:true})——
 *    cli.ts 同序（bindContext 先于 register，可逆注册分支）；
 *  - 凭据 = 内核 CredentialService（env OPENAI_API_KEY / ANTHROPIC_API_KEY；env fallback
 *    需 llm.allowEnvFallback / CAR_ALLOW_ENV_CREDENTIALS=1——内核侧 fail-visible，桌面不旁路）；
 *  - chatStep 契约：N1 断言 + 脱敏 + 投影推导全部内嵌（token 级旁路 = 红线，D-S2-1）；
 *  - 测试注入点：modelFactory 覆盖本模块（假模型脚本，内核 runTurn 仍真跑——行为证明）。
 */
import {
  Context,
  RuntimeCore,
  assembleModelPool,
  createAnthropicAdapter,
  createOpenAICompatAdapter,
  chatStep,
  CredentialService,
  loadCarConfig,
  mergeLlmConfig,
  warmCarConfig,
  type LlmAdapter,
  type CompactionConfig,
  type PoolMember,
  type RoutingDecision,
} from '@lqc123qwe/car-runtime'
import type { HostModelFn, HostToolDef } from './types.ts'
import type { SessionEventDTO } from '../shared/ipc-contract.ts'

/** 供桌面装配的内核运行时件（打开会话时构建一次，随句柄生命周期） */
export interface HostRuntime {
  core: RuntimeCore
  llm: ReturnType<typeof mergeLlmConfig>
  toolDefs: Array<{ name: string; description?: string; parameters?: unknown; declaredSideEffect: 'readonly' | 'write' }>
  /** S4：MCP server 装载规格（car.config mcp.servers——schema zod 校验过；无登记 = 空对象） */
  mcpServers: Record<string, { command?: string; url?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string> }>
  /** S5（D-S5-1）：池成员（car.config llm.modelPool——无池 = null；候选序就位） */
  poolMembers: PoolMember[] | null
}

/** S4-S2 自定义端点覆盖（装配级——Key 经 main safeStorage 解密后由 IPC 内存推送，不落盘不打印）。
 *  K5-D（V2）：adapterId 端点声明（anthropic 网关有了端点路线——商汤类 Claude Code 型网关
 *  baseUrl 不带 /v1、Key 走 ANTHROPIC_API_KEY 通道）；缺省/缺省值 = openai-compat（存量档兼容）。 */
export interface EndpointOverride {
  baseUrl: string
  model: string
  key: string
  contextWindow: number | null
  adapterId?: 'openai-compat' | 'anthropic'
}

/**
 * 装载工作区 LLM 运行时；模型配置缺失/无效 fail-visible（引导配置，禁静默降级）。
 * endpoint 覆盖顺序 = 自定义端点 > car.config llm（R-D6：端点为 OpenAI 兼容形态——
 * adapter 强制 openai-compat；Key 经 process.env 注入内核 CredentialService 解析面，
 * 宿主 utilityProcess 内 env 变更进程内封闭、不落盘不打印）。
 * S5（D-S5-1）：car.config llm.modelPool 在场 → assembleModelPool 池适配器 default
 * （池压过 llm.baseUrl/model/adapterId——每次路由决策落链可解释）；routingSink = onDecide
 * 落链出口（sink holder 模式——RuntimeCore 先建、句柄 log 后建，服务层创建句柄后回填）。
 */
export async function loadHostRuntime(
  workspaceRoot: string,
  endpoint?: EndpointOverride | null,
  opts: { routingSink?: (d: RoutingDecision) => void } = {},
): Promise<HostRuntime & { contextWindow: number | null; compaction: CompactionConfig | undefined }> {
  // cli.ts 生产顺序（S2 修补：先 warm 后 load——car.config.ts 未预热 = CAR-E-CONFIG，
  // 跨运行重建的进程缓存为空，工作区来自上次注册时此缺口必现）
  await warmCarConfig({ cwd: workspaceRoot })
  const loaded = loadCarConfig({ cwd: workspaceRoot })
  if (loaded.error) throw new Error(loaded.error)
  const llm = mergeLlmConfig(process.env, loaded.config, {})
  const poolCfg = loaded.config.modelPool ?? null
  const baseUrl = endpoint?.baseUrl ?? llm.baseUrl
  const model = endpoint?.model ?? llm.model
  if (endpoint?.key) {
    // K5-D（V2）：Key 通道随端点 adapterId 分流（anthropic 网关 = ANTHROPIC_API_KEY——内核
    // credentials.ts provider 通道表；openai-compat 维持 OPENAI_API_KEY）
    const keyEnv = endpoint.adapterId === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
    process.env[keyEnv] = endpoint.key
    // 端点 Key = 用户显式配置（safeStorage 面板）——env 通道开启（进程内封闭；
    // 此前该通路依赖会话 env 残留的 CAR_ALLOW_ENV_CREDENTIALS 假绿——确定性前提修正）
    process.env['CAR_ALLOW_ENV_CREDENTIALS'] = '1'
  }
  if (!poolCfg && (!baseUrl || !model)) {
    throw new Error(
      'CAR-E-LLM-CONFIG: 会话主旅程需要 llm.baseUrl + llm.model——' +
        '配置 car.config.ts（export default { llm: { baseUrl: "https://…", model: "…" } }）' +
        '或 env CAR_LLM_BASE_URL + CAR_LLM_MODEL（多端点用 llm.modelPool）',
    )
  }
  const credService = new CredentialService()
  const core = new RuntimeCore(credService)
  core.bindContext(new Context())
  let adapter: LlmAdapter & { id: string }
  let poolMembers: PoolMember[] | null = null
  if (poolCfg) {
    // 池装配压过单端点——routing/decide 落链经 onDecide（sink holder 回填）
    const assembly = assembleModelPool({
      pool: poolCfg,
      credentials: credService,
      ...(opts.routingSink ? { onDecide: opts.routingSink } : {}),
    })
    adapter = assembly.adapter
    poolMembers = assembly.members
  } else {
    // 单端点装配（baseUrl/model 已由上方守卫保证非空——TS 属性收窄不穿透池分支，此处断言）。
    // K5-D（V2）：端点 adapterId 声明生效（anthropic = Messages API 形态）；无端点 = car.config
    // llm.adapterId 原语义（商汤类 anthropic 网关的既有通路，S4 终验实证）
    const adapterId = endpoint
      ? (endpoint.adapterId ?? 'openai-compat')
      : (llm.adapterId === 'anthropic' ? 'anthropic' : 'openai-compat')
    adapter = adapterId === 'anthropic'
      ? createAnthropicAdapter({ baseUrl: baseUrl!, credentials: credService, provider: 'anthropic' })
      : createOpenAICompatAdapter({ baseUrl: baseUrl!, credentials: credService, provider: 'openai-compat' })
  }
  core.registerLlmAdapter(adapter, { default: true })
  const contextWindow = endpoint?.contextWindow ?? null
  // 端点激活 = 显式声明形态（R-D6 / K5-D）：adapterId 必须同步覆盖——否则 createChatModelFn 按
  // car.config 的旧 adapterId 查找未注册适配器 → CAR-E-LLM-NOADAPTER（1018 终验红条）
  return {
    core,
    llm: {
      ...llm,
      ...(poolCfg ? { adapterId: 'model-pool' } : { baseUrl, model }),
      ...(endpoint && !poolCfg ? { adapterId: endpoint.adapterId ?? 'openai-compat' } : {}),
    },
    toolDefs: [],
    mcpServers: loaded.config.mcp?.servers ?? {},
    contextWindow,
    poolMembers,
    // S5（D-S5-2）：压缩策略随装配单次读出（sendTurn 自动挂载点判定入参）。
    // K5-D（V1）：桌面缺省开——car.config 无 llm.compaction 键 = { enabled: true }
    // （token 维度阈值由句柄 armedCompactionCfg 按窗口真值 ×0.78 装甲；无窗口 = 仅事件维度，
    // 实际短会话不触发）。**键在场 = 内核语义原样**（含 enabled 缺席 = 关——显式配置优先，
    // 退关通道 = compaction: { enabled: false }）；内核 1.13 兼容线（enabled 缺省关）不动。
    compaction: loaded.config.llm?.compaction ?? { enabled: true },
  }
}

/** 生产 model 回调：chatStep 包装（内核 N1/脱敏/投影内嵌；模型名取会话态——D-S2-3 model/set 生效点） */
export function createChatModelFn(opts: {
  runtime: HostRuntime
  log: Parameters<typeof chatStep>[0]['log']
  signal: { aborted: boolean }
  currentTurnId: () => string
  currentModel: () => string
  toolDefs: HostToolDef[]
  /** S5（D-S5-3）：会话级思考档位（off/缺席 = 不下发该字段，字节面零痕迹） */
  currentReasoning?: () => 'off' | 'low' | 'medium' | 'high' | null
}): HostModelFn {
  return () => {
    // 会话级思考档位——每次请求实时读（model/set 即时生效）
    const r = opts.currentReasoning?.() ?? null
    return chatStep({
      core: opts.runtime.core,
      log: opts.log,
      turnId: opts.currentTurnId(),
      model: opts.currentModel(),
      tools: opts.toolDefs.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
        declaredSideEffect: t.declaredSideEffect,
      })),
      ...(opts.runtime.llm.maxTokens !== undefined ? { maxTokens: opts.runtime.llm.maxTokens } : {}),
      ...(opts.runtime.llm.adapterId ? { adapterId: opts.runtime.llm.adapterId } : {}),
      // S5（D-S5-3）：reasoning 透传（off/缺席 = 字节面零痕迹）
      ...(r && r !== 'off' ? { reasoning: { effort: r } } : {}),
      signal: opts.signal,
    })
  }
}

/** 凭据在位探测（doctor 展示位；值不打印——只回布尔与来源键名） */
export function credentialPresence(llm: { adapterId?: string; allowEnvFallback?: boolean }): { present: boolean; envKey: string } {
  const envKey = llm.adapterId === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
  return { present: Boolean(process.env[envKey]), envKey }
}

/** 推送前防御性序列化（SessionEventDTO 镜像 = 落盘行 parse 产物；解析失败 = 结构漂移，fail-visible） */
export function parseEventLine(line: string): SessionEventDTO {
  const e = JSON.parse(line) as SessionEventDTO
  if (typeof e.seq !== 'number' || typeof e.kind !== 'string' || typeof e.hash !== 'string') {
    throw new Error('CAR-E-DESKTOP: 事件行结构与 SessionEventDTO 镜像失配——内核 SessionEvent 形态漂移，禁止推送')
  }
  return e
}
