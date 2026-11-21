/**
 * Z-1 延伸（0.15.0 / D-Z15-1~2）· 谱系树构建与对比配对校验（纯函数，零 IO 零 LLM）
 *
 * 数据源 = SessionInfo.forkedFrom（D-Z15-2 透传，索引镜像）。分叉叙事域（forkedFrom）与
 * 执行拓扑域（parentSessionId，K2 子链）语义不同——本模块只做 forkedFrom 谱系，不混入。
 */
import type { SessionEventDTO, SessionInfo } from '../shared/ipc-contract'

export interface LineageNode {
  session: SessionInfo
  children: LineageNode[]
  /** R-1：forkedFrom 指向已删/不存在会话 → 孤儿提升为根节点并如实标注（索引 deletedWithParent 级联删除是既有行为） */
  orphaned: boolean
}

/** 全工作区 forkedFrom 构树：未分叉会话为根，子会话挂父节点；R-1 孤儿提升为根。同层按创建时间升序。 */
export function buildLineage(sessions: SessionInfo[]): LineageNode[] {
  const nodes = new Map<string, LineageNode>(
    sessions.map((s) => [s.sessionId, { session: s, children: [], orphaned: false }]),
  )
  const roots: LineageNode[] = []
  for (const node of nodes.values()) {
    const parent = node.session.forkedFrom
    const parentNode = parent ? nodes.get(parent) : undefined
    if (parentNode) {
      parentNode.children.push(node)
    } else {
      node.orphaned = Boolean(parent)
      roots.push(node)
    }
  }
  const sortRec = (list: LineageNode[]): void => {
    list.sort((a, b) => a.session.createdAt - b.session.createdAt)
    for (const n of list) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

/** D-Z15-4：对比仅限同父两分支（跨层三方对比不做——负面清单）。禁用态给确定性原因文案。 */
export function pickComparePair(
  a: SessionInfo,
  b: SessionInfo,
): { ok: true; parentId: string } | { ok: false; reason: string } {
  if (!a.forkedFrom || !b.forkedFrom) {
    return { ok: false, reason: '对比仅限分叉出的子会话（所选会话须为谱系节点）' }
  }
  if (a.forkedFrom !== b.forkedFrom) {
    return { ok: false, reason: `两分支不同源（${a.forkedFrom} ≠ ${b.forkedFrom}）——对比仅限同父（跨层对比不做）` }
  }
  return { ok: true, parentId: a.forkedFrom }
}

export interface ForkPoint {
  /** 分叉边界（子链 = [0, upToSeq) 逐字节迁移——v0.13 forkInSession 同源语义） */
  upToSeq: number
  /** 源会话 id（fork-in 标记 fromSessionId） */
  fromSessionId: string
}

/** D-Z15-3：从链事件提取 fork-in 标记（kind='fork' + payload.type='branch' 判别——0.13 双向留痕形态）。无标记 = null（普通会话）。 */
export function forkPointFromEvents(events: SessionEventDTO[]): ForkPoint | null {
  for (const e of events) {
    if (e.kind === 'fork' && e.payload && typeof e.payload === 'object') {
      const p = e.payload as Record<string, unknown>
      if (p['type'] === 'branch' && typeof p['upToSeq'] === 'number' && typeof p['fromSessionId'] === 'string') {
        return { upToSeq: p['upToSeq'], fromSessionId: p['fromSessionId'] }
      }
    }
  }
  return null
}
