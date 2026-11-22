/**
 * B-3 · 截图证据受管面（§4.8 视觉验收判据化协议——设计输入兑现；Z-7 fileviewer_get_view
 * userData 交接同款形态）
 *
 * 口径：
 *  - PNG 落盘 = 工具自管路径（userData/browser-shots/）——不经 fs_write（文本面 only）与
 *    fs_read（二进制拒读）的通用文件面；FileViewer 预览走受管证据 carve-out（用户自阅面，
 *    出厂 userData deny 不拦用户看自己的证据）；模型 fs 面不触碰证据目录；
 *  - 页面内容不进链（提案 §4.2）：链上只有 shotId/尺寸/字符数元数据；文本摘录在截图时刻冻结
 *    （过内核 redact + 256KB 截断显式标注）随 sidecar 落盘——判定面（visual 子代理档）经
 *    shot_read 消费，PNG 本身作用户终端唯一仲裁证据（FileViewer 预览）；
 *  - v1 结构化证据档（D-VB3-1 裁决）：内核适配器纯文本、网关 vision 未探——shot_read 不回传
 *    base64（多模态内核批落地后翻转为图块输出，登记 future，前置 = 网关 vision 探针）；
 *  - 上限 fail-visible：全局 BROWSER_SHOT_MAX（禁静默驱逐——evidence 是审计证据非缓存）；
 *    清除 = SecurityView 显式动作（browser:clear-evidence），会话删除不自动清（登记）；
 *  - 原子写纪律：tmp + rename（browserStore 同款）；index.json = 单写者串行追加（宿主单线程
 *    工具面——viewer-state.json 同形态）。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '@lqc123qwe/car-runtime'
import type { HostToolDef } from './types.ts'

/** 全局证据上限（fail-visible——禁静默驱逐审计证据） */
export const BROWSER_SHOT_MAX = 100

/** 证据目录名（userData 下） */
export const EVIDENCE_DIR = 'browser-shots'

export interface ShotProvenance {
  /** provenance 四件套（T-B7——缺一标缺失禁补全，browser_read 同口径） */
  url: string
  fetchedAt: string
  sortNote: string
  missing: string[]
  title: string | null
}

/** sidecar（<shotId>.json——截图时刻冻结的判定证据） */
export interface ShotSidecar extends ShotProvenance {
  shotId: string
  capturedAt: string
  viewport: { width: number; height: number } | null
  /** 截图时刻 innerText 摘录（已过 redact + 截断——落盘即脱敏形态） */
  textExcerpt: string
  textTruncated: boolean
  pngBytes: number
}

/** index.json 登记行（shot_read 列表面 / SecurityView 计数数据源） */
export interface ShotIndexEntry {
  shotId: string
  url: string
  title: string | null
  capturedAt: string
  pngBytes: number
}

interface ShotIndexFile {
  shots: ShotIndexEntry[]
}

function shotsDir(userDataDir: string): string {
  return join(userDataDir, EVIDENCE_DIR)
}

function shotId(): string {
  return `shot-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/** 原子写（tmp + rename——browserStore 同款） */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

export function readShotIndex(userDataDir: string): ShotIndexEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(shotsDir(userDataDir), 'index.json'), 'utf8')) as ShotIndexFile
    return Array.isArray(raw.shots) ? raw.shots : []
  } catch {
    return [] // 缺目录/缺文件 = 零证据（正常态非错误）
  }
}

/**
 * 证据落盘（browser_shot 消费）：PNG 字节校验（PNG magic）→ 写 <shotId>.png → sidecar
 * <shotId>.json → index 登记。超限 fail-visible（CAR-E-BROWSER-SHOT-MAX）。
 * textExcerpt 入口内再 redact（纵深防御——不信任调用方已脱敏；与 shot_read 读回再 redact
 * 对称，B-3 终验探针实证直传 raw 命中案）。
 */
export function appendShotEvidence(
  userDataDir: string,
  png: Buffer,
  sidecarBase: Omit<ShotSidecar, 'shotId'>,
): { shotId: string; pngPath: string; pngBytes: number } {
  sidecarBase = { ...sidecarBase, textExcerpt: redact(sidecarBase.textExcerpt ?? '').redacted }
  const existing = readShotIndex(userDataDir)
  if (existing.length >= BROWSER_SHOT_MAX) {
    throw new Error(
      `CAR-E-BROWSER-SHOT-MAX: 截图证据已达全局上限（${BROWSER_SHOT_MAX}）——fail-visible 禁静默驱逐` +
        `（证据是审计材料非缓存；设置页「清除截图证据」显式动作后可继续）`,
    )
  }
  // PNG magic 校验（CDP 返回体异常 = fail-visible，不落坏证据）
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
    throw new Error('CAR-E-BROWSER-SHOT: 截图字节非 PNG 形态（magic 校验失败——fail-visible 不落坏证据）')
  }
  const dir = shotsDir(userDataDir)
  mkdirSync(dir, { recursive: true })
  const id = shotId()
  const pngPath = join(dir, `${id}.png`)
  writeFileSync(pngPath, png)
  const sidecar: ShotSidecar = { ...sidecarBase, shotId: id }
  atomicWrite(join(dir, `${id}.json`), JSON.stringify(sidecar, null, 2))
  const index: ShotIndexFile = {
    shots: [
      ...existing,
      { shotId: id, url: sidecar.url, title: sidecar.title, capturedAt: sidecar.capturedAt, pngBytes: png.length },
    ],
  }
  atomicWrite(join(dir, 'index.json'), JSON.stringify(index, null, 2))
  return { shotId: id, pngPath, pngBytes: png.length }
}

/** 证据清除（SecurityView 显式动作——browser:clear-evidence；整目录 rm，下次截图自建） */
export function clearEvidence(userDataDir: string): void {
  rmSync(shotsDir(userDataDir), { recursive: true, force: true })
}

/**
 * B-3（D-VB3-1 / §4.8）：受管证据读取工具——**只进 visual 子面，不进父面**（主代理禁自看图
 * 复判的 toolface 级 enforcement）。无参 = index 列表；shotId = sidecar 证据（文本摘录读回时
 * 再过一次 redact——防落盘后被篡改的纵深防御，Z-7 选区同款）。v1 不回传 base64（文本内核；
 * 多模态落地后本工具翻转为图块输出——登记 future）。
 */
export function shotReadTool(userDataDir: string): HostToolDef {
  return {
    name: 'shot_read',
    declaredSideEffect: 'readonly',
    description:
      '读取浏览器截图证据（受管目录——browser_shot 产出）。无参 = 证据清单（shotId/url/时间/尺寸）；' +
      '给 shotId = 该证据的 provenance + 截图时刻冻结的文本摘录（已脱敏）+ 视口元数据。' +
      'PNG 像素本身不在本工具回传面（结构化证据档——判定按文本证据 + 判据输出逐页 JSON verdict）。',
    parameters: {
      type: 'object',
      properties: { shotId: { type: 'string', description: '证据 id（缺省 = 列清单）' } },
    },
    run: async (args) => {
      const id = typeof (args ?? {})['shotId'] === 'string' ? String(args['shotId']) : ''
      if (!id) {
        const shots = readShotIndex(userDataDir)
        return { count: shots.length, shots: shots.slice().reverse() } // 新证据在前
      }
      const index = readShotIndex(userDataDir)
      if (!index.some((s) => s.shotId === id)) {
        throw new Error(`CAR-E-EVIDENCE-SHOT: 证据不存在（${id}——shot_read 先列清单核对；fail-visible）`)
      }
      let sidecarRaw: string
      try {
        sidecarRaw = readFileSync(join(shotsDir(userDataDir), `${id}.json`), 'utf8')
      } catch {
        throw new Error(`CAR-E-EVIDENCE-SHOT: 证据 sidecar 缺失（${id}.json——index 与目录漂移，fail-visible）`)
      }
      let sc: ShotSidecar
      try {
        sc = JSON.parse(sidecarRaw) as ShotSidecar
      } catch {
        throw new Error(`CAR-E-EVIDENCE-SHOT: 证据 sidecar 坏 JSON（${id}——fail-visible）`)
      }
      let pngBytes: number | null = null
      try {
        pngBytes = statSync(join(shotsDir(userDataDir), `${id}.png`)).size
      } catch {
        pngBytes = null // PNG 缺失照实标注（sidecar 在——文本证据仍可判定）
      }
      const r = redact(sc.textExcerpt ?? '')
      return {
        shotId: sc.shotId,
        url: sc.url,
        fetchedAt: sc.fetchedAt,
        sortNote: sc.sortNote,
        missing: Array.isArray(sc.missing) ? sc.missing : [],
        title: sc.title ?? null,
        capturedAt: sc.capturedAt,
        viewport: sc.viewport ?? null,
        textExcerpt: r.redacted,
        textTruncated: sc.textTruncated === true,
        pngBytes,
        sourceNote: '页面抄录（受管证据冻结摘录——与模型生成分列，N-B1 纪律）',
      }
    },
  }
}
