/**
 * T-FV-2 后台 bash 任务管理器（宿主侧组合，内核零加法；per-session 挂 SessionHandle——SubagentManager 同款）
 *
 * 口径：
 *  - **执行基底 = child_process.spawn 系统默认 shell**（win32: ComSpec /d /s /c；posix: /bin/sh -c）。
 *    内核 SandboxExecutor（seam）= Linux landlock **前台同步面**（ExecResult 一次性返回，无后台
 *    句柄/流式/kill）——不适用后台形态；Windows 本就降级。安全兜底 = M3 授权门（工具
 *    declaredSideEffect='write'：只读策略硬拒 / 默认策略人审门 / 会话内放行 grant 缓存）+
 *    命令安全规则面 = WB-5（v0.19 C2 已接：commandSecurity 引擎 deny/ask 三档清单 + authorize ⓪⁴
 *    确认门；本文件承担执行侧 deny re-check 纵深兜底——原「S4 待接」注记销号）；
 *  - **落链叙事 = 父链 system kind + payload.type**（EventKind 零新增，subagent/* 同款先例）：
 *    `bash/start {taskId, command, cwd}` 先落（孤儿口径同 spawn——崩溃于启动即孤链可收割）；
 *    `bash/exit {taskId, exitCode, durationMs, outputBytes, stopped?}` 进程 close 落；
 *    `bash/kill {taskId, reason}` 终止信号落。**输出内容不进链**（可能含密钥/超量）——
 *    读取面 bash:output 过内核 redact()（K-FS-4）后返回尾部窗口；
 *  - **护栏 fail-visible**：并发 ≤4（CAR-E-BASH-CONC）/ command ≤2000 字符 / cwd 必须在
 *    工作区内（词法解析，fsReadTool 兜底同口径）/ 输出环形缓冲 512KB 尾部语义；
 *  - **孤儿收割**：宿主重启后链上 bash/start 无对应 exit/kill = 死进程——attach 时补
 *    `bash/exit {stopped:true, note:'宿主重启收割'}`（K2 recoverChildSessions 补记先例），
 *    防派生行态永挂「运行中」；
 *  - **停止 = 终止信号**（win32 taskkill /t /f 杀进程树，posix child.kill）；kill 后 close
 *    事件以 stopped:true 收口。级联：abortTurn → abortAll（turn 中断杀全部任务）/ close → closeAll。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import { redact, type SessionLog } from '@lqc123qwe/car-runtime'
import type { CommandSecurityEngine } from './commandSecurity.ts'
import type { HostToolDef } from './types.ts'

/** Q-BT 护栏参数（首版常量；car.config 化 = 后备候选） */
export const BASH_MAX_CONCURRENT = 4
export const BASH_COMMAND_MAX_CHARS = 2000
export const BASH_OUTPUT_CAP = 512 * 1024

export interface BashOutputResult {
  taskId: string
  running: boolean
  exitCode: number | null
  durationMs: number | null
  /** 尾部窗口（已过内核 redact 脱敏——密钥面不渲染不落读取面） */
  tail: string
  /** 输出总量超过缓冲上限 = 尾部窗口非全量 */
  truncated: boolean
  outputBytes: number
  stopped: boolean
}

export interface BashManagerDeps {
  parentLog: SessionLog
  workspaceRoot: string
  /** C7（AD-2 · Q-AD2）：自然退出回调（stopped = false 才回调——用户终止/收割不触发接回；
   *  宿主聚合缓冲 → steer 引导落链（自动唤醒档）或仅徽标（提醒档）） */
  onTaskComplete?: (t: { taskId: string; exitCode: number | null; outputBytes: number }) => void
  /** WB-5（v0.19 C2）：命令安全引擎（执行侧 deny re-check 纵深兜底——authorize ⓪⁴ 门拦为主层；
   *  缺省 = 无引擎不拦（测试形态）） */
  commandSecurity?: CommandSecurityEngine
}

interface TaskEntry {
  taskId: string
  command: string
  cwd: string
  child: ChildProcess
  startedAt: number
  killed: boolean
  finished: boolean
  exitCode: number | null
  stopped: boolean
  outputBytes: number
  /** 环形缓冲（尾部语义——超上限从头部截除） */
  chunks: string[]
  bytes: number
}

export class BashTaskManager {
  private readonly tasks = new Map<string, TaskEntry>()
  private readonly deps: BashManagerDeps

  constructor(deps: BashManagerDeps) {
    this.deps = deps
  }

  activeCount(): number {
    let n = 0
    for (const t of this.tasks.values()) if (!t.finished) n++
    return n
  }

  /** 模型工具面：bash_run（declaredSideEffect='write'——M3 授权门 + 只读策略硬拒真值在 authorize） */
  tools(): HostToolDef[] {
    return [this.runTool()]
  }

  private runTool(): HostToolDef {
    return {
      name: 'bash_run',
      declaredSideEffect: 'write',
      description:
        '后台执行系统 shell 命令（Windows=cmd /d/s/c；posix=sh -c），立即返回任务 id 不阻塞——输出尾部可查、可停止。' +
        '参数：command（命令行）、cwd?（工作目录，必须在工作区内，缺省 = 工作区根）。启动/退出/停止均落审计链。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要后台执行的命令行' },
          cwd: { type: 'string', description: '可选工作目录（工作区内相对或绝对路径；缺省 = 工作区根）' },
        },
        required: ['command'],
      },
      run: async (args) => {
        const a = (args ?? {}) as Record<string, unknown>
        const command = typeof a['command'] === 'string' ? a['command'] : ''
        const cwd = typeof a['cwd'] === 'string' && a['cwd'] ? a['cwd'] : undefined
        return this.run(command, cwd)
      },
    }
  }

  /** 启动后台任务（bash/start 先落——孤儿收割口径；护栏 fail-visible，禁静默排队） */
  run(command: string, cwdArg?: string): { ok: true; taskId: string; state: 'running'; note: string } {
    if (!command || !command.trim()) throw new Error('CAR-E-DESKTOP: bash_run 缺少 command')
    if (command.length > BASH_COMMAND_MAX_CHARS) {
      throw new Error(`CAR-E-DESKTOP: bash_run 命令超长（${command.length} > ${BASH_COMMAND_MAX_CHARS} 字符）`)
    }
    const active = this.activeCount()
    if (active >= BASH_MAX_CONCURRENT) {
      throw new Error(`CAR-E-BASH-CONC: 后台任务并发超上限（${active} ≥ ${BASH_MAX_CONCURRENT}）——先等待或停止既有任务`)
    }
    // cwd 词法校验（fsReadTool 兜底同口径）：工作区内相对路径或绝对路径，越界 fail-visible
    const cwd = cwdArg ? (isAbsolute(cwdArg) ? cwdArg : resolve(this.deps.workspaceRoot, cwdArg)) : this.deps.workspaceRoot
    const rel = relative(resolve(this.deps.workspaceRoot), resolve(cwd))
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`CAR-E-DESKTOP: bash_run cwd 越界（${cwdArg}）——仅允许工作区内目录`)
    }
    // WB-5 执行侧 re-check（tools.ts hardReject 先例——纵深双层：authorize ⓪⁴ 门拦为主层，
    // 本处兜底直调形态；拒于 bash/start 落链前 = BT-3 零 start 行判据同款）
    const hard = this.deps.commandSecurity?.hardReject(command)
    if (hard) throw new Error(hard)
    const taskId = 'BK-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    // bash/start 先落链（subagent/spawn 孤儿口径：崩溃于其后 = 孤儿可收割）
    this.deps.parentLog.append('runtime', 'system', 'session', { type: 'bash/start', taskId, command, cwd })
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', command], { cwd, windowsHide: true })
      : spawn('/bin/sh', ['-c', command], { cwd })
    const entry: TaskEntry = {
      taskId,
      command,
      cwd,
      child,
      startedAt: Date.now(),
      killed: false,
      finished: false,
      exitCode: null,
      stopped: false,
      outputBytes: 0,
      chunks: [],
      bytes: 0,
    }
    this.tasks.set(taskId, entry)
    const onChunk = (d: Buffer): void => {
      if (entry.finished) return
      entry.outputBytes += d.length
      entry.chunks.push(d.toString('utf8'))
      entry.bytes += d.length
      while (entry.bytes > BASH_OUTPUT_CAP && entry.chunks.length > 1) {
        const drop = entry.chunks.shift()!
        entry.bytes -= Buffer.byteLength(drop, 'utf8')
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('close', (code) => {
      entry.finished = true
      entry.exitCode = typeof code === 'number' ? code : null
      if (entry.killed) entry.stopped = true
      // bash/exit 落链（输出内容不进链——outputBytes 为唯一体量事实）
      this.deps.parentLog.append('runtime', 'system', 'session', {
        type: 'bash/exit',
        taskId,
        exitCode: entry.exitCode,
        durationMs: Date.now() - entry.startedAt,
        outputBytes: entry.outputBytes,
        ...(entry.stopped ? { stopped: true } : {}),
      })
      // C7（AD-2）：自然退出接回回调（stopped 不触发——用户终止是显式动作，无「等待语义」待闭合）
      if (!entry.stopped) this.deps.onTaskComplete?.({ taskId, exitCode: entry.exitCode, outputBytes: entry.outputBytes })
    })
    return { ok: true, taskId, state: 'running', note: '后台任务已启动（bash/start 落链）——用输出查询看尾部、停止可终止' }
  }

  /** 输出尾部查询（读取面过 redact——K-FS-4；输出内容不落链，链上只有体量事实） */
  output(taskId: string): BashOutputResult {
    const t = this.tasks.get(taskId)
    if (!t) throw new Error(`CAR-E-DESKTOP: 后台任务不存在（${taskId}）`)
    const raw = t.chunks.join('')
    const r = redact(raw)
    return {
      taskId,
      running: !t.finished,
      exitCode: t.exitCode,
      durationMs: Date.now() - t.startedAt,
      tail: r.redacted,
      truncated: t.outputBytes > BASH_OUTPUT_CAP,
      outputBytes: t.outputBytes,
      stopped: t.stopped,
    }
  }

  /** 终止信号（bash/kill 落链；win32 taskkill /t /f 杀进程树，posix child.kill） */
  kill(taskId: string, reason = 'user/model requested kill'): { ok: true; taskId: string; note: string } {
    const t = this.tasks.get(taskId)
    if (!t) throw new Error(`CAR-E-DESKTOP: 后台任务不存在（${taskId}）`)
    if (t.finished) throw new Error(`CAR-E-DESKTOP: 后台任务已结束（${taskId}）——无可停止对象`)
    t.killed = true
    this.deps.parentLog.append('runtime', 'system', 'session', { type: 'bash/kill', taskId, reason })
    if (process.platform === 'win32' && t.child.pid) {
      // 子进程树可能派生孙进程——taskkill /t 树杀（child.kill 只杀 shell 本体）
      spawn('taskkill', ['/pid', String(t.child.pid), '/t', '/f'], { windowsHide: true })
    } else {
      t.child.kill('SIGTERM')
    }
    return { ok: true, taskId, note: '已发终止信号——进程树终止后以 bash/exit(stopped) 收口' }
  }

  /** 孤儿收割（attach 时调用）：链上 bash/start 无 exit/kill = 前宿主进程死任务，补 stopped 收口 */
  reapOrphans(): number {
    const started = new Map<string, boolean>()
    for (const e of this.deps.parentLog.events) {
      if (e.kind !== 'system') continue
      const p = e.payload as Record<string, unknown> | null
      if (!p || typeof p['taskId'] !== 'string') continue
      const type = String(p['type'] ?? '')
      if (type === 'bash/start') started.set(String(p['taskId']), true)
      else if (type === 'bash/exit' || type === 'bash/kill') started.delete(String(p['taskId']))
    }
    let n = 0
    for (const taskId of started.keys()) {
      this.deps.parentLog.append('runtime', 'system', 'session', {
        type: 'bash/exit',
        taskId,
        exitCode: null,
        durationMs: null,
        outputBytes: null,
        stopped: true,
        note: '宿主重启收割（bash/start 无收口——K2 孤儿补记先例）',
      })
      n++
    }
    return n
  }

  /** 级联：turn 中断（abortTurn）——全部运行中任务树杀 */
  abortAll(): void {
    for (const t of [...this.tasks.values()]) {
      if (!t.finished) {
        try {
          this.kill(t.taskId, 'turn-abort cascade')
        } catch {
          /* 已收口竞态 = 忽略（close 事件幂等） */
        }
      }
    }
  }

  /** 级联：会话收口（close）——abortAll 同义（任务不跨会话生命周期） */
  closeAll(): void {
    this.abortAll()
  }
}
