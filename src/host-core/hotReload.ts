/**
 * C1 · 热更新 last-good 快照引擎（W-4 语义平移——Qwen resource 包四语义对照）
 *
 * 口径（Qwen resource 包 §2.4 → CAR 平移）：
 *  - **last-good 快照**：每次 rebuild 构造完整新快照后一次性提交；**重建失败保留上一份
 *    完整快照**（value 不动，loadErrors 显式暴露，可重试）——fail-visible 语义；
 *    尚无任何成功提交时 value = null（消费方回退急装载路径——「无 last-good 可保」诚实形态）；
 *  - **能力可降级**：watcher 故障 = degraded（只降热更新、主功能不陪葬）——get()/refresh()
 *    恒可用；degraded 后不再武装（重开开关才恢复）；
 *  - **监听复用**：同一路径单份物理监听（defs 由调用方构建传入，引擎只管编排与重挂）；
 *  - **一次性提交**：rebuild 成功 = 整快照原子换入（无半新半旧中间态）；
 *  - **去抖**：变更触发 200ms 去抖（编辑中间态防护，R-V10-5）；窗口内多触发合并。
 *
 * 纯编排层：watcher 全注入（生产 = fsWatchDef 包装；测试注入可控触发），零 electron 依赖，
 * node:test 可测（skill-import.ts 同款分层纪律；node:fs 仅 fsWatchDef 直用——host-core 仅
 * Node 宿主消费，同 toolSources.ts 先例）。
 */
import { watch, type FSWatcher } from 'node:fs'

export interface HotSnapshot<T> {
  /** last-good 快照值（null = 尚无成功提交——消费方回退急装载） */
  value: T | null
  /** 最近成功提交时间（value 为 null 时 undefined） */
  committedAt: number | undefined
  /** 最近一次失败原因（成功重建后清空；watcher 故障亦落此处）——显式暴露，禁静默吞 */
  loadErrors: string[]
}

export interface HotWatcherDef {
  /** 监听对象描述（呈现/诊断用） */
  label: string
  /**
   * 启动物理监听：onChange(reasonLabel?) = 去抖后的重建触发；onError = watcher 不可恢复
   * 故障（引擎标记 degraded 并停全部监听——只降热更新）。返回停止函数。
   */
  start(onChange: (reasonLabel?: string) => void, onError: (e: unknown) => void): () => void
}

export interface HotReloadHandle<T> {
  /** last-good 快照（恒可用——watcher 降级不影响读取） */
  get(): HotSnapshot<T>
  /** 显式重建（watcher 事件去抖后亦走此路径）；失败保 last-good */
  refresh(reason: string): Promise<void>
  /** 重挂监听（注册表变更后按新文件集重挂——stop + arm 新 defs；degraded 态拒绝） */
  arm(defs: readonly HotWatcherDef[]): void
  /** watcher 故障降级态（true = 热更新已停，主功能不受影响） */
  degraded(): boolean
  /** 当前监听对象标签（诊断呈现） */
  watching(): string[]
  /** 停全部监听（宿主退出/开关关闭） */
  stop(): void
}

export interface HotReloadOptions<T> {
  label: string
  /** 完整重建（一次性提交——禁增量修补） */
  rebuild: () => Promise<T>
  /** 物理监听定义（缺省空 = 纯显式 refresh 形态；arm 可后置武装） */
  watchers?: HotWatcherDef[]
  /** 变更去抖（缺省 200ms——R-V10-5） */
  debounceMs?: number
}

export function createHotReload<T>(opts: HotReloadOptions<T>): HotReloadHandle<T> {
  const debounceMs = opts.debounceMs ?? 200
  let value: T | null = null
  let committedAt: number | undefined
  let loadErrors: string[] = []
  let stops: Array<() => void> = []
  let watching: string[] = []
  let degraded = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingReason: string | null = null
  // 重建互斥：去抖触发与显式 refresh 并发时后到合并（防双提交乱序）
  let inFlight = false
  let queuedReason: string | null = null

  const stopWatchers = (): void => {
    for (const s of stops) {
      try { s() } catch { /* 停止容错 */ }
    }
    stops = []
    watching = []
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pendingReason = null
  }

  const refresh = async (reason: string): Promise<void> => {
    if (inFlight) {
      queuedReason = reason // 合并到在途重建之后
      return
    }
    inFlight = true
    try {
      const next = await opts.rebuild()
      // 一次性提交：整快照原子换入
      value = next
      committedAt = Date.now()
      loadErrors = []
    } catch (err) {
      // last-good：失败保旧快照（value/committedAt 不动），错误显式暴露
      loadErrors = [err instanceof Error ? err.message : String(err)]
    } finally {
      inFlight = false
      if (queuedReason !== null) {
        const r = queuedReason
        queuedReason = null
        void refresh(r)
      }
    }
  }

  const handle: HotReloadHandle<T> = {
    get: () => ({ value, committedAt, loadErrors }),
    refresh,
    arm(defs: readonly HotWatcherDef[]): void {
      stopWatchers()
      if (degraded) return // 降级态拒绝重武装（重开开关才恢复）
      for (const def of defs) {
        const stop = def.start(
          (reasonLabel) => {
            if (degraded) return
            pendingReason = reasonLabel ?? def.label
            if (timer !== null) clearTimeout(timer)
            timer = setTimeout(() => {
              timer = null
              const reason = pendingReason ?? def.label
              pendingReason = null
              void refresh(reason)
            }, debounceMs)
          },
          (e) => {
            // watcher 故障 = 只降热更新：停全部监听 + 标记降级（get/refresh 恒可用）
            degraded = true
            stopWatchers()
            loadErrors = [...loadErrors, `watcher 故障（${def.label}）：${e instanceof Error ? e.message : String(e)}——热更新已降级，主功能不受影响`]
          },
        )
        stops.push(stop)
        watching.push(def.label)
      }
    },
    degraded: () => degraded,
    watching: () => [...watching],
    stop: () => {
      stopWatchers()
    },
  }

  if (opts.watchers?.length) handle.arm(opts.watchers)
  return handle
}

/** 生产 watcher 定义：fs.watch 目录/文件（Windows 兼容面——原子写 rename 后目录监听仍活，
 *  文件监听遇 rename-over 可能失效 → onError → degraded 降级路径承接） */
export function fsWatchDef(label: string, target: string, filter?: (filename: string | null) => boolean): HotWatcherDef {
  return {
    label,
    start(onChange, onError) {
      let watcher: FSWatcher | null = null
      try {
        watcher = watch(target, (eventType, filename) => {
          if (filter && !filter(filename)) return
          onChange(`${eventType}:${filename ?? label}`)
        })
        watcher.on('error', (e) => onError(e))
      } catch (e) {
        onError(e)
      }
      return () => {
        try { watcher?.close() } catch { /* 停止容错 */ }
        watcher = null
      }
    },
  }
}
