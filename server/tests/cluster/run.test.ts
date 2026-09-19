import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { runCluster } from '../../src/cluster/run.js'
import { createPrisma } from '../../src/db.js'

/**
 * 聚类的落库测试。
 *
 * 用 `itemIds` 把范围钉死在自己造的数据上 —— `runCluster` 默认会捞**全库**
 * 未聚类条目，而测试库在同一个文件里被所有测试共用，
 * 不限定范围的话别的测试文件留下的条目会混进来。
 */

const PREFIX = 'ZZCLUSTERRUN'

let prisma: PrismaClient
let sourceA: string
let sourceB: string

const NOW = new Date('2026-09-15T12:00:00Z')

async function cleanup(): Promise<void> {
  await prisma.hotItem.deleteMany({ where: { title: { startsWith: PREFIX } } })
  await prisma.cluster.deleteMany({ where: { title: { startsWith: PREFIX } } })
  await prisma.source.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
  await cleanup()
  const a = await prisma.source.create({ data: { kind: 'hackernews', name: `${PREFIX}-a` } })
  const b = await prisma.source.create({ data: { kind: 'reddit', name: `${PREFIX}-b` } })
  sourceA = a.id
  sourceB = b.id
})

beforeEach(async () => {
  await cleanup()
  const a = await prisma.source.create({ data: { kind: 'hackernews', name: `${PREFIX}-a`, id: sourceA } })
  const b = await prisma.source.create({ data: { kind: 'reddit', name: `${PREFIX}-b`, id: sourceB } })
  sourceA = a.id
  sourceB = b.id
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

let seq = 0

async function makeItem(
  sourceId: string,
  title: string,
  url: string,
  options: { fetchedAt?: Date; raw?: unknown } = {},
): Promise<string> {
  seq += 1
  const row = await prisma.hotItem.create({
    data: {
      sourceId,
      externalId: `${PREFIX}-${seq}`,
      title,
      url,
      summary: null,
      author: null,
      lang: 'en',
      publishedAt: options.fetchedAt ?? NOW,
      fetchedAt: options.fetchedAt ?? NOW,
      contentHash: `${PREFIX}-hash-${seq}`,
      raw: JSON.stringify(options.raw ?? {}),
    },
  })
  return row.id
}

async function myItemIds(): Promise<string[]> {
  const rows = await prisma.hotItem.findMany({
    where: { title: { startsWith: PREFIX } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

describe('runCluster', () => {
  it('把同一事件的两个来源条目聚成一个簇并写回 clusterId', async () => {
    const i1 = await makeItem(sourceA, `${PREFIX} OpenAI ships Turbo model`, 'https://techcrunch.com/a', {
      raw: { score: 300 },
    })
    const i2 = await makeItem(sourceB, `${PREFIX} OpenAI ships Turbo model`, 'https://theverge.com/b', {
      raw: { score: 600 },
    })

    const result = await runCluster(prisma, { now: NOW, itemIds: await myItemIds() })

    expect(result.considered).toBe(2)
    expect(result.assigned).toBe(2)
    expect(result.createdClusters).toBe(1)
    expect(result.updatedClusters).toBe(0)
    expect(result.errors).toEqual([])

    const clusterId = result.changes[0]?.clusterId
    expect(clusterId).toBeTruthy()

    const rows = await prisma.hotItem.findMany({ where: { id: { in: [i1, i2] } } })
    expect(rows.every((r) => r.clusterId === clusterId)).toBe(true)

    const cluster = await prisma.cluster.findUniqueOrThrow({ where: { id: clusterId as string } })
    expect(cluster.itemCount).toBe(2)
    expect(cluster.sourceCount).toBe(2)
    // hn 300/500 = 0.6、reddit 600/1000 = 0.6 → 峰值 0.6，再加一个额外来源 +0.1
    expect(cluster.heatScore).toBeCloseTo(0.7, 5)
    expect(cluster.firstSeenAt.getTime()).toBe(NOW.getTime())
    expect(cluster.lastSeenAt.getTime()).toBe(NOW.getTime())
  })

  it('不同事件的条目各自成簇', async () => {
    await makeItem(sourceA, `${PREFIX} OpenAI ships Turbo model`, 'https://techcrunch.com/a')
    await makeItem(sourceA, `${PREFIX} Pizza restaurant opens downtown`, 'https://food.example.com/b')

    const result = await runCluster(prisma, { now: NOW, itemIds: await myItemIds() })

    expect(result.createdClusters).toBe(2)
    expect(result.assigned).toBe(2)
  })

  it('第二轮的新条目并入已有簇：不新建、计数递增、firstSeenAt 不前移', async () => {
    await makeItem(sourceA, `${PREFIX} OpenAI ships Turbo model`, 'https://techcrunch.com/a', {
      fetchedAt: new Date('2026-09-15T10:00:00Z'),
    })
    const first = await runCluster(prisma, { now: NOW, itemIds: await myItemIds() })
    const clusterId = first.changes[0]?.clusterId as string

    const later = new Date('2026-09-15T14:00:00Z')
    await makeItem(sourceB, `${PREFIX} OpenAI ships Turbo model`, 'https://theverge.com/c', { fetchedAt: later })

    const second = await runCluster(prisma, { now: later, itemIds: await myItemIds() })

    expect(second.createdClusters).toBe(0)
    expect(second.updatedClusters).toBe(1)
    expect(second.changes[0]?.clusterId).toBe(clusterId)
    expect(second.changes[0]?.added).toBe(1)

    const cluster = await prisma.cluster.findUniqueOrThrow({ where: { id: clusterId } })
    expect(cluster.itemCount).toBe(2)
    expect(cluster.sourceCount).toBe(2)
    expect(cluster.firstSeenAt.toISOString()).toBe('2026-09-15T10:00:00.000Z')
    expect(cluster.lastSeenAt.toISOString()).toBe(later.toISOString())
  })

  it('已经聚过类的条目不会被重复处理（幂等）', async () => {
    await makeItem(sourceA, `${PREFIX} OpenAI ships Turbo model`, 'https://techcrunch.com/a')
    await runCluster(prisma, { now: NOW, itemIds: await myItemIds() })
    const before = await prisma.cluster.count({ where: { title: { startsWith: PREFIX } } })

    // 同一批条目再跑一次：它们已经有 clusterId，连载入都不该载入
    const again = await runCluster(prisma, { now: NOW, itemIds: await myItemIds() })

    expect(again.considered).toBe(0)
    expect(again.assigned).toBe(0)
    expect(await prisma.cluster.count({ where: { title: { startsWith: PREFIX } } })).toBe(before)
  })

  it('簇的 title 用代表条目的原始标题', async () => {
    await makeItem(sourceA, `${PREFIX} OpenAI ships Turbo model`, 'https://techcrunch.com/a')
    const result = await runCluster(prisma, { now: NOW, itemIds: await myItemIds() })

    const cluster = await prisma.cluster.findUniqueOrThrow({
      where: { id: result.changes[0]?.clusterId as string },
    })
    expect(cluster.title).toBe(`${PREFIX} OpenAI ships Turbo model`)
  })
})
