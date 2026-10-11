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
  createAnthropicAdapter,
  createOpenAICompatAdapter,
  chatStep,
  CredentialService,
  loadCarConfig,
  mergeLlmConfig,
  warmCarConfig,
  type LlmAdapter,
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
}

/** 装载工作区 LLM 运行时；模型配置缺失/无效 fail-visible（引导配置，禁静默降级） */
export async function loadHostRuntime(workspaceRoot: string): Promise<HostRuntime> {
  // cli.ts 生产顺序（S2 修补：先 warm 后 load——car.config.ts 未预热 = CAR-E-CONFIG，
  // 跨运行重建的进程缓存为空，工作区来自上次注册时此缺口必现）
  await warmCarConfig({ cwd: workspaceRoot })
  const loaded = loadCarConfig({ cwd: workspaceRoot })
  if (loaded.error) throw new Error(loaded.error)
  const llm = mergeLlmConfig(process.env, loaded.config, {})
  if (!llm.baseUrl || !llm.model) {
    throw new Error(
      'CAR-E-LLM-CONFIG: 会话主旅程需要 llm.baseUrl + llm.model——' +
        '配置 car.config.ts（export default { llm: { baseUrl: "https://…", model: "…" } }）' +
        '或 env CAR_LLM_BASE_URL + CAR_LLM_MODEL',
    )
  }
  const credService = new CredentialService()
  const core = new RuntimeCore(credService)
  core.bindContext(new Context())
  const adapter: LlmAdapter & { id: string } = llm.adapterId === 'anthropic'
    ? createAnthropicAdapter({ baseUrl: llm.baseUrl, credentials: credService, provider: 'anthropic' })
    : createOpenAICompatAdapter({ baseUrl: llm.baseUrl, credentials: credService, provider: 'openai-compat' })
  core.registerLlmAdapter(adapter, { default: true })
  return { core, llm, toolDefs: [], mcpServers: loaded.config.mcp?.servers ?? {} }
}

/** 生产 model 回调：chatStep 包装（内核 N1/脱敏/投影内嵌；模型名取会话态——D-S2-3 model/set 生效点） */
export function createChatModelFn(opts: {
  runtime: HostRuntime
  log: Parameters<typeof chatStep>[0]['log']
  signal: { aborted: boolean }
  currentTurnId: () => string
  currentModel: () => string
  toolDefs: HostToolDef[]
}): HostModelFn {
  return () =>
    chatStep({
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
      signal: opts.signal,
    })
}

/** 凭据在位探测（doctor 展示位；值不打印——只回布尔与来源键名） */
export function credentialPresence(llm: { adapterId?: string; allowEnvFallback: boolean }): { present: boolean; envKey: string } {
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
