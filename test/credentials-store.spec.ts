/**
 * K6-ME · 多端点存储纯决策层行为测试（credentials-store——零 electron 依赖）
 *
 * 判据：三代档归一（v2/v1 迁移/cleared 墓碑/坏档）、save 即激活（更新沿用槽位 Key 语义在
 * credentials.ts 的 Key 决策——本文件覆盖槽定位/激活/删除迁移/切换的纯决策）、
 * 删 active 时 activeId 迁移到剩余第一项、fail-visible（槽不存在禁静默）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activateInStore,
  normModels,
  parseStoreFile,
  removeFromStore,
  toMeta,
  upsertEndpoint,
  type EndpointWithKey,
  type StoreFile,
} from '../src/main/credentials-store.ts'

const K = (n: string) => `enc:${n}`

function ep(id: string, baseUrl: string, models: string[], keyEncrypted = K(id)): StoreFile['endpoints'][number] {
  return { id, baseUrl, adapterId: 'openai-compat', models: models.map((m) => ({ id: m, contextWindow: null })), keyEncrypted }
}

const withId = (ep0: Omit<EndpointWithKey, 'models'>, models: Array<{ id: string; contextWindow?: number | null }>): EndpointWithKey => ({ ...ep0, models })

test('v1 单对象档 → 惰性迁移为单端点列表（activeId 指向该槽）', () => {
  const v1 = { baseUrl: 'https://a.example.com', adapterId: 'anthropic', model: 'old-model', contextWindow: 32000, keyEncrypted: K('legacy') }
  const store = parseStoreFile(v1)
  assert.equal(store.version, 2)
  assert.equal(store.endpoints.length, 1)
  assert.equal(store.endpoints[0].baseUrl, 'https://a.example.com')
  assert.equal(store.endpoints[0].adapterId, 'anthropic')
  assert.deepEqual(store.endpoints[0].models, [{ id: 'old-model', contextWindow: 32000 }])
  assert.equal(store.activeId, store.endpoints[0].id)
})

test('cleared 墓碑 / 损坏 JSON（null）→ 空列表', () => {
  assert.deepEqual(parseStoreFile({ cleared: true }), { version: 2, endpoints: [], activeId: null })
  assert.deepEqual(parseStoreFile(null), { version: 2, endpoints: [], activeId: null })
  assert.deepEqual(parseStoreFile('garbage'), { version: 2, endpoints: [], activeId: null })
})

test('v2 档：activeId 失效 → 兜底第一项；坏槽（缺 models/key）被弃', () => {
  const good = ep('e1', 'https://a.example.com', ['m1'])
  const store = parseStoreFile({
    version: 2,
    endpoints: [good, { id: 'e2', baseUrl: 'https://b.example.com', keyEncrypted: K('e2') } /* 缺 models → 弃 */],
    activeId: 'e-gone' /* 失效 → 兜底 */,
  })
  assert.equal(store.endpoints.length, 1)
  assert.equal(store.activeId, 'e1')
})

test('normModels：去空去重保序 + legacy 单模型键折叠', () => {
  const out = normModels(['m1', '', { id: 'm2', contextWindow: 8000 }, 'm1', { id: '  ' }], 'm3', 4000)
  assert.deepEqual(out, [
    { id: 'm1', contextWindow: null },
    { id: 'm2', contextWindow: 8000 },
    { id: 'm3', contextWindow: 4000 },
  ])
})

test('save 新增槽（无 endpointId）→ 追加 + save 即激活', () => {
  const store: StoreFile = { version: 2, endpoints: [ep('e1', 'https://a.example.com', ['m1'])], activeId: 'e1' }
  const { store: next, saved } = upsertEndpoint(store, withId({ baseUrl: 'https://b.example.com', adapterId: 'openai-compat' }, [{ id: 'm2' }]), K('new'))
  assert.equal(next.endpoints.length, 2)
  assert.equal(next.activeId, saved.id)
  assert.equal(saved.baseUrl, 'https://b.example.com')
  assert.equal(next.endpoints[0].id, 'e1') // 旧槽不动
})

test('save 更新槽（endpointId 命中）→ 原位替换 + activeId 指向它', () => {
  const store: StoreFile = { version: 2, endpoints: [ep('e1', 'https://a.example.com', ['m1']), ep('e2', 'https://b.example.com', ['m2'])], activeId: 'e1' }
  const { store: next, saved } = upsertEndpoint(store, withId({ endpointId: 'e2', baseUrl: 'https://b2.example.com', adapterId: 'anthropic' }, [{ id: 'm2b' }]), K('fresh'))
  assert.equal(next.endpoints.length, 2)
  assert.equal(next.activeId, 'e2')
  assert.equal(saved.baseUrl, 'https://b2.example.com')
  assert.equal(next.endpoints[1].keyEncrypted, K('fresh'))
  assert.equal(next.endpoints[0].id, 'e1') // e1 不受影响
})

test('save 更新不存在的槽 → fail-visible（禁静默新增）', () => {
  const store: StoreFile = { version: 2, endpoints: [ep('e1', 'https://a.example.com', ['m1'])], activeId: 'e1' }
  assert.throws(() => upsertEndpoint(store, withId({ endpointId: 'e-gone', baseUrl: 'https://x', adapterId: 'openai-compat' }, [{ id: 'm' }]), K('k')), /端点槽不存在/)
})

test('save 新增同 baseUrl + 同适配器槽 → fail-visible（引导编辑，禁重复槽堆积）', () => {
  const store: StoreFile = { version: 2, endpoints: [ep('e1', 'https://a.example.com', ['m1'])], activeId: 'e1' }
  assert.throws(() => upsertEndpoint(store, withId({ baseUrl: 'https://a.example.com', adapterId: 'openai-compat' }, [{ id: 'm9' }]), K('k')), /已存在端点/)
  // 同 URL 不同适配器 = 不同网关语义（OpenAI 兼容 vs Anthropic）→ 允许并存
  const { store: next } = upsertEndpoint(store, withId({ baseUrl: 'https://a.example.com', adapterId: 'anthropic' }, [{ id: 'm9' }]), K('k'))
  assert.equal(next.endpoints.length, 2)
  // 编辑自身（同槽同 URL）→ 不触发防呆
  const { store: next2 } = upsertEndpoint(store, withId({ endpointId: 'e1', baseUrl: 'https://a.example.com', adapterId: 'openai-compat' }, [{ id: 'm1b' }]), K('k2'))
  assert.equal(next2.endpoints.length, 1)
})

test('remove active → activeId 迁移剩余第一项；remove 最后一个 → activeId null', () => {
  const two: StoreFile = { version: 2, endpoints: [ep('e1', 'https://a', ['m1']), ep('e2', 'https://b', ['m2'])], activeId: 'e1' }
  const r1 = removeFromStore(two, 'e1')
  assert.equal(r1.removed, true)
  assert.equal(r1.store.activeId, 'e2')
  const r2 = removeFromStore(r1.store, 'e2')
  assert.equal(r2.removed, true)
  assert.equal(r2.store.activeId, null)
  assert.equal(r2.store.endpoints.length, 0)
})

test('remove 非 active → activeId 不变；remove 不存在 id → removed=false（零写盘依据）', () => {
  const two: StoreFile = { version: 2, endpoints: [ep('e1', 'https://a', ['m1']), ep('e2', 'https://b', ['m2'])], activeId: 'e2' }
  const r2 = removeFromStore(two, 'e1')
  assert.equal(r2.removed, true)
  assert.equal(r2.store.activeId, 'e2')
  const r3 = removeFromStore(two, 'e-gone')
  assert.equal(r3.removed, false)
  assert.equal(r3.store, two) // 同引用 = 无变化（调用方据此跳过写盘）
})

test('activate 切换 → activeId 跟随 + 返回该槽 meta（无 keyEncrypted 泄漏）；切不存在 → throw', () => {
  const two: StoreFile = { version: 2, endpoints: [ep('e1', 'https://a', ['m1']), ep('e2', 'https://b', ['m2'])], activeId: 'e1' }
  const { store, active } = activateInStore(two, 'e2')
  assert.equal(store.activeId, 'e2')
  const meta = toMeta(active)
  assert.equal(meta.baseUrl, 'https://b')
  assert.equal(!('keyEncrypted' in meta), true, 'meta 面禁携带 keyEncrypted')
  assert.throws(() => activateInStore(two, 'e-gone'), /端点槽不存在/)
})
