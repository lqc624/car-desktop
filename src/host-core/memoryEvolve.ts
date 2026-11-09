/**
 * 记忆进化核（T-ME）：确定性提示词 + 模型响应解析（纯函数可测；redact 为内核面——本模块是
 * host-core，可 import 内核；共享类型/常量在 src/shared/memory-evolution.ts）。
 *
 * 口径：
 *  - 提示词确定性拼装（条目 id/text/updatedAt JSON 注入——禁随机措辞，测试可断言）；
 *  - 解析容错：直接 parse → code fence 提取 → 首个 '[' 至末个 ']' 截取（三段式，禁正则抢跑）；
 *  - 候选校验：op 枚举 / add·update 需 text ≤2000 / update·delete targetId 必须在既有 id 集 /
 *    tags ≤10 条字符串 / reason ≤300；非法逐条剔除（dropped 计数——fail-visible 交上层裁决，
 *    禁静默半应用）；全部字段过内核 redact（K-FS-4——模型输出可能回显记忆中的密钥面）。
 */
import { redact } from '@lqc123qwe/car-runtime'
import { type EvolutionCandidate, type EvolutionOp } from '../shared/memory-evolution.ts'

export const EVOLVE_MAX_CANDIDATES = 10
export const EVOLVE_TEXT_MAX_CHARS = 2000
export const EVOLVE_REASON_MAX_CHARS = 300

export interface EvolvePromptEntry {
  id: string
  text: string
  updatedAt: number
}

export function buildEvolvePrompt(entries: ReadonlyArray<EvolvePromptEntry>): string {
  const items = entries.map((e) => ({ id: e.id, text: e.text, updatedAt: e.updatedAt }))
  return [
    '你是记忆重组助手。以下 JSON 是用户的长期记忆条目（白盒存储，逐条独立文件）。',
    '请提出变更候选：合并重复、修正过时表述、删除失效条目、补充显性缺口。',
    '只输出一个 JSON 数组，每项形如 {"op":"add|update|delete","targetId":"仅 update/delete 需要","text":"新正文","tags":["可选"],"reason":"一句话理由"}；至多 10 条；无建议输出 []。不要输出数组以外的任何文字。',
    '记忆条目：',
    JSON.stringify(items, null, 0),
  ].join('\n')
}

/** 三段式容错提取：原文 → fence → 括号截取 */
function extractJsonArray(text: string): string | null {
  const raw = text.trim()
  if (raw.startsWith('[')) {
    const end = raw.lastIndexOf(']')
    if (end > 0) return raw.slice(0, end + 1)
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  if (fence?.[1]) {
    const inner = fence[1].trim()
    if (inner.startsWith('[')) {
      const end = inner.lastIndexOf(']')
      if (end > 0) return inner.slice(0, end + 1)
    }
  }
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start >= 0 && end > start) return raw.slice(start, end + 1)
  return null
}

const OPS: ReadonlyArray<EvolutionOp> = ['add', 'update', 'delete']

export interface EvolveParseResult {
  candidates: EvolutionCandidate[]
  /** 被剔除的非法条目数（fail-visible 面可展示） */
  dropped: number
}

export function parseEvolveResponse(text: string, knownIds: ReadonlySet<string>): EvolveParseResult {
  const json = extractJsonArray(text)
  if (!json) throw new Error('CAR-E-DESKTOP: 进化响应不含 JSON 数组（模型输出不合规）')
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    throw new Error('CAR-E-DESKTOP: 进化响应 JSON 解析失败（模型输出不合规）')
  }
  if (!Array.isArray(arr)) throw new Error('CAR-E-DESKTOP: 进化响应不是数组（模型输出不合规）')
  const candidates: EvolutionCandidate[] = []
  let dropped = 0
  for (const item of arr.slice(0, EVOLVE_MAX_CANDIDATES * 3)) {
    if (candidates.length >= EVOLVE_MAX_CANDIDATES) {
      dropped++
      continue
    }
    const o = item as Record<string, unknown>
    const op = o?.['op']
    const text2 = typeof o?.['text'] === 'string' ? o['text'].trim() : ''
    const targetId = typeof o?.['targetId'] === 'string' ? o['targetId'] : undefined
    const reasonRaw = typeof o?.['reason'] === 'string' ? o['reason'].trim() : ''
    const tags = Array.isArray(o?.['tags']) ? (o['tags'] as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 10) : undefined
    const okOp = OPS.includes(op as EvolutionOp) ? (op as EvolutionOp) : null
    const valid =
      okOp !== null &&
      (okOp === 'delete' || (text2.length > 0 && text2.length <= EVOLVE_TEXT_MAX_CHARS)) &&
      (okOp === 'add' || (targetId !== undefined && knownIds.has(targetId)))
    if (!valid) {
      dropped++
      continue
    }
    const r = redact(text2)
    const rr = redact(reasonRaw)
    candidates.push({
      cid: 'C' + (candidates.length + 1),
      op: okOp,
      ...(okOp !== 'add' && targetId ? { targetId } : {}),
      text: r.redacted,
      ...(tags && tags.length > 0 ? { tags } : {}),
      reason: rr.redacted.slice(0, EVOLVE_REASON_MAX_CHARS),
    })
  }
  return { candidates, dropped }
}
