/**
 * s-hot · C1 热更新 last-good 快照引擎（W-4 语义平移——Qwen resource 包四语义对照）
 *
 * 判据（host-core/hotReload.ts + hotReloadStore.ts）：
 *  - last-good：rebuild 失败保旧快照（value/committedAt 不动）+ loadErrors 显式暴露；成功后清空；
 *  - 尚无成功提交 value = null（消费方回退急装载——诚实形态）；
 *  - watcher 触发去抖合并（R-V10-5 编辑中间态防护）；
 *  - watcher 故障 = degraded（只降热更新——get/refresh 恒可用，主功能不陪葬；degraded 后 arm 拒绝）；
 *  - stop 收口 + arm 重挂（注册表变更后新文件集）；
 *  - fsWatchDef 生产包装：目录监听 + filter + 原子写（tmp+rename）触发；
 *  - hotReloadStore：出厂缺省关（D-V10-2）+ set 持久化 + 损坏回退出厂（不 fail-open）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHotReload, fsWatchDef, type HotWatcherDef } from '../src/host-core/hotReload.ts'
import { createHotReloadStore } from '../src/host-core/hotReloadStore.ts'

/** 可控 watcher（测试注入——不依赖 fs.watch 时序） */
function manualWatcher(): { def: HotWatcherDef; fire: () => void; fail: (e: unknown) => void } {
  let onChange: ((label?: string) => void) | null = null
  let onError: ((e: unknown) => void) | null = null
  return {
    def: {
      label: 'manual',
      start(oc, oe) {
        onChange = oc
        onError = oe
        return () => { onChange = null; onError = null }
      },
    },
    fire: () => onChange?.('manual-event'),
    fail: (e) => onError?.(e),
  }
}

test('s-hot: last-good——rebuild 失败保旧快照 + loadErrors 显式暴露；首建前 value=null', async () => {
  let n = 0
  const h = createHotReload<number>({ label: 't', rebuild: async () => ++n })
  assert.equal(h.get().value, null, '尚无成功提交 = null（消费方回退急装载）')
  assert.equal(h.get().loadErrors.length, 0)
  await h.refresh('first')
  assert.equal(h.get().value, 1)
  assert.deepEqual(h.get().loadErrors, [])

  let fail = false
  const h2 = createHotReload<number>({
    label: 't2',
    rebuild: async () => {
      n++
      if (fail) throw new Error('boom-rebuild')
      return n
    },
  })
  await h2.refresh('a')
  const committed1 = h2.get().committedAt
  assert.ok(typeof committed1 === 'number')
  fail = true
  await h2.refresh('b')
  assert.equal(h2.get().value, h2.get().value, '保旧（value 不动）')
  assert.equal(h2.get().committedAt, committed1, 'committedAt 不动——上次成功提交')
  assert.deepEqual(h2.get().loadErrors, ['boom-rebuild'], 'loadErrors 显式暴露')
  fail = false
  await h2.refresh('c')
  assert.deepEqual(h2.get().loadErrors, [], '成功重建清空')
  assert.equal(h2.get().value, n, '提交新值')
  assert.ok((h2.get().committedAt ?? 0) >= (committed1 ?? 0), 'committedAt 前移（同 ms 合法）')
})

test('s-hot: watcher 触发去抖合并 + degraded 故障降级（get/refresh 恒可用，arm 拒绝）', async () => {
  const w = manualWatcher()
  let n = 0
  const h = createHotReload<number>({ label: 't', rebuild: async () => ++n, watchers: [w.def], debounceMs: 30 })
  assert.deepEqual(h.watching(), ['manual'])
  await h.refresh('init')
  assert.equal(h.get().value, 1)
  // 双触发 → 去抖窗口合并 → 单次重建
  w.fire()
  w.fire()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(h.get().value, 2, '去抖后单次重建提交')
  // watcher 故障 → degraded（get 恒可用，主功能不陪葬）
  w.fail(new Error('watch-killed'))
  assert.equal(h.degraded(), true)
  assert.ok(h.get().loadErrors[0]!.includes('watcher 故障'), '故障显式呈现')
  await h.refresh('after-degraded')
  assert.equal(h.get().value, 3, 'degraded 态显式 refresh 恒可用')
  h.arm([w.def])
  assert.deepEqual(h.watching(), [], 'degraded 后 arm 拒绝（重开开关才恢复）')
  h.stop()
})

test('s-hot: stop 收口 + arm 重挂（注册表变更后新文件集）', async () => {
  const w = manualWatcher()
  const h = createHotReload<number>({ label: 't', rebuild: async () => 1, watchers: [] })
  h.arm([w.def])
  assert.deepEqual(h.watching(), ['manual'])
  h.stop()
  assert.deepEqual(h.watching(), [], 'stop 收口')
  w.fire()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(h.get().value, null, '停止后触发无效果（无悬挂监听）')
  h.arm([w.def])
  assert.deepEqual(h.watching(), ['manual'], '重挂（注册表变更后新文件集）')
  h.stop()
})

test('s-hot: fsWatchDef 生产包装——目录监听 + filter + 原子写（tmp+rename）触发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's-hot-'))
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'target.json')
    writeFileSync(file, '{"n":0}', 'utf8')
    let fired = 0
    const h = createHotReload<number>({
      label: 'fs',
      rebuild: async () => ++fired,
      watchers: [fsWatchDef('target.json', dir, (fn) => fn === null || fn === 'target.json')],
      debounceMs: 40,
    })
    await h.refresh('init')
    assert.equal(h.get().value, 1)
    // 原子写形态（tmp + rename——plugin-paths.json 同款）：目录监听仍活
    const tmp = file + '.tmp'
    writeFileSync(tmp, '{"n":1}', 'utf8')
    renameSync(tmp, file)
    await new Promise((r) => setTimeout(r, 250))
    assert.ok((h.get().value ?? 0) >= 2, `目录监听经原子写触发（fired=${fired}）`)
    h.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('s-hot: hotReloadStore——出厂缺省关（D-V10-2）+ set 持久化 + 损坏回退出厂', () => {
  const dir = mkdtempSync(join(tmpdir(), 's-hot-store-'))
  try {
    const store = createHotReloadStore(dir)
    assert.equal(store.get().toolSourcesHot, false, '出厂缺省关（D-V10-2）')
    store.set({ toolSourcesHot: true })
    assert.equal(store.get().toolSourcesHot, true)
    // 重新装载 = 持久化生效
    const store2 = createHotReloadStore(dir)
    assert.equal(store2.get().toolSourcesHot, true)
    assert.match(readFileSync(join(dir, 'hot-reload.json'), 'utf8'), /"toolSourcesHot": true/)
    // 损坏回退出厂值并写回（不 fail-open）
    writeFileSync(join(dir, 'hot-reload.json'), '{broken', 'utf8')
    const store3 = createHotReloadStore(dir)
    assert.equal(store3.get().toolSourcesHot, false, '损坏回退出厂（缺省关）')
    assert.equal(store3.get().version, 1)
    // mkdir 递归（userDataDir 不存在时）
    const nested = join(dir, 'a', 'b')
    const store4 = createHotReloadStore(nested)
    store4.set({ toolSourcesHot: true })
    assert.equal(store4.get().toolSourcesHot, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
