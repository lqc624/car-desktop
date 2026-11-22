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
import { ABORTED_AT_LABEL, FAILURE_KIND_LABEL } from '../shared/failure-kinds.ts'
import type { SettlementLite } from '../shared/settlement-rows.ts'
import type { ChainDiskReconRow } from './reconciliation.ts'

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

/** C2（W-1c）turnEnd 尾部扫描行（供 service 从最近会话 JSONL 收集——本函数纯汇总可测） */
export interface TurnEndLite {
  ts: number
  meta: Record<string, unknown> | null
}

/**
 * ⑤ C2（W-1c）：近期失败细类行——turnEnd meta.kind 九类中文标签（W-0 处置动作随标签）+
 * abortedAt 取消时机；kind 缺失 = 1.22 旧事件（reason 原样呈现）。失败在案 = ok:false（红行
 * fail-visible）；无失败 = ok:true。完整事实在审计链（本行 = 医生面摘要，值不打印红线：只出
 * 类别标签不含 detail 消息原文）。
 */
export function summarizeRecentFailures(turnEnds: readonly TurnEndLite[]): { label: string; ok: boolean; detail: string } {
  const failures = turnEnds
    .filter((e) => e.meta?.['reason'] === 'error' || e.meta?.['reason'] === 'aborted')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
  if (!failures.length) {
    return { label: '近期失败细类', ok: true, detail: '最近会话无 error/aborted turn' }
  }
  const parts = failures.map((e) => {
    const reason = String(e.meta?.['reason'] ?? '?')
    const kind = typeof e.meta?.['kind'] === 'string' ? String(e.meta['kind']) : null
    const abortedAt = typeof e.meta?.['abortedAt'] === 'string' ? String(e.meta['abortedAt']) : null
    const label = kind
      ? (FAILURE_KIND_LABEL[kind] ?? `${kind}（未知类别——原样呈现）`)
      : abortedAt
        ? (ABORTED_AT_LABEL[abortedAt] ?? '取消')
        : reason
    return `${label}（${reason}${abortedAt ? `/${abortedAt}` : ''}）`
  })
  return { label: '近期失败细类', ok: false, detail: `${parts.join('；')}（处置动作随标签；完整事实在审计链）` }
}

/**
 * ⑥ W-2（D-B2-9）：近期结算行——settlement 回执聚合（内核 1.24；hasUnknownOutcomes = 红行
 * fail-visible——「取消后结果不明的工具显式记账」进医生面）。老链（1.23 及更早）或无新 turn
 * = 无事件（绿行缺席事实，非缺陷——禁静默改写历史链形态）。
 */
export function summarizeRecentSettlements(settlements: readonly SettlementLite[]): { label: string; ok: boolean; detail: string } {
  if (!settlements.length) {
    return { label: '近期结算', ok: true, detail: '最近会话无 settlement 事件（1.23 及更早链或无新 turn——非缺陷）' }
  }
  const unknown = settlements.filter((s) => s.tool.hasUnknownOutcomes)
  const denials = settlements.reduce((n, s) => n + s.tool.permissionDenialCount, 0)
  const interrupted = settlements.filter((s) => s.outcome !== 'complete').length
  const parts: string[] = [`${settlements.length} turn`]
  if (interrupted) parts.push(`${interrupted} 非正常收口`)
  if (denials) parts.push(`授权拒 ${denials}`)
  if (unknown.length) {
    return {
      label: '近期结算',
      ok: false,
      detail: `${parts.join(' · ')} · ${unknown.length} turn 存在结果不明工具（hasUnknownOutcomes——副作用状态见审计链）`,
    }
  }
  return { label: '近期结算', ok: true, detail: `${parts.join(' · ')}（无结果不明记账）` }
}

/**
 * ⑦ C6（LF-1 · Q-LF1）：链盘对账行——「链上最近一次成功写入的内容，现在是否还在盘上」三态
 * 汇总（一致/已删除绿面；漂移红行 fail-visible——对账不判责只陈述）。盲区常驻脚注：bash_run /
 * 浏览器写动作 / 进程外修改不经 fs 三件套账本。指纹两案（LF-3）：案 B 回执自含 / 案 A 链直推
 * 重放——reconciliation.ts 承载。无 fs 账面 = 绿行缺席事实（非缺陷）。
 */
export function summarizeChainDiskRecon(rows: readonly ChainDiskReconRow[], sessions: number, warnings: readonly string[]): DoctorRow {
  const blind = '盲区常驻：bash_run/浏览器写/进程外修改不经本对账'
  const warnPart = warnings.length > 0 ? ` · 告警 ${warnings.length}` : ''
  if (!rows.length) {
    return { label: '链盘对账', ok: true, detail: `${sessions} 链无 fs_write/fs_delete 账面（${blind}）${warnPart}` }
  }
  const drift = rows.filter((r) => r.state === 'drift')
  // 红面 = 漂移 + 链上无删除收口的盘缺（D-V171-4——链外消失同漂移关注级）；链上删除收口的盘缺 = 一致面
  const goneUnexpected = rows.filter((r) => r.state === 'deleted' && r.lastOp === 'fs_write')
  const goneSanctioned = rows.filter((r) => r.state === 'deleted' && r.lastOp === 'fs_delete')
  const problems = [...drift, ...goneUnexpected]
  const match = rows.length - problems.length - goneSanctioned.length
  const parts = [`${sessions} 链 · ${rows.length} 路径`, `${match} 一致`, `${goneSanctioned.length} 已删除（链上收口）`]
  if (problems.length > 0) {
    const top = problems
      .slice(0, 3)
      .map((r) => `${r.path.slice(0, 60)}（${r.note.slice(0, 40)}）`)
      .join('；')
    return {
      label: '链盘对账',
      ok: false,
      detail: `${parts.join(' · ')} · 待关注 ${problems.length}：${top}${problems.length > 3 ? ' 等' : ''}（对账不判责只陈述；${blind}）${warnPart}`,
    }
  }
  return { label: '链盘对账', ok: true, detail: `${parts.join(' · ')}（${blind}）${warnPart}` }
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
