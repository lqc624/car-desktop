/**
 * 会话生命周期最小面（宿主核心；零 Electron import）
 *
 * 口径（立项书 D-C3/D-S1-4 + S1 规划 WBS S1-S3）：
 *  - 落盘布局 = <workspace>/.car/sessions/<sessionId>.jsonl（SessionFileStore 显式
 *    path 契约，内核无默认落盘约定——store.ts 构造器实查；布局登记进 S1 收口报告）；
 *  - 会话事实源 = 内核 SessionLog + SessionFileStore（桌面端不另设事实源）；
 *    创建即 append 一条 system/session-start 事件（工作区绑定落链，「切换均留痕」叙事）；
 *  - S1 只做 create/list/open 三动作；哈希链校验/断链定位属 S3 审计批（不在本面）；
 *  - sessionId/workspaceId 白名单字符校验——文件名拼装前拦截路径穿越（fail-visible）。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SessionFileStore, SessionLog } from '@lqc123qwe/car-runtime'
import type { SessionInfo, SessionOpenResult } from '../shared/ipc-contract.ts'

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]+$/

export function sessionsDirFor(workspaceRoot: string): string {
  return join(workspaceRoot, '.car', 'sessions')
}

function assertSafeId(kind: '会话' | '工作区', id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`CAR-E-DESKTOP: 非法 ${kind} id（${id.slice(0, 32)}）——仅允许字母数字下划线连字符`)
  }
}

export class SessionManager {
  create(workspaceRoot: string, workspaceId: string): SessionInfo {
    assertSafeId('工作区', workspaceId)
    const dir = sessionsDirFor(workspaceRoot)
    mkdirSync(dir, { recursive: true })
    const sessionId = 'S-' + Date.now().toString(36) + '-' + randomBytes(2).toString('hex')
    const store = new SessionFileStore(join(dir, sessionId + '.jsonl'))
    try {
      const log = new SessionLog(sessionId)
      log.attachSink((line) => store.append(line))
      log.append('runtime', 'system', 'session', { type: 'session-start', workspaceId, workspaceRoot })
    } finally {
      // S1 会话句柄即用即关（S2 起会话生命周期由宿主常驻管理）；关闭后续写 = CAR-E-STORE fail-fast（内核语义）
      store.close()
    }
    const file = join(dir, sessionId + '.jsonl')
    return {
      sessionId,
      workspaceId,
      createdAt: statSync(file).birthtimeMs,
      eventCount: this.countEvents(file),
    }
  }

  list(workspaceRoot: string, workspaceId: string): SessionInfo[] {
    assertSafeId('工作区', workspaceId)
    const dir = sessionsDirFor(workspaceRoot)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = join(dir, f)
        return {
          sessionId: f.slice(0, -'.jsonl'.length),
          workspaceId,
          createdAt: statSync(p).birthtimeMs,
          eventCount: this.countEvents(p),
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  open(workspaceRoot: string, sessionId: string): SessionOpenResult {
    assertSafeId('会话', sessionId)
    const p = join(sessionsDirFor(workspaceRoot), sessionId + '.jsonl')
    if (!existsSync(p)) {
      throw new Error(`CAR-E-DESKTOP: 会话不存在（${sessionId}）`)
    }
    return { sessionId, exists: true, eventCount: this.countEvents(p) }
  }

  private countEvents(file: string): number {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).length
  }
}
