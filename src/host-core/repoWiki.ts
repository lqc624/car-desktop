/**
 * T-RW RepoWiki 宿主核纯函数：工作区扫描清单 / 大纲提示词与解析 / 页面提示词 / fence 清理。
 * 编排（fire-and-forget + 进度推送 + 落链）在 service.ts；共享 DTO 在 ipc-contract。
 *
 * 口径：
 *  - **确定性预算**（禁全仓无界读）：文件数 ≤200、语料字符 ≤60,000（fs_read 同管线——
 *    redact 脱敏 / 256KB 截断 / 二进制拒读白得）；排除目录出厂剪枝（.git/node_modules/.car/…）；
 *  - 大纲 ≤6 页；页 id 走 assertSafeId 同规（防 LLM 产出 slug 拼路径穿越）；
 *  - 解析容错三段式照抄 memoryEvolve（原文 → fence → 首 `[` 末 `]` 截取）。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_WIKI_MAX_FILES = 200
export const REPO_WIKI_CHAR_BUDGET = 60_000
export const REPO_WIKI_MAX_PAGES = 6

/** 出厂排除目录（剪枝——.git 占仓库样本大头；.car = 拒绝×3 预设面；构建产物面） */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.car', 'dist', 'build', 'out', 'coverage'])

export interface WikiOutlinePage {
  id: string
  title: string
  /** 本页聚焦的工作区相对路径（编排按清单过滤语料） */
  files: string[]
  focus: string
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface WorkspaceScan {
  /** 相对路径清单（排序——确定性，测试可断言） */
  files: string[]
  /** 被剪枝的目录（相对路径——排除面审计事实：.git/node_modules/.car/…） */
  prunedDirs: string[]
}

/** 递归清单（排除目录剪枝——禁全仓无界；排序确定性） */
export function scanWorkspace(root: string): WorkspaceScan {
  const files: string[] = []
  const prunedDirs: string[] = []
  const cap = REPO_WIKI_MAX_FILES * 4
  const walk = (dir: string, rel: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) {
          prunedDirs.push(childRel)
        } else {
          walk(join(dir, e.name), childRel)
        }
      } else {
        files.push(childRel)
      }
      if (files.length >= cap) return
    }
  }
  walk(root, '')
  return { files: files.slice(0, REPO_WIKI_MAX_FILES), prunedDirs }
}

export function buildOutlinePrompt(inventory: ReadonlyArray<{ path: string; chars?: number }>): string {
  const items = inventory.map((f) => `${f.path}（${f.chars} 字符）`).join('\n')
  return [
    '你是仓库文档助手。以下 JSON 是工作区文本文件清单（相对路径 + 语料字符数；.git/node_modules/拒绝路径已排除；内容已脱敏）。',
    '请为这个仓库设计 RepoWiki 页面大纲：2-6 页（00 总览页必有，其余按模块/配置/运维划分）。',
    '只输出一个 JSON 数组，每项形如 {"id":"00","title":"项目总览","files":["src/a.ts"],"focus":"本页要点一句话"}；id 用两位序号；files 从清单里选本页要引用的文件（每页 ≤20 个）。不要输出数组以外的任何文字。',
    '文件清单：',
    JSON.stringify(inventory.map((f) => f.path), null, 0),
    items.length > 0 ? `语料规模：共 ${inventory.length} 文件 / ${inventory.reduce((n, f) => n + (f.chars ?? 0), 0)} 字符。` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 三段式 JSON 提取（原文 → fence → 首 `[` 末 `]` 截取——memoryEvolve 同款） */
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

export function parseOutlineResponse(text: string, knownFiles: ReadonlySet<string>): WikiOutlinePage[] {
  const json = extractJsonArray(text)
  if (!json) throw new Error('CAR-E-DESKTOP: RepoWiki 大纲响应不含 JSON 数组（模型输出不合规）')
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch {
    throw new Error('CAR-E-DESKTOP: RepoWiki 大纲 JSON 解析失败（模型输出不合规）')
  }
  if (!Array.isArray(arr)) throw new Error('CAR-E-DESKTOP: RepoWiki 大纲不是数组（模型输出不合规）')
  const pages: WikiOutlinePage[] = []
  for (const item of arr.slice(0, REPO_WIKI_MAX_PAGES)) {
    const o = item as Record<string, unknown>
    const id = typeof o?.['id'] === 'string' ? o['id'].trim() : ''
    const title = typeof o?.['title'] === 'string' ? o['title'].trim().slice(0, 60) : ''
    const focus = typeof o?.['focus'] === 'string' ? o['focus'].trim().slice(0, 200) : ''
    const files = Array.isArray(o?.['files'])
      ? (o['files'] as unknown[]).filter((f): f is string => typeof f === 'string' && knownFiles.has(f)).slice(0, 20)
      : []
    if (!SAFE_ID_RE.test(id) || !title) continue
    if (pages.some((p) => p.id === id)) continue
    pages.push({ id, title, files, focus })
  }
  if (pages.length === 0) throw new Error('CAR-E-DESKTOP: RepoWiki 大纲解析为空（模型输出不合规）')
  return pages.slice(0, REPO_WIKI_MAX_PAGES)
}

export interface WikiCorpusFile {
  path: string
  content: string
}

/** 页面提示词：本页 files 语料拼装（单页语料 ≤ 24k 字符——超页预算截断标注） */
export function buildPagePrompt(page: WikiOutlinePage, corpus: ReadonlyArray<WikiCorpusFile>): string {
  const perPageBudget = 24_000
  const picked: WikiCorpusFile[] = []
  let used = 0
  for (const rel of page.files) {
    const f = corpus.find((c) => c.path === rel)
    if (!f) continue
    if (used + f.content.length > perPageBudget) {
      const room = perPageBudget - used
      if (room < 500) break
      picked.push({ path: f.path, content: f.content.slice(0, room) + `\n…（超页预算已截断）` })
      used = perPageBudget
      break
    }
    picked.push(f)
    used += f.content.length
  }
  const corpusText = picked.map((f) => `----- ${f.path} -----\n${f.content}`).join('\n\n')
  return [
    `你是仓库文档助手。请为 RepoWiki 写页面「${page.id} ${page.title}」。`,
    page.focus ? `本页要点：${page.focus}` : '',
    '只依据下列工作区文件语料（已脱敏）；不确定处写「（待补充）」禁编造。输出 markdown 正文（以 `# ` 标题开头），不要输出正文以外的任何文字。',
    corpusText ? `\n语料：\n\n${corpusText}` : '\n（本页无指定语料——按总述常识写概览骨架，标注待补充）',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 页面正文清理：剥 code fence 包裹（模型偶发把整页包进 ```markdown） */
export function stripFences(text: string): string {
  const raw = text.trim()
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(raw)
  return (fence?.[1] ?? raw).trim()
}
