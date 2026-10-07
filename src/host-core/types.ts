/**
 * 宿主结构类型（内核 seam 未出面类型的本地镜像——TS 结构化类型在 runTurn/chatStep
 * 调用点由 dist/seam.d.ts 逐字段核对，漂移即编译错——调用点即契约）
 */

/** 内核 ModelStep 镜像（loop/stop.ts 1.12 实查） */
export interface HostModelStep {
  text?: string
  stopReason: 'stop' | 'length' | 'toolUse' | 'error'
  toolCalls?: Array<{ id: string; tool: string; args: Record<string, unknown> }>
  /** length 时 provider 给出的「截断工具调用」：只有名字，args 不可信 */
  truncatedTools?: Array<{ id: string; tool: string }>
}

export type HostModelFn = () => Promise<HostModelStep>

/** 内核 ToolDef 镜像（执行面与声明面同一对象——声明面=授权面红线；缺声明即 write） */
export interface HostToolDef {
  name: string
  declaredSideEffect: 'readonly' | 'write'
  run(args: Record<string, unknown>): Promise<unknown>
  description?: string
  parameters?: unknown
}

/** turn 结束原因（内核 TurnEndReason 六值，1.12 实查） */
export type HostTurnEndReason = 'completed' | 'max-tokens' | 'aborted' | 'error' | 'blocked' | 'interrupted'
