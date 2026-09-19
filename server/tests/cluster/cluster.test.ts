import { describe, expect, it } from 'vitest'
import {
  clusterItems,
  DEFAULT_TITLE_THRESHOLD,
  type ClusterItem,
  type ExistingCluster,
} from '../../src/cluster/index.js'

/**
 * 纯函数聚类的单测：不碰数据库、不看时钟（时间只从条目字段上读）。
 *
 * 三条测试标题的 Dice 是手算好的，改动分词 / 阈值实现时这些数字会立刻变红：
 * `A = OpenAI ships Turbo model to developers` → 5 个 token
 * `B = OpenAI ships Turbo for enterprise pricing` → 5 个 token（for 是停用词）
 * 交集 {openai, ships, turbo} = 3 → Dice = 2*3/10 = 0.6
 * 落在 [sameDomainThreshold=0.45, titleThreshold=0.62) 之间 —— 正是
 * 「同域才合并」那条规则的分界带。
 */
const A_TITLE = 'OpenAI ships Turbo model to developers'
const B_TITLE = 'OpenAI ships Turbo for enterprise pricing'
const SAME_DOMAIN = 'https://techcrunch.com/x'
const SAME_DOMAIN_2 = 'https://techcrunch.com/y'
const OTHER_DOMAIN = 'https://theverge.com/z'

const t0 = new Date('2026-09-15T00:00:00Z')
const t1 = new Date('2026-09-15T01:00:00Z')
const t2 = new Date('2026-09-15T02:00:00Z')

function item(over: Partial<ClusterItem> & { id: string; title: string; url: string }): ClusterItem {
  return {
    sourceId: 'src-1',
    publishedAt: t0,
    fetchedAt: t0,
    heat: 0,
    ...over,
  }
}

describe('clusterItems', () => {
  it('标题完全相同的跨来源条目合并成一个簇', () => {
    const groups = clusterItems([
      item({ id: 'i1', title: 'OpenAI ships Turbo', url: SAME_DOMAIN, sourceId: 's1' }),
      item({ id: 'i2', title: 'OpenAI ships Turbo', url: OTHER_DOMAIN, sourceId: 's2' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.itemIds).toEqual(['i1', 'i2'])
    expect(groups[0]?.sourceIds).toEqual(['s1', 's2'])
  })

  it('不同事件不合并', () => {
    const groups = clusterItems([
      item({ id: 'i1', title: 'OpenAI ships Turbo', url: SAME_DOMAIN }),
      item({ id: 'i2', title: 'Pizza restaurant opens downtown', url: OTHER_DOMAIN }),
    ])

    expect(groups).toHaveLength(2)
  })

  it('相似度落在 0.45–0.62 之间时：同域合并', () => {
    const groups = clusterItems([
      item({ id: 'i1', title: A_TITLE, url: SAME_DOMAIN }),
      item({ id: 'i2', title: B_TITLE, url: SAME_DOMAIN_2 }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.itemIds).toEqual(['i1', 'i2'])
  })

  it('同样的相似度但不同域：不合并（避免把两家媒体的不同事件缝在一起）', () => {
    const groups = clusterItems([
      item({ id: 'i1', title: A_TITLE, url: SAME_DOMAIN }),
      item({ id: 'i2', title: B_TITLE, url: OTHER_DOMAIN }),
    ])

    expect(groups).toHaveLength(2)
  })

  it('归一化 URL 相同即合并，标题完全不同也算', () => {
    const groups = clusterItems([
      item({ id: 'i1', title: 'OpenAI ships Turbo', url: 'https://example.com/post/' }),
      item({ id: 'i2', title: 'A totally unrelated headline', url: 'https://www.example.com/post#top' }),
    ])

    expect(groups).toHaveLength(1)
  })

  it('确定性：打乱输入顺序结果不变', () => {
    const items = [
      item({ id: 'i3', title: 'Gemini 发布新版本', url: 'https://a.example.com/1', sourceId: 's1' }),
      item({ id: 'i1', title: 'OpenAI ships Turbo', url: SAME_DOMAIN, sourceId: 's2' }),
      item({ id: 'i4', title: 'Gemini 发布新版本', url: 'https://b.example.com/2', sourceId: 's3' }),
      item({ id: 'i2', title: 'OpenAI ships Turbo', url: OTHER_DOMAIN, sourceId: 's4' }),
    ]

    const shape = (list: readonly ClusterItem[]): string =>
      JSON.stringify(
        clusterItems(list)
          .map((g) => g.itemIds)
          .sort(),
      )

    expect(shape([...items].reverse())).toBe(shape(items))
    expect(shape([items[2] as ClusterItem, items[0] as ClusterItem, items[3] as ClusterItem, items[1] as ClusterItem])).toBe(
      shape(items),
    )
  })

  it('代表标题取「发布时间最早」的那条，firstSeenAt / lastSeenAt 用抓取时间', () => {
    const groups = clusterItems([
      item({ id: 'i1', title: 'OpenAI ships Turbo', url: SAME_DOMAIN, publishedAt: t2, fetchedAt: t1 }),
      item({ id: 'i2', title: 'OpenAI ships Turbo', url: OTHER_DOMAIN, publishedAt: t0, fetchedAt: t2 }),
    ])

    const group = groups[0]
    expect(group?.title).toBe('OpenAI ships Turbo')
    // 两条标题相同，代表标题一样；但时间范围必须来自 fetchedAt
    expect(group?.firstSeenAt.toISOString()).toBe(t1.toISOString())
    expect(group?.lastSeenAt.toISOString()).toBe(t2.toISOString())
  })

  it('heatScore = 组内最高热度 + 每个额外来源 0.1，封顶 1', () => {
    const one = clusterItems([item({ id: 'i1', title: 'Solo event', url: SAME_DOMAIN, heat: 0.5 })])
    expect(one[0]?.heatScore).toBe(0.5)

    const two = clusterItems([
      item({ id: 'i1', title: 'Shared event', url: SAME_DOMAIN, sourceId: 's1', heat: 0.5 }),
      item({ id: 'i2', title: 'Shared event', url: OTHER_DOMAIN, sourceId: 's2', heat: 0.2 }),
    ])
    expect(two[0]?.heatScore).toBeCloseTo(0.6, 5)

    const capped = clusterItems([
      item({ id: 'i1', title: 'Huge event', url: SAME_DOMAIN, sourceId: 's1', heat: 0.95 }),
      item({ id: 'i2', title: 'Huge event', url: OTHER_DOMAIN, sourceId: 's2', heat: 0.95 }),
    ])
    expect(capped[0]?.heatScore).toBe(1)
  })

  it('历史簇：新条目并入已有簇，clusterId 保留且 newItemIds 只含新条目', () => {
    const existing: ExistingCluster = {
      clusterId: 'cluster-old',
      firstSeenAt: t0,
      items: [item({ id: 'old-1', title: 'OpenAI ships Turbo', url: SAME_DOMAIN, sourceId: 's1', fetchedAt: t0 })],
    }

    const groups = clusterItems(
      [item({ id: 'new-1', title: 'OpenAI ships Turbo', url: OTHER_DOMAIN, sourceId: 's2', fetchedAt: t2 })],
      { existing: [existing] },
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]?.clusterId).toBe('cluster-old')
    expect(groups[0]?.newItemIds).toEqual(['new-1'])
    expect(groups[0]?.itemIds).toEqual(['new-1', 'old-1'])
    expect(groups[0]?.sourceIds).toEqual(['s1', 's2'])
    // firstSeenAt 不能因为重建而晚于历史值
    expect(groups[0]?.firstSeenAt.toISOString()).toBe(t0.toISOString())
  })

  it('同分时并按先注册的簇（下标小的胜出），结果可复现', () => {
    const existing: ExistingCluster[] = [
      { clusterId: 'cluster-b', items: [item({ id: 'b1', title: 'OpenAI ships Turbo', url: SAME_DOMAIN })], firstSeenAt: t0 },
    ]

    const groups = clusterItems(
      [
        item({ id: 'seed-1', title: 'OpenAI ships Turbo', url: SAME_DOMAIN }),
        item({ id: 'new-1', title: 'OpenAI ships Turbo', url: OTHER_DOMAIN }),
      ],
      { existing },
    )

    // 排序后 'new-1' 先于 'seed-1'（标题相同，按 id 排），两者都该进 cluster-b
    const target = groups.find((g) => g.clusterId === 'cluster-b')
    expect(target?.newItemIds).toEqual(['new-1', 'seed-1'])
  })

  it('maxGroupSize 阻止泛化标题无限吸收', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item({ id: `i${i}`, title: 'Daily AI roundup', url: `https://a.example.com/${i}` }),
    )

    const groups = clusterItems(items, { maxGroupSize: 2 })
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.every((g) => g.itemIds.length <= 2)).toBe(true)
    // 一条都不能丢
    expect(groups.flatMap((g) => g.itemIds)).toHaveLength(5)
  })

  it('空输入返回空', () => {
    expect(clusterItems([])).toEqual([])
  })

  it('默认阈值就是导出常量', () => {
    expect(DEFAULT_TITLE_THRESHOLD).toBe(0.62)
  })
})
