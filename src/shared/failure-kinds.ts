/**
 * C2 · 失败细类中文标签面（内核 1.23.0-W1 turnEnd meta.kind/abortedAt 的桌面消费——W-1c）
 *
 * 口径：
 *  - 标签与内核 LlmErrorKind 注册表一一对应（9 类——missing 表项 = 内核加类而桌面未跟，禁静默）；
 *  - 处置动作随标签（refusal → 换模型/调提示词；context-limit-suspect → 压缩/缩短输入——
 *    与 W-0 审计处置映射一致）；kind 缺失 = 1.22 旧事件（不带键），无标签（向后兼容）；
 *  - abortedAt 两值标签（before-request/in-flight）——F-W0-3 链上区分的消费面。
 *  双域可用：零运行时依赖（App.tsx 渲染面 + service/doctor 扫描面共用——单一真源）。
 */

/** LlmErrorKind 注册表 9 类 → 中文标签 + 处置动作（内核 src/runtime-core/types.ts 对拍） */
export const FAILURE_KIND_LABEL: Record<string, string> = {
  'transport-4xx': '传输失败（provider 4xx）',
  'transport-exhausted': '传输不可达/重试耗尽（可重试）',
  'stream-midbreak': '流中断（已消费内容不重放）',
  'no-finish-reason': '流未正常收口（无 finishReason）',
  refusal: '模型拒答（建议换模型或调整提示词）',
  'proto-invalid-args': '协议违规（工具参数非法 JSON）',
  'context-limit-suspect': '疑似上下文超限（建议压缩或缩短输入）',
  'unmapped-finish': '未识别停止信号（provider 新形态）',
  'provider-stream-error': '网关流错误（overloaded 等）',
}

/** turnEnd abortedAt 两值 → 中文标签 */
export const ABORTED_AT_LABEL: Record<string, string> = {
  'before-request': '未发出即取消',
  'in-flight': '在途取消',
}

/** 标签查询：未知 kind → null（消费方回退原文呈现，禁静默吞） */
export function failureKindLabel(kind: string | undefined | null): string | null {
  if (!kind) return null
  return FAILURE_KIND_LABEL[kind] ?? null
}

/** 内核注册表对拍（9 类全在表——漏项 fail-visible 供测试钉死） */
export const FAILURE_KIND_IDS = Object.keys(FAILURE_KIND_LABEL)
