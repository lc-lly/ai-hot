import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createPrisma } from '../src/db.js'
import { ingestSource, persistItems } from '../src/pipeline/ingest.js'
import type { RawItem, SourceAdapter } from '../src/sources/types.js'

let prisma: PrismaClient
let sourceId: string

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
  const source = await prisma.source.upsert({
    where: { kind_name: { kind: 'stub', name: 'ingest-test' } },
    update: {},
    create: { kind: 'stub', name: 'ingest-test', config: '{}' },
  })
  sourceId = source.id
})

beforeEach(async () => {
  await prisma.hotItem.deleteMany({ where: { sourceId } })
})

afterAll(async () => {
  await prisma.source.deleteMany({ where: { id: sourceId } })
  await prisma.$disconnect()
})

const item = (over: Partial<RawItem> = {}): RawItem => ({
  externalId: 'stub:1',
  url: 'https://example.com/a',
  title: 'A story',
  summary: null,
  author: null,
  publishedAt: null,
  lang: 'en',
  raw: {},
  ...over,
})

describe('persistItems', () => {
  it('首次写入全部落库', async () => {
    const res = await persistItems(prisma, sourceId, [
      item({ externalId: 'stub:1' }),
      item({ externalId: 'stub:2', url: 'https://example.com/b', title: 'B' }),
    ])
    // 这条没传 sourceKind，raw 又是空的 → 取不到任何互动指标 → 闸门直接放行，
    // 所以 filtered 恒为 0。真正会挡东西的路径见 pipeline/engagement.test.ts
    expect(res).toEqual({ fetched: 2, inserted: 2, skippedDuplicate: 0, invalid: 0, filtered: 0 })
    expect(await prisma.hotItem.count({ where: { sourceId } })).toBe(2)
  })

  it('同一批里重复的条目只写一次', async () => {
    const res = await persistItems(prisma, sourceId, [item({ externalId: 'stub:1' }), item({ externalId: 'stub:1' })])
    expect(res.inserted).toBe(1)
    expect(res.skippedDuplicate).toBe(1)
  })

  it('跨批次重复（同 externalId）不重复写', async () => {
    await persistItems(prisma, sourceId, [item({ externalId: 'stub:1' })])
    const res = await persistItems(prisma, sourceId, [item({ externalId: 'stub:1' })])
    expect(res.inserted).toBe(0)
    expect(res.skippedDuplicate).toBe(1)
  })

  it('externalId 不同但内容相同（追踪参数差异）也去重', async () => {
    await persistItems(prisma, sourceId, [item({ externalId: 'stub:1', url: 'https://example.com/a' })])
    const res = await persistItems(prisma, sourceId, [
      item({ externalId: 'stub:2', url: 'https://example.com/a?utm_source=rss' }),
    ])
    expect(res.inserted).toBe(0)
    expect(res.skippedDuplicate).toBe(1)
  })

  it('URL 非法的条目被计入 invalid 且不落库', async () => {
    const res = await persistItems(prisma, sourceId, [
      item({ externalId: 'stub:bad', url: 'not a url' }),
      item({ externalId: 'stub:ok' }),
    ])
    expect(res.invalid).toBe(1)
    expect(res.inserted).toBe(1)
  })

  it('写入的条目 aiState 为 pending，clusterId 为 null', async () => {
    await persistItems(prisma, sourceId, [item({ externalId: 'stub:1' })])
    const row = await prisma.hotItem.findFirstOrThrow({ where: { sourceId, externalId: 'stub:1' } })
    expect(row.aiState).toBe('pending')
    expect(row.clusterId).toBeNull()
  })

  it('publishedAt 为 null 也能写入', async () => {
    await persistItems(prisma, sourceId, [item({ externalId: 'stub:1', publishedAt: null })])
    expect(await prisma.hotItem.count({ where: { sourceId } })).toBe(1)
  })
})

describe('ingestSource', () => {
  const adapter: SourceAdapter = {
    kind: 'stub',
    fetch: async () => [item({ externalId: 'stub:1' })],
    health: async () => ({ ok: true, detail: 'stub' }),
  }

  it('调用 adapter 并把结果落库', async () => {
    const res = await ingestSource(
      prisma,
      adapter,
      { id: sourceId, kind: 'stub', config: {} },
      { fetch: globalThis.fetch, now: new Date() },
    )
    expect(res.inserted).toBe(1)
  })

  it('adapter 抛错时向上传播，由调用方记录 lastError', async () => {
    const boom: SourceAdapter = { ...adapter, fetch: async () => { throw new Error('网络炸了') } }
    await expect(
      ingestSource(prisma, boom, { id: sourceId, kind: 'stub', config: {} }, { fetch: globalThis.fetch, now: new Date() }),
    ).rejects.toThrow('网络炸了')
  })

  it('把 source.config 的 JSON 文本解析后传给 adapter', async () => {
    let received: unknown
    const spy: SourceAdapter = {
      ...adapter,
      fetch: async (ctx) => {
        received = ctx.config
        return []
      },
    }
    await ingestSource(
      prisma,
      spy,
      { id: sourceId, kind: 'stub', config: JSON.stringify({ limit: 5 }) },
      { fetch: globalThis.fetch, now: new Date() },
    )
    expect(received).toEqual({ limit: 5 })
  })

  it('config 是非法 JSON 时按空对象处理，不抛错', async () => {
    let received: unknown
    const spy: SourceAdapter = {
      ...adapter,
      fetch: async (ctx) => {
        received = ctx.config
        return []
      },
    }
    await ingestSource(
      prisma,
      spy,
      { id: sourceId, kind: 'stub', config: '{不是 json' },
      { fetch: globalThis.fetch, now: new Date() },
    )
    expect(received).toEqual({})
  })
})
