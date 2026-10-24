/**
 * 会话文件助手（宿主核心；零 Electron import）
 *
 * 口径（S2 扩展）：
 *  - 事实本体 = <workspace>/.car/sessions/<sessionId>.jsonl（内核 SessionLog/
 *    SessionFileStore 落盘形态，桌面不另设事实源）；
 *  - **桌面索引面** = <workspace>/.car/session-index.json（标题/删除态等 UI 元数据，
 *    权威源；区别于内核 sessions-index.db 的 CLI 索引）——删除 = 索引标 deleted，
 *    JSONL 文件保留不销毁（审计红线：日志不可变）；
 *  - 链上留痕（session/rename、session/delete）仅 resumable 句柄可落（D-S2-6），
 *    索引面恒为列表渲染权威。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEventDTO, SessionInfo } from '../shared/ipc-contract.ts'
import { parseEventLine } from './model.ts'

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]+$/

export interface SessionIndexEntry {
  title?: string
  deleted?: boolean
  /** T-K2-4：随父删除级联标记（值 = 父会话 id——审计定位「为什么不见了」） */
  deletedWithParent?: string
}

export interface SessionIndexFile {
  sessions: Record<string, SessionIndexEntry>
}

export function sessionsDirFor(workspaceRoot: string): string {
  return join(workspaceRoot, '.car', 'sessions')
}

function indexPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.car', 'session-index.json')
}

export function readSessionIndex(workspaceRoot: string): SessionIndexFile {
  const p = indexPath(workspaceRoot)
  if (!existsSync(p)) return { sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as SessionIndexFile
    return parsed.sessions && typeof parsed.sessions === 'object' ? parsed : { sessions: {} }
  } catch {
    // 索引损坏不阻塞会话面（派生缓存语义，与内核 index-updater 同纪律）——按空索引续跑
    return { sessions: {} }
  }
}

export function writeSessionIndex(workspaceRoot: string, idx: SessionIndexFile): void {
  writeFileSync(indexPath(workspaceRoot), JSON.stringify(idx, null, 2), 'utf8')
}

export function assertSafeId(kind: '会话' | '工作区', id: string): void {
  const re = kind === '会话' ? SESSION_ID_RE : WORKSPACE_ID_RE
  if (!re.test(id)) {
    throw new Error(`CAR-E-DESKTOP: 非法 ${kind} id（${id.slice(0, 32)}）——仅允许字母数字下划线连字符`)
  }
}

/** 会话 JSONL 全量解析（fail-visible：行结构与 SessionEventDTO 镜像失配即抛） */
export function parseSessionEvents(workspaceRoot: string, sessionId: string): SessionEventDTO[] {
  assertSafeId('会话', sessionId)
  const p = join(sessionsDirFor(workspaceRoot), sessionId + '.jsonl')
  if (!existsSync(p)) {
    throw new Error(`CAR-E-DESKTOP: 会话不存在（${sessionId}）`)
  }
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => parseEventLine(l))
}

export function listSessions(workspaceRoot: string, workspaceId: string): SessionInfo[] {
  assertSafeId('工作区', workspaceId)
  const dir = sessionsDirFor(workspaceRoot)
  if (!existsSync(dir)) return []
  const idx = readSessionIndex(workspaceRoot)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((sid) => !idx.sessions[sid]?.deleted)
    .map((sid) => sessionInfo(workspaceRoot, workspaceId, sid))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function sessionInfo(workspaceRoot: string, workspaceId: string, sessionId: string): SessionInfo {
  const p = join(sessionsDirFor(workspaceRoot), sessionId + '.jsonl')
  if (!existsSync(p)) throw new Error(`CAR-E-DESKTOP: 会话不存在（${sessionId}）`)
  const idx = readSessionIndex(workspaceRoot)
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0)
  // K2：子链 parentSessionId（首事件 session-start 载荷——列表面徽标数据源；解析失败不阻塞计数面）
  let parentSessionId: string | null = null
  if (lines[0]) {
    try {
      const first = JSON.parse(lines[0]) as { kind?: string; payload?: Record<string, unknown> | null }
      if (first.kind === 'system' && first.payload?.['type'] === 'session-start' && typeof first.payload['parentSessionId'] === 'string') {
        parentSessionId = first.payload['parentSessionId']
      }
    } catch { /* 首行不可解析（异常形态）= 普通会话口径，计数面不阻塞 */ }
  }
  return {
    sessionId,
    workspaceId,
    createdAt: statSync(p).birthtimeMs,
    eventCount: lines.length,
    title: idx.sessions[sessionId]?.title ?? '未命名会话',
    ...(parentSessionId ? { parentSessionId } : {}),
  }
}
