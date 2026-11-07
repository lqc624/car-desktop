/**
 * SKILL.md 导入解析（能力库导入互认；纯决策层——零 electron 依赖，node:test 可测，
 * credentials-store.ts 同款分层纪律）
 *
 * 口径：
 *  - 输入 = SKILL.md 全文（frontmatter `--- ... ---` + 正文）+ 源文件名；
 *  - 映射：name→name（缺省用文件名去 .md）；description→spec 首行 blockquote（引导模型何时用）；
 *    version/author/tags→同名元数据（tags 支持内联数组或逗号分隔）；kind 恒 'skill'；status 恒 'active'；
 *  - id = slugify(name)→slugify(文件名)→'imported-skill' 兜底（CAPABILITY_ID_RE 同款字符域）；
 *    冲突消解（-2/-3 后缀）由宿主装配层做（需查盘），本模块只产确定性候选；
 *  - fail-visible：无正文 / spec 超限（CAPABILITY_SPEC_MAX）→ 显式 error，禁静默截断；
 *  - 未知 frontmatter 键忽略（白盒可改，不阻塞导入）。
 */
import { CAPABILITY_SPEC_MAX } from './capabilities.ts'

export interface SkillMdParsed {
  name?: string
  description?: string
  version?: string
  author?: string
  tags?: string[]
  body: string
}

export interface SkillImportError {
  ok: false
  error: string
}

export interface SkillImportCandidate {
  ok: true
  id: string
  kind: 'skill'
  name: string
  spec: string
  version?: string
  author?: string
  tags?: string[]
  status: 'active'
}

/** 最小 frontmatter 解析：仅 `key: value` 标量行 + 内联数组；无嵌套/多行（SKILL.md 实际形态足够） */
export function parseSkillMd(raw: string): SkillMdParsed {
  const text = (raw ?? '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { body: text.trim() }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  if (close === -1) return { body: text.trim() }
  const parsed: SkillMdParsed = { body: lines.slice(close + 1).join('\n').trim() }
  for (const line of lines.slice(1, close)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key === 'name' && value) parsed.name = value
    else if (key === 'description' && value) parsed.description = value
    else if (key === 'version' && value) parsed.version = value
    else if (key === 'author' && value) parsed.author = value
    else if (key === 'tags' && value) {
      const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
      const tags = inner
        .split(/[,，;；]+/)
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      if (tags.length > 0) parsed.tags = tags
    }
  }
  return parsed
}

/** id 候选推导：小写字母数字连字符（CAPABILITY_ID_RE 字符域）；空输入返回空串由调用方兜底 */
export function slugifyCapabilityId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '')
}

/** SKILL.md → 能力条目候选（写盘与冲突消解在宿主装配层；本函数纯解析） */
export function skillMdToCapability(raw: string, sourceName: string): SkillImportCandidate | SkillImportError {
  const parsed = parseSkillMd(raw)
  const baseName = sourceName.replace(/\.md$/i, '')
  const name = parsed.name?.trim() || baseName.trim()
  if (!parsed.body) {
    return { ok: false, error: `无规范正文（frontmatter 后为空）——${sourceName}` }
  }
  const spec = parsed.description ? `> ${parsed.description}\n\n${parsed.body}` : parsed.body
  if (spec.length > CAPABILITY_SPEC_MAX) {
    return { ok: false, error: `规范正文超限（${spec.length} > ${CAPABILITY_SPEC_MAX} 字符）——${sourceName}` }
  }
  const id = slugifyCapabilityId(parsed.name ?? '') || slugifyCapabilityId(baseName) || 'imported-skill'
  return {
    ok: true,
    id,
    kind: 'skill',
    name,
    spec,
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(parsed.author ? { author: parsed.author } : {}),
    ...(parsed.tags ? { tags: parsed.tags } : {}),
    status: 'active',
  }
}
