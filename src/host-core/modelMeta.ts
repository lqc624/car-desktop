/**
 * S4-S2 · 内置模型元数据表（D-S4-8：桌面静态表，非内核面——内核无模型目录服务）
 *
 * 口径（原型 v0.4「内置模型窗口取元数据（S4 模型元数据批）」/ D-C5）：
 *  - ctx 百分比真值来源：会话模型命中表 → contextWindow；未命中（自定义端点未声明）= null
 *    → 渲染层不显示百分比（禁估算——S2 既有洞，本表补上内置面）；
 *  - 思考档位 = 模型级（V3.2 非思考 / R1 深度思考——切模型即切思考，无需参数下发）；
 *    自定义端点思考随 K-MP-1（v0.2）；
 *  - 表随适配器家族维护（v0.1 仅 DeepSeek 官方端点两档），漂移仅影响展示口径。
 */

export interface ModelMeta {
  /** 上下文窗口（tokens）——ctx-pop 百分比真值 */
  contextWindow: number
  /** 思考档位：none = 非思考档；model-level = 思考绑定模型本身 */
  thinking: 'none' | 'model-level'
  label: string
}

export const MODEL_META: Record<string, ModelMeta> = {
  'deepseek-chat': { contextWindow: 128_000, thinking: 'none', label: 'DeepSeek-V3.2 · 内置适配器' },
  'deepseek-reasoner': { contextWindow: 128_000, thinking: 'model-level', label: 'DeepSeek-R1 · 内置适配器' },
}

/** 元数据解析：内置表命中 → 表值；未命中 → null（渲染层不显示百分比，禁估算） */
export function resolveModelMeta(model: string | null): ModelMeta | null {
  if (!model) return null
  return MODEL_META[model] ?? null
}
