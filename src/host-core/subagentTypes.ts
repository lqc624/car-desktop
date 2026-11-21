/**
 * 0.14.0 · Z-3 类型化声明档（Q-Z3 / D-QD1-1 并案，《内核1.27-Q-D1第二步-PTC子链与REPL-迭代规划.md》）
 *
 * 口径（防两套语义——声明档 = 既有权限面的组合声明，非新权限面）：
 *  - 类型 = { 工具白名单, 描述 } 注册表（可裁剪——MEMORY_TYPES 先例：加档改此数组）；
 *  - readonly 缺省档 = 现行为零变化（K2 起子链白名单硬编 ['fs_read'] 升为声明）；
 *  - ptc 档 = toolface 加 run_code（REPL 绑定实例——宿主装配层 createPtcRepl 承担，走宿主授权门
 *    D-QD1-5：run_code 强制 write → runTurn 人审门弹卡父会话；程序内子调用经权限回穿桥逐次过门）；
 *  - spawn 未声明类型 = readonly（现行为）；未知 id = fail-visible（CAR-E-SUBAGENT-TYPE）。
 */

export interface SubagentTypeSpec {
  id: string
  /** 工具白名单声明（子链 toolface——'run_code' 条目由宿主装配层绑 REPL 实例） */
  toolface: readonly string[]
  description: string
}

export const SUBAGENT_TYPES: readonly SubagentTypeSpec[] = [
  {
    id: 'readonly',
    toolface: ['fs_read'],
    description: '只读扇出（缺省档——工具面收窄即安全形态；K2 现行为）',
  },
  {
    id: 'ptc',
    toolface: ['fs_read', 'run_code'],
    description: '程序化工具调用（run_code = 持久 REPL——走宿主授权门；程序内子调用逐次过门）',
  },
] as const

export type SubagentTypeId = (typeof SUBAGENT_TYPES)[number]['id']

/** 类型解析：缺省 readonly（现行为）；未知 id fail-visible（注册表可裁剪——加档改数组） */
export function resolveSubagentType(id?: string): SubagentTypeSpec {
  if (id === undefined || id === '') return SUBAGENT_TYPES[0]!
  const spec = SUBAGENT_TYPES.find((t) => t.id === id)
  if (!spec) {
    throw new Error(`CAR-E-SUBAGENT-TYPE: 未知子 Agent 类型 "${String(id)}"（注册表：${SUBAGENT_TYPES.map((t) => t.id).join('/')}——fail-visible）`)
  }
  return spec
}
