/**
 * S4-S2 · doctor 诊断（立项书 F-D5；值不打印红线——输出面只有布尔/键名/耗时/错误类别）
 *
 * 三行口径：
 *  ①凭据在位：env 键存在（键名可显）或自定义端点 Key 已在册（内存态——只回布尔）；
 *  ②LLM 连通性：对 baseUrl 发最小 GET（/models——OpenAI 兼容；anthropic = /v1/models），
 *    计耗时；失败回错误类别（HTTP 状态 / 网络错误），不回请求内容；
 *  ③seam 探测：probeSeam 复用（版本/符号数——doctor 展示位既有事实）。
 */
import { probePoolMember, type PoolMember } from '@lqc123qwe/car-runtime'
import { probeSeam } from './probe.ts'
import { credentialPresence } from './model.ts'

export interface DoctorRow {
  label: string
  ok: boolean
  /** 展示明细（值不打印：只含布尔/键名/耗时/状态码/错误类别） */
  detail: string
}

export interface DoctorInput {
  /** mergeLlmConfig 产物（adapterId/allowEnvFallback——键名分派用；allowEnvFallback 可缺省） */
  llm: { adapterId?: string; allowEnvFallback?: boolean; baseUrl?: string }
  /** 自定义端点 Key 已在宿主内存（credentials:key-push 缓存） */
  endpointKeyPresent: boolean
  /** 自定义端点激活时 = 其 baseUrl（连通性探测目标），否则 car.config llm.baseUrl */
  effectiveBaseUrl: string
  /** 连通性探测用 Key（自定义端点内存 Key 或 env——只进请求头，禁打印） */
  probeKey: string | null
  /** S5（D-S5-5）：池成员（car.config llm.modelPool——无池 = 空数组，不出池健康段） */
  poolMembers?: PoolMember[]
}

/** LLM 连通性最小探测：GET {baseUrl}/models（OpenAI 兼容）/ {baseUrl}/v1/models（anthropic），5s 超时 */
async function probeConnectivity(baseUrl: string, adapterId: string | undefined, key: string | null): Promise<DoctorRow> {
  const started = Date.now()
  const url = baseUrl.replace(/\/+$/, '') + (adapterId === 'anthropic' ? '/v1/models' : '/models')
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const headers: Record<string, string> = adapterId === 'anthropic' ? { 'x-api-key': key ?? '' } : key ? { Authorization: `Bearer ${key}` } : {}
    const res = await fetch(url, { headers, signal: ctrl.signal })
    clearTimeout(timer)
    const ms = Date.now() - started
    return {
      label: 'LLM 连通性',
      ok: res.ok,
      detail: res.ok ? `正常 · ${ms}ms` : `HTTP ${res.status} · ${ms}ms`,
    }
  } catch (err) {
    const ms = Date.now() - started
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { label: 'LLM 连通性', ok: false, detail: aborted ? `超时（>5s）` : `网络错误 · ${ms}ms` }
  }
}

export async function runDoctor(input: DoctorInput): Promise<{ rows: DoctorRow[] }> {
  const rows: DoctorRow[] = []
  // ①凭据在位（env 键名可显；自定义端点 Key 只回布尔）
  const cred = credentialPresence(input.llm)
  const credOk = cred.present || input.endpointKeyPresent
  rows.push({
    label: '凭据',
    ok: credOk,
    detail: cred.present
      ? `已配置 · ${cred.envKey}（值不打印）`
      : input.endpointKeyPresent
        ? '已配置 · 自定义端点 Key（值不打印）'
        : `未配置（需 ${cred.envKey} 或注册自定义端点）`,
  })
  // ②LLM 连通性
  rows.push(await probeConnectivity(input.effectiveBaseUrl ?? '', input.llm.adapterId, input.probeKey))
  // ③seam 探测（probeSeam 既有展示位）
  const seam = probeSeam()
  rows.push({ label: '内核 seam', ok: seam.symbolCount > 0, detail: `${seam.seamVersion}（${seam.symbolCount} 符号导出）` })
  // ④S5（D-S5-5）：池健康行——逐端点 probePoolMember（值不打印纪律延续：只出状态/延迟/类别）
  for (const m of input.poolMembers ?? []) {
    const h = await probePoolMember(m, { timeoutMs: 4000 })
    rows.push({
      label: `池端点 ${m.id}`,
      ok: h.ok,
      detail: h.ok
        ? `可达 · HTTP ${h.status ?? '?'} · ${h.latencyMs}ms · model=${m.model}`
        : `不可达 · ${h.errorCategory ?? 'network-error'} · ${h.latencyMs}ms（降级时按序 fallback，fail-visible 落链）`,
    })
  }
  return { rows }
}
