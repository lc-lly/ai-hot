import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createPrisma } from '../src/db.js'
import { itemRoutes } from '../src/routes/items.js'
import { HEAT_FALLBACK } from '../src/score/heat.js'

/**
 * `GET /api/items` 的契约测试。
 *
 * 响应信封 `{ data, pagination }` 是**冻结**的：前端整个 data-fetching 层
 * 按它写。改这里必须先改前端。
 */

let prisma: PrismaClient
let hnSourceId: string
let rssSourceId: string
let topicId: string

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
  const hn = await prisma.source.upsert({
    where: { kind_name: { kind: 'hackernews', name: 'items-test-hn' } },
    update: {},
    create: { kind: 'hackernews', name: 'items-test-hn', config: '{}' },
  })
  const rss = await prisma.source.upsert({
    where: { kind_name: { kind: 'rss', name: 'items-test-rss' } },
    update: {},
    create: { kind: 'rss', name: 'items-test-rss', config: '{}' },
  })
  hnSourceId = hn.id
  rssSourceId = rss.id
})

beforeEach(async () => {
  await prisma.match.deleteMany({ where: { topic: { name: 'items-test-topic' } } })
  await prisma.topic.deleteMany({ where: { name: 'items-test-topic' } })
  await prisma.hotItem.deleteMany({ where: { sourceId: { in: [hnSourceId, rssSourceId] } } })
  topicId = ''
})

afterAll(async () => {
  await prisma.match.deleteMany({ where: { topic: { name: 'items-test-topic' } } })
  await prisma.topic.deleteMany({ where: { name: 'items-test-topic' } })
  await prisma.hotItem.deleteMany({ where: { sourceId: { in: [hnSourceId, rssSourceId] } } })
  await prisma.source.deleteMany({ where: { id: { in: [hnSourceId, rssSourceId] } } })
  await prisma.$disconnect()
})

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api', itemRoutes({ prisma }))
  return a
}

/**
 * 夹具的时间锚点。
 *
 * **必须是相对 `Date.now()` 算出来的，不能写死日期。** `timeRange=24h` 走的是
 * `rollingWindowFilter`（`src/window.ts`），窗口相对**真实当前时间**滚动。
 * 写死日期的夹具只在「写下它的那一刻」成立：这份夹具原本写死 2026-09-15，
 * 于是 2026-09-16 09:00 之后 `24h` 窗口再也盖不住它，测试开始莫名其妙地失败，
 * 而代码一行没动——这种失效能耗掉一整个下午去怀疑自己刚改的东西。
 *
 * 偏离量用小时表达，**三个时间点的相对顺序**才是被测对象：
 *
 * ```
 * scored.publishedAt  <  scored.fetchedAt  <  SINCE_CUTOFF  <  fresh.fetchedAt  <  now
 *      30h 前              5h 前               10h 前            15h 前
 * ```
 *
 * 于是在三个时间窗上的表现恰好各不相同，正好把「publishedAt 优先、缺失才回落
 * 到 fetchedAt」「since 按 fetchedAt」两条规则区分开：
 *
 * - `timeRange=24h`：scored 的 publishedAt 过期，fresh 回落到 fetchedAt 进来 → 1 条
 * - `timeRange=7d` ：两条都在 → 2 条
 * - `since`         ：只有 scored 的 fetchedAt 在切点之后 → 1 条
 */
const HOUR_MS = 60 * 60 * 1000
const NOW = Date.now()
const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR_MS)

const SCORED_PUBLISHED_AT = hoursAgo(30)
const SCORED_FETCHED_AT = hoursAgo(5)
const FRESH_FETCHED_AT = hoursAgo(15)
/** `since` 用例的切点，刻意落在 scored.fetchedAt 与 fresh.fetchedAt 之间 */
const SINCE_CUTOFF = hoursAgo(10).toISOString()

async function seed() {
  // 阶段 2 已经评过分的条目
  const scored = await prisma.hotItem.create({
    data: {
      sourceId: hnSourceId,
      externalId: 'hn:scored',
      url: 'https://example.com/scored',
      title: 'GPT-5 发布，HN 热议',
      summary: 'a summary',
      author: 'alice',
      lang: 'en',
      publishedAt: SCORED_PUBLISHED_AT,
      fetchedAt: SCORED_FETCHED_AT,
      contentHash: 'hash-scored',
      aiState: 'done',
      authenticity: 0.82,
      aiFlags: '["clickbait","ai_generated"]',
      aiReasoning: '标题夸张，但来源可信',
      raw: '{"score":250}',
    },
  })
  // 阶段 2 还没跑过的条目：authenticity / flags / reasoning 全空
  const fresh = await prisma.hotItem.create({
    data: {
      sourceId: rssSourceId,
      externalId: 'rss:fresh',
      url: 'https://example.com/fresh',
      title: '一条普通新闻',
      fetchedAt: FRESH_FETCHED_AT,
      contentHash: 'hash-fresh',
      raw: '{"whatever":1}',
    },
  })
  return { scored, fresh }
}

/** 造 n 条 heatScore **完全相同**的条目——分页稳定性的测试素材。 */
async function seedTied(count: number) {
  for (let i = 0; i < count; i += 1) {
    await prisma.hotItem.create({
      data: {
        sourceId: rssSourceId,
        externalId: `rss:tied-${i}`,
        url: `https://example.com/tied-${i}`,
        title: `同为 rss 的普通条目 ${i}`,
        fetchedAt: new Date('2026-09-15T09:00:00.000Z'),
        contentHash: `hash-tied-${i}`,
      },
    })
  }
}

describe('GET /api/items —— 响应信封', () => {
  it('返回 { data, pagination }，且 total 是筛选后的条数', async () => {
    await seed()
    const res = await request(app()).get('/api/items')

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.pagination).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
    })
    // 旧信封必须已经消失——留着会让前端静默读到 undefined
    expect(res.body.items).toBeUndefined()
    expect(res.body.count).toBeUndefined()
  })

  it('保留原有的所有字段（含 aiState），一个都没少', async () => {
    const { scored } = await seed()
    const res = await request(app()).get(`/api/items?sourceId=${hnSourceId}`)

    expect(res.status).toBe(200)
    expect(res.body.pagination.total).toBe(1)
    const item = res.body.data[0]
    expect(item).toMatchObject({
      id: scored.id,
      title: 'GPT-5 发布，HN 热议',
      url: 'https://example.com/scored',
      summary: 'a summary',
      author: 'alice',
      lang: 'en',
      aiState: 'done',
      source: { name: 'items-test-hn', kind: 'hackernews' },
    })
    // 直接对夹具常量断言，而不是重抄一遍字面量——重抄的字面量总有一天会和
    // 夹具本身脱节，那时失败的是这里，但改动在夹具那边
    expect(new Date(item.publishedAt).toISOString()).toBe(SCORED_PUBLISHED_AT.toISOString())
    expect(new Date(item.fetchedAt).toISOString()).toBe(SCORED_FETCHED_AT.toISOString())
  })

  it('新增 heat / domain / authenticity / flags / reasoning', async () => {
    const { scored } = await seed()
    const res = await request(app()).get(`/api/items?sourceId=${hnSourceId}`)
    const item = res.body.data[0]

    // hackernews raw.score=250 → 250/500
    expect(item.heat).toBeCloseTo(0.5, 6)
    // title 里有 GPT
    expect(item.domain).toBe('大模型')
    expect(item.authenticity).toBeCloseTo(0.82, 6)
    // aiFlags 是 DB 里的 JSON 字符串，出参必须是数组
    expect(item.flags).toEqual(['clickbait', 'ai_generated'])
    expect(item.reasoning).toBe('标题夸张，但来源可信')
    expect(scored.aiScoredAt).toBeNull()
  })

  it('阶段 2 还没评分时：null / [] / null，且 heat 走 fallback 而不是 0', async () => {
    await seed()
    const res = await request(app()).get(`/api/items?sourceId=${rssSourceId}`)

    const item = res.body.data[0]
    expect(item.authenticity).toBeNull()
    expect(item.flags).toEqual([]) // schema 默认 "[]"
    expect(item.reasoning).toBeNull()
    expect(item.aiState).toBe('pending')
    expect(item.heat).toBe(HEAT_FALLBACK)
    expect(item.domain).toBe('其他')
  })

  it('每条都带齐 ItemDTO 的全部 19 个字段', async () => {
    await seed()
    const res = await request(app()).get('/api/items')
    const item = res.body.data[0]
    expect(Object.keys(item).sort()).toEqual(
      [
        'aiState',
        'authenticity',
        'author',
        'clusterId',
        'domain',
        'fetchedAt',
        'flags',
        'heat',
        'id',
        'importance',
        'lang',
        'match',
        'metrics',
        'publishedAt',
        'reasoning',
        'source',
        'summary',
        'title',
        'url',
      ].sort(),
    )
  })
})

describe('GET /api/items —— 新增字段的语义', () => {
  it('importance 非空，且按 flags 打折（零 AI 依赖也应有值）', async () => {
    await seed()
    const res = await request(app()).get(`/api/items?sourceId=${hnSourceId}`)
    // heat 0.5 本身落在 high 档（BANDS: >=0.5），但这条带 clickbait + ai_generated
    // 两个标记 → 0.5 × 0.6 × 0.8 = 0.24，跌出 medium（>=0.3）到 low。
    // 一条标题党 + 疑似 AI 生成的内容不该因为「热度高」就被标成高重要度。
    expect(res.body.data[0].importance).toBe('low')

    // 没有 flags 的同热度条目才配得上 high
    await prisma.hotItem.updateMany({
      where: { sourceId: hnSourceId },
      data: { aiFlags: '[]' },
    })
    const clean = await request(app()).get(`/api/items?sourceId=${hnSourceId}`)
    expect(clean.body.data[0].importance).toBe('high')
  })

  it('metrics 按源自适应：HN 有点数，rss 是空对象而不是一串 0', async () => {
    await seed()
    const hn = await request(app()).get(`/api/items?sourceId=${hnSourceId}`)
    expect(hn.body.data[0].metrics).toEqual({ points: 250 })

    // **关键**：rss 没有任何可提取的指标。给 {}，不是 {points:0,likes:0,...}——
    // 后者会让卡片渲染出一排假的 0。
    const rss = await request(app()).get(`/api/items?sourceId=${rssSourceId}`)
    expect(rss.body.data[0].metrics).toEqual({})
  })

  it('未评估时 match 是 null，不是「相关度为 0」', async () => {
    await seed()
    const res = await request(app()).get('/api/items')
    expect(res.body.data[0].match).toBeNull()
  })

  it('有命中时 match 投影成单值，并带出 topic 名', async () => {
    const { scored } = await seed()
    const topic = await prisma.topic.create({
      data: { name: 'items-test-topic', include: '["GPT"]' },
    })
    topicId = topic.id
    await prisma.match.create({
      data: {
        topicId,
        itemId: scored.id,
        relevance: 0.91,
        confidence: 0.88,
        isAbout: true,
        reasoning: '标题即在讲 GPT-5',
      },
    })

    const res = await request(app()).get(`/api/items?topicId=${topicId}`)
    expect(res.body.pagination.total).toBe(1)
    expect(res.body.data[0].match).toEqual({
      topicId,
      topicName: 'items-test-topic',
      relevance: expect.closeTo(0.91, 6),
      confidence: expect.closeTo(0.88, 6),
      isAbout: true,
      reasoning: '标题即在讲 GPT-5',
    })
  })
})

describe('GET /api/items —— 排序与分页', () => {
  it('sort=heat 按热度降序', async () => {
    // 直接写物化列：这是排序实际读的列
    await prisma.hotItem.create({
      data: {
        sourceId: hnSourceId,
        externalId: 'hn:hot',
        url: 'https://example.com/hot',
        title: 'hot one',
        contentHash: 'hash-hot',
        heatScore: 0.9,
      },
    })
    await prisma.hotItem.create({
      data: {
        sourceId: hnSourceId,
        externalId: 'hn:cold',
        url: 'https://example.com/cold',
        title: 'cold one',
        contentHash: 'hash-cold',
        heatScore: 0.1,
      },
    })

    const res = await request(app()).get('/api/items?sort=heat&order=desc')
    expect(res.body.data.map((i: { title: string }) => i.title)).toEqual(['hot one', 'cold one'])
  })

  it('非法的 sort 值退回默认排序，而不是 500', async () => {
    await seed()
    const res = await request(app()).get('/api/items?sort=; DROP TABLE HotItem')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })

  it('同分条目的分页顺序稳定：两页不重不漏', async () => {
    // 这批条目 heat 全同（rss 全走 HEAT_FALLBACK）、fetchedAt 也全同。
    // 不加 id 次级键的话 SQLite 对同分行不保证顺序，同一条会在两页各出现一次。
    await seedTied(6)

    const p1 = await request(app()).get('/api/items?sort=heat&page=1&pageSize=3')
    const p2 = await request(app()).get('/api/items?sort=heat&page=2&pageSize=3')

    expect(p1.body.pagination.total).toBe(6)
    expect(p1.body.pagination.totalPages).toBe(2)

    const ids = [...p1.body.data, ...p2.body.data].map((i: { id: string }) => i.id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6) // 无重复
  })

  it('pageSize 有上限，page 越界时返回空数组而不是报错', async () => {
    await seed()
    const big = await request(app()).get('/api/items?pageSize=99999')
    expect(big.body.pagination.pageSize).toBeLessThanOrEqual(100)

    const far = await request(app()).get('/api/items?page=99')
    expect(far.status).toBe(200)
    expect(far.body.data).toEqual([])
    // total 仍然是筛选后的全量，不受当前页影响
    expect(far.body.pagination.total).toBe(2)
  })
})

describe('GET /api/items —— 过滤', () => {
  it('kind 按来源种类筛', async () => {
    await seed()
    const res = await request(app()).get('/api/items?kind=rss')
    expect(res.body.pagination.total).toBe(1)
    expect(res.body.data[0].source.kind).toBe('rss')
  })

  it('importance 只认白名单里的档位，非法值当作没传', async () => {
    await seed()
    // 筛选读的是**物化列**，所以要写进去——这正是 `persistItems` 在生产里做的事。
    // 不写的话筛选查不到（而卡片上却有值），这个不对称是物化方案的固有代价，
    // 靠「每个写入路径都物化」这条不变式守住：生产里只有 persistItems + backfill 脚本。
    await prisma.hotItem.updateMany({
      where: { sourceId: hnSourceId },
      data: { importance: 'high', importanceRank: 2 },
    })

    const valid = await request(app()).get('/api/items?importance=high')
    expect(valid.body.pagination.total).toBe(1)

    const bogus = await request(app()).get('/api/items?importance=critical')
    // 当成没传 → 返回全部，而不是构造一个永远为空的结果集
    expect(bogus.body.pagination.total).toBe(2)
  })

  it('sort=importance 按档位排，不按字母序', async () => {
    // 字符串列按字母序排是 high < low < medium < urgent，全错。
    // 所以另存了一列数值档位 importanceRank，排序读它。
    await prisma.hotItem.createMany({
      data: [
        { sourceId: rssSourceId, externalId: 'r:low', url: 'https://example.com/l', title: 'low', contentHash: 'h-low', importance: 'low', importanceRank: 0 },
        { sourceId: rssSourceId, externalId: 'r-urgent', url: 'https://example.com/u', title: 'urgent', contentHash: 'h-urgent', importance: 'urgent', importanceRank: 3 },
        { sourceId: rssSourceId, externalId: 'r-med', url: 'https://example.com/m', title: 'medium', contentHash: 'h-med', importance: 'medium', importanceRank: 1 },
      ],
    })

    const res = await request(app()).get('/api/items?sort=importance&order=desc')
    expect(res.body.data.map((i: { title: string }) => i.title)).toEqual([
      'urgent',
      'medium',
      'low',
    ])
  })

  it('q 在标题 / 摘要 / 作者里找', async () => {
    await seed()
    expect((await request(app()).get('/api/items?q=GPT-5')).body.pagination.total).toBe(1)
    expect((await request(app()).get('/api/items?q=alice')).body.pagination.total).toBe(1)
    expect((await request(app()).get('/api/items?q=不存在的词')).body.pagination.total).toBe(0)
  })

  it('since 过滤没被破坏，且新增字段跟着过滤结果走', async () => {
    await seed()
    const inRange = await request(app()).get(`/api/items?since=${SINCE_CUTOFF}`)
    expect(inRange.body.pagination.total).toBe(1)
    expect(inRange.body.data[0].fetchedAt).toBeDefined()
    expect(typeof inRange.body.data[0].heat).toBe('number')

    const far = await request(app()).get('/api/items?since=2099-01-01T00:00:00.000Z')
    expect(far.body.pagination.total).toBe(0)
    expect(far.body.data).toEqual([])
  })

  it('timeRange 以 publishedAt 为准，缺失时才回落到 fetchedAt', async () => {
    await seed()
    // scored: publishedAt 是 30 小时前 → 落在 7d 内、24h 外。
    // fresh:  publishedAt 为 null → 回落到 fetchedAt（15 小时前）→ 24h 内。
    // 这就是「用 publishedAt，缺了才退回 fetchedAt」的实际效果：
    // 「刚抓到的旧闻」不会被算进「最近 24 小时新出的内容」。
    const day = await request(app()).get('/api/items?timeRange=24h')
    expect(day.body.pagination.total).toBe(1)
    expect(day.body.data[0].publishedAt).toBeNull()

    const week = await request(app()).get('/api/items?timeRange=7d')
    expect(week.body.pagination.total).toBe(2)
  })

  it('authenticity=real 排除带 rumor/clickbait/ad 标记的条目', async () => {
    await seed()
    // scored 带 clickbait 标记 → 不算 real；fresh 没评估过 → 也不在 real 里
    const real = await request(app()).get('/api/items?authenticity=real')
    expect(real.body.pagination.total).toBe(0)

    // 但「未评估」必须落在 suspicious 之外：把没评估说成疑似虚假，
    // 等于把我们的沉默读成一项指控
    const suspicious = await request(app()).get('/api/items?authenticity=suspicious')
    expect(suspicious.body.pagination.total).toBe(1)
    expect(suspicious.body.data[0].flags).toContain('clickbait')
  })
})
