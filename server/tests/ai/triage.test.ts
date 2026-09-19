import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createAiLayer } from '../../src/ai/index.js'
import { createBudgetTracker } from '../../src/ai/budget.js'
import { PrefilterState } from '../../src/ai/prefilter.js'
import { loadCriteriaFromTopics, runTriage } from '../../src/ai/triage.js'
import type { ChatRequest, ChatResult, DeepSeekClient } from '../../src/ai/client.js'
import { mockAuthenticityJson } from '../../src/ai/mock.js'
import { silentAiLogger } from '../../src/ai/types.js'
import { createPrisma } from '../../src/db.js'
import { loadEnv, type Env } from '../../src/env.js'

let prisma: PrismaClient
const KIND = 'test-ai'
const NOW = new Date('2026-09-15T12:00:00Z')

let seq = 0

function testEnv(over: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'file:./test.db',
    AI_MOCK: '1',
    AI_DAILY_TOKEN_BUDGET: '200000',
    ...over,
  })
}

async function cleanup(): Promise<void> {
  const sources = await prisma.source.findMany({ where: { kind: KIND }, select: { id: true } })
  await prisma.hotItem.deleteMany({ where: { sourceId: { in: sources.map((s) => s.id) } } })
  await prisma.source.deleteMany({ where: { kind: KIND } })
  await prisma.cluster.deleteMany({ where: { title: { startsWith: 'ai-test-cluster' } } })
  await prisma.aiCall.deleteMany({})
  await prisma.aiCache.deleteMany({})
  await prisma.topic.deleteMany({ where: { name: { startsWith: 'ai-test-topic' } } })
}

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

beforeEach(cleanup)

async function seedSource(name = `src-${++seq}`, weight = 1) {
  return prisma.source.create({ data: { kind: KIND, name, weight } })
}

interface SeedItem {
  title?: string
  summary?: string | null
  url?: string
  contentHash?: string
  publishedAt?: Date | null
  aiState?: string
  clusterId?: string | null
}

async function seedItem(sourceId: string, over: SeedItem = {}) {
  seq += 1
  return prisma.hotItem.create({
    data: {
      sourceId,
      externalId: `ext-${seq}`,
      url: over.url ?? `https://example.com/ai-test/${seq}`,
      title: over.title ?? `条目 ${seq}`,
      summary: over.summary ?? null,
      contentHash: over.contentHash ?? `ai-test-hash-${seq}`,
      publishedAt: over.publishedAt ?? NOW,
      aiState: over.aiState ?? 'pending',
      clusterId: over.clusterId ?? null,
    },
  })
}

/** 直接调 runTriage，注入可控的 client */
function triageDeps(env: Env, client: DeepSeekClient) {
  return {
    prisma,
    env,
    client,
    budget: createBudgetTracker(prisma, { limit: env.AI_DAILY_TOKEN_BUDGET, memoMs: -1 }),
    prefilter: new PrefilterState(),
    logger: silentAiLogger,
  }
}

/** 用真实 mock 回包的假 client —— 不起网络、不起 layer */
function mockStub(override?: (req: ChatRequest) => string): DeepSeekClient {
  return {
    enabled: true,
    mock: true,
    models: () => ({ fast: 'f', smart: 's', available: [], source: 'config', note: null }),
    probe: async () => ({ fast: 'f', smart: 's', available: [], source: 'config', note: null }),
    async chat(req: ChatRequest): Promise<ChatResult> {
      const content = override
        ? override(req)
        : req.purpose === 'l1_relevance'
          ? (req.mock?.() ?? '{"results":[]}')
          : (req.mock?.() ?? '{}')
      return { content, model: 'stub', promptTokens: 10, completionTokens: 20, cached: false, latencyMs: 1 }
    },
  }
}

const cursorCriteria = { keywords: ['Cursor'], exclude: [] }

// ------------------------------------------------------------ 主流程

describe('triage —— AI_MOCK=1 完整跑通（条目级落库）', () => {
  it('写 HotItem 的真伪字段，并把 aiState 置为 done', async () => {
    const source = await seedSource()
    const item = await seedItem(source.id, {
      title: 'Cursor 发布新版本，上下文窗口翻倍',
      summary: '官方博客给出了具体数字与发布日期。',
    })

    const result = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
    })

    expect(result.degraded).toBe(false)
    expect(result.done).toBe(1)
    expect(result.l1Calls).toBe(1)
    expect(result.l2Calls).toBe(1)

    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row.aiState).toBe('done')
    expect(row.authenticity).toBe(1)
    expect(row.aiFlags).toBe('[]')
    expect(row.aiReasoning).toBeTruthy()
    expect(row.aiScoredAt).not.toBeNull()

    const entry = result.results[0]
    expect(entry?.state).toBe('done')
    expect(entry?.relevance).toBe(0.9)
    expect(entry?.aboutKeywords).toEqual(['Cursor'])
    expect(entry?.tier).toBe('push')
  })

  it('不写 Match（契约 §6.2：关键词级字段阶段 4 才写）', async () => {
    const source = await seedSource()
    await seedItem(source.id, { title: 'Cursor 发布新版本' })
    await runTriage(triageDeps(testEnv(), mockStub()), { criteria: cursorCriteria, now: NOW })
    expect(await prisma.match.count()).toBe(0)
  })

  it('标题党被压到 pending，理由被持久化', async () => {
    const source = await seedSource()
    const item = await seedItem(source.id, {
      title: '震惊！Cursor 杀疯了',
      summary: '官方博客给出了具体数字与发布日期。',
    })

    const result = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
    })

    const entry = result.results[0]
    expect(entry?.flags).toContain('clickbait')
    expect(entry?.tier).toBe('pending')
    expect(entry?.confidence).toBeLessThan(0.8)

    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(JSON.parse(row.aiFlags)).toContain('clickbait')
    expect(row.aiReasoning).toBeTruthy()
    expect(row.authenticity).toBeLessThan(1)
  })

  it('标题党 + 软文 + 旧闻被压到 filtered，但条目与理由都留着（spec §4.2 低置信不删除）', async () => {
    const source = await seedSource()
    const old = new Date(NOW.getTime() - 120 * 3_600_000)
    const item = await seedItem(source.id, {
      title: '震惊！Cursor 杀疯了，再不看就晚了',
      summary: '限时优惠，加微信领取课程',
      publishedAt: old,
    })

    const result = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
    })

    const entry = result.results[0]
    expect(entry?.flags).toContain('clickbait')
    expect(entry?.flags).toContain('ad')
    expect(entry?.tier).toBe('filtered')
    expect(entry?.confidence).toBeLessThan(0.5)

    // 关键：被过滤不等于被删除——行还在，理由还在，用户可以事后标记「AI 看错了」
    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row.aiState).toBe('done')
    expect(row.aiReasoning).toBeTruthy()
    expect(row.authenticity).toBeLessThan(0.7)
    expect(await prisma.hotItem.count({ where: { id: item.id } })).toBe(1)
  })

  it('空表返回全零，不报错', async () => {
    const result = await runTriage(triageDeps(testEnv(), mockStub()), { criteria: cursorCriteria })
    expect(result.considered).toBe(0)
    expect(result.results).toEqual([])
  })
})

// ------------------------------------------------------------ L0 落库

describe('triage —— L0 拒绝的条目落 skipped', () => {
  it('内容过短', async () => {
    const source = await seedSource()
    const item = await seedItem(source.id, { title: '短', summary: null })
    const result = await runTriage(triageDeps(testEnv(), mockStub()), { now: NOW })
    expect(result.skipped).toBe(1)
    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row.aiState).toBe('skipped')
    expect(row.authenticity).toBeNull()
    expect(row.aiReasoning).toContain('过短')
  })

  it('命中排除词', async () => {
    const source = await seedSource()
    const item = await seedItem(source.id, { title: 'Cursor 岗位招聘中，欢迎投递' })
    const result = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: { keywords: ['Cursor'], exclude: ['招聘'] },
      now: NOW,
    })
    expect(result.skipped).toBe(1)
    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row.aiReasoning).toContain('排除词')
  })

  it('未命中任何关键词', async () => {
    const source = await seedSource()
    const item = await seedItem(source.id, { title: 'Rust 编译器的新的借用检查器' })
    const result = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
    })
    expect(result.skipped).toBe(1)
    expect(result.l2Calls).toBe(0)
    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row.aiReasoning).toContain('未命中任何关键词')
  })

  it('未配置关键词时不做筛选，全部进 AI（雷达盘模式）', async () => {
    const source = await seedSource()
    await seedItem(source.id, { title: 'Rust 编译器的新的借用检查器' })
    const result = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: { keywords: [], exclude: [] },
      now: NOW,
    })
    expect(result.done).toBe(1)
    expect(result.l1Calls).toBe(0)
  })

  it('同内容的重复条目不再花钱（跨轮次去重）', async () => {
    const source = await seedSource()
    await seedItem(source.id, { title: 'Cursor 发布新版本', contentHash: 'same-hash-1' })
    await runTriage(triageDeps(testEnv(), mockStub()), { criteria: cursorCriteria, now: NOW })

    const dup = await seedItem(source.id, {
      title: 'Cursor 发布新版本',
      url: 'https://another.com/x',
      contentHash: 'same-hash-1',
    })
    const second = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
    })

    expect(second.done).toBe(0)
    expect(second.skipped).toBe(1)
    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: dup.id } })
    expect(row.aiState).toBe('skipped')
    expect(row.aiReasoning).toContain('重复')
  })
})

// ------------------------------------------------------------ 降级

describe('triage —— 降级路径', () => {
  it('没有 key：全部保持 pending，不联网，不崩', async () => {
    const source = await seedSource()
    const item = await seedItem(source.id, { title: 'Cursor 发布新版本' })

    let fetchCalls = 0
    const env = testEnv({ AI_MOCK: '0', DEEPSEEK_API_KEY: '' })
    const layer = createAiLayer({
      env,
      prisma,
      logger: silentAiLogger,
      fetch: (async () => {
        fetchCalls += 1
        throw new Error('不该联网')
      }) as unknown as typeof globalThis.fetch,
    })

    const result = await layer.triage({ criteria: cursorCriteria, now: NOW })

    expect(result.degraded).toBe(true)
    expect(result.degradeReason).toBe('no_api_key')
    expect(result.pending).toBe(1)
    expect(result.done).toBe(0)
    expect(fetchCalls).toBe(0)

    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row.aiState).toBe('pending')
    expect(row.authenticity).toBeNull()
  })

  it('超预算：只跑 L0 + L1，条目留在 pending 等预算重置', async () => {
    const source = await seedSource()
    const item = await seedItem(source.id, { title: 'Cursor 发布新版本' })

    await prisma.aiCall.create({
      data: {
        purpose: 'seed',
        model: 'deepseek-v4-pro',
        promptHash: 'seed',
        promptTokens: 300_000,
        completionTokens: 0,
        latencyMs: 0,
        ok: true,
      },
    })

    const env = testEnv({ AI_DAILY_TOKEN_BUDGET: '200000' })
    const result = await runTriage(triageDeps(env, mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
    })

    expect(result.degraded).toBe(true)
    expect(result.degradeReason).toBe('budget')
    expect(result.l1Calls).toBe(1) // L1 仍然跑了
    expect(result.l2Calls).toBe(0) // L2 被跳过
    expect(result.pending).toBe(1)
    expect(result.results[0]?.relevance).toBe(0.9) // L1 的结果仍拿到

    const row = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row.aiState).toBe('pending')
    expect(row.authenticity).toBeNull()
  })

  it('L2 单条失败标 failed，不影响其它条目', async () => {
    const source = await seedSource()
    const bad = await seedItem(source.id, { title: 'Cursor 让这条失败' })
    await seedItem(source.id, { title: 'Cursor 正常条目' })

    const client = mockStub((req) => {
      if (req.purpose !== 'l2_authenticity') return req.mock?.() ?? '{"results":[]}'
      const body = req.messages[1]?.content ?? ''
      if (body.includes('让这条失败')) throw new Error('模拟上游 500')
      return mockAuthenticityJson({ title: 'Cursor 正常条目' })
    })

    const result = await runTriage(triageDeps(testEnv(), client), {
      criteria: cursorCriteria,
      now: NOW,
    })

    expect(result.failed).toBe(1)
    expect(result.done).toBe(1)

    const failedRow = await prisma.hotItem.findUniqueOrThrow({ where: { id: bad.id } })
    expect(failedRow.aiState).toBe('failed')
    expect(failedRow.aiReasoning).toContain('模拟上游 500')
  })

  it('failed 的条目默认不重跑，retryFailed 时才重跑', async () => {
    const source = await seedSource()
    await seedItem(source.id, { title: 'Cursor 之前失败的', aiState: 'failed' })

    const skip = await runTriage(triageDeps(testEnv(), mockStub()), { criteria: cursorCriteria, now: NOW })
    expect(skip.considered).toBe(0)

    const retry = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
      retryFailed: true,
    })
    expect(retry.considered).toBe(1)
    expect(retry.done).toBe(1)
  })
})

// ------------------------------------------------------------ L3 交叉验证

describe('triage —— L3 交叉验证（簇内多来源抬高置信度）', () => {
  it('三个独立来源的同一事件置信度高于单来源', async () => {
    const [s1, s2, s3] = [await seedSource(), await seedSource(), await seedSource()]

    const cluster = await prisma.cluster.create({
      data: { title: 'ai-test-cluster-cursor', sourceCount: 3, itemCount: 3 },
    })

    await seedItem(s2.id, { title: 'Cursor 发布新版本', clusterId: cluster.id })
    await seedItem(s3.id, { title: 'Cursor 发布新版本', clusterId: cluster.id })
    const clustered = await seedItem(s1.id, {
      title: 'Cursor 发布新版本',
      clusterId: cluster.id,
      url: 'https://a.example.com/cursor',
    })
    const lone = await seedItem(s1.id, {
      title: 'Cursor 发布新版本',
      url: 'https://b.example.com/cursor',
    })

    const result = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
    })

    const clusteredEntry = result.results.find((r) => r.itemId === clustered.id)
    const loneEntry = result.results.find((r) => r.itemId === lone.id)

    expect(clusteredEntry?.authenticity).toBe(loneEntry?.authenticity)
    expect(clusteredEntry?.relevance).toBe(loneEntry?.relevance)
    expect(clusteredEntry?.confidence).toBeGreaterThan(loneEntry?.confidence ?? 1)
    expect(clusteredEntry?.tier).toBe('push')
  })
})

// ------------------------------------------------------------ 关键词来源

describe('loadCriteriaFromTopics', () => {
  it('把启用 Topic 的 name + include 汇总成关键词，exclude 汇总成排除词', async () => {
    await prisma.topic.create({
      data: {
        name: 'ai-test-topic-cursor',
        include: JSON.stringify(['编程工具']),
        exclude: JSON.stringify(['招聘']),
      },
    })

    const criteria = await loadCriteriaFromTopics(prisma)
    expect(criteria.keywords).toContain('ai-test-topic-cursor')
    expect(criteria.keywords).toContain('编程工具')
    expect(criteria.exclude).toContain('招聘')
  })

  it('坏 JSON 配置被忽略而不是抛错', async () => {
    await prisma.topic.create({
      data: { name: 'ai-test-topic-broken', include: '{不是数组', exclude: '[]' },
    })
    const criteria = await loadCriteriaFromTopics(prisma)
    expect(criteria.keywords).toContain('ai-test-topic-broken')
  })
})

// ------------------------------------------------------------ 预过滤的跨轮次状态

describe('预过滤的去重集合只在一个轮次内有效', () => {
  it('上一轮被预筛挡掉的条目，放宽关键词后这一轮必须真的重评', async () => {
    const source = await seedSource()
    const item = await seedItem(source.id, {
      title: 'Cursor 编辑器发布了新版本',
      summary: '官方给出了具体日期与改动清单。',
    })

    // **同一个 PrefilterState 连跑两轮**——真实进程就是这样：这个对象挂在
    // AiLayer 上，而 AiLayer 被 `aiLayerFor` 的 WeakMap 缓存着活满整个进程
    const env = testEnv()
    const deps = {
      prisma,
      env,
      client: mockStub(),
      budget: createBudgetTracker(prisma, { limit: env.AI_DAILY_TOKEN_BUDGET, memoMs: -1 }),
      prefilter: new PrefilterState(),
      logger: silentAiLogger,
    }

    // 第一轮：关键词对不上 → L0 挡掉，条目落成 skipped
    await runTriage(deps, { criteria: { keywords: ['zebra-这个词不存在'], exclude: [] }, now: NOW })
    const afterFirst = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(afterFirst.aiState).toBe('skipped')

    // 用户放宽了监控词 → `routes/topics.ts` 的 `reviveSkipped` 把它改回 pending
    await prisma.hotItem.update({ where: { id: item.id }, data: { aiState: 'pending' } })

    // 第二轮：关键词这次对得上，必须真的送进 AI
    await runTriage(deps, { criteria: cursorCriteria, now: NOW })

    const afterSecond = await prisma.hotItem.findUniqueOrThrow({ where: { id: item.id } })
    // 若去重集合跨轮次存活，这里会是「重复条目: h:...」：条目明明没被评过，
    // 却因为「上一轮见过」被永远挡在门外——正是 spec §4.2 说的漏报
    expect(afterSecond.aiReasoning ?? '').not.toContain('重复条目')
    expect(afterSecond.aiState).toBe('done')
  })

  it('同一轮内同内容的不同条目仍然只评一次（去重没有一起丢）', async () => {
    const source = await seedSource()
    const hash = `ai-test-dup-${++seq}`
    await seedItem(source.id, { title: 'Cursor 同一篇被两个源抓到 A', contentHash: hash })
    await seedItem(source.id, { title: 'Cursor 同一篇被两个源抓到 B', contentHash: hash })

    const result = await runTriage(triageDeps(testEnv(), mockStub()), {
      criteria: cursorCriteria,
      now: NOW,
    })

    expect(result.done).toBe(1)
    expect(result.skipped).toBe(1)
  })
})

// ------------------------------------------------------------ 门面

describe('createAiLayer 门面', () => {
  it('AI_MOCK=1 下 enabled 为 true，且不联网', async () => {
    let fetchCalls = 0
    const layer = createAiLayer({
      env: testEnv(),
      prisma,
      logger: silentAiLogger,
      fetch: (async () => {
        fetchCalls += 1
        throw new Error('不该联网')
      }) as unknown as typeof globalThis.fetch,
    })
    expect(layer.enabled).toBe(true)
    const models = await layer.probe()
    expect(models.note).toContain('AI_MOCK')
    expect(fetchCalls).toBe(0)
  })

  it('verify() 返回契约 §3.1 的 ItemScore 形状', async () => {
    const layer = createAiLayer({ env: testEnv(), prisma, logger: silentAiLogger })
    const score = await layer.verify({
      text: 'Cursor 发布新版本，官方博客给出 benchmark 数据与发布日期。',
      topic: 'Cursor',
    })
    expect(Object.keys(score).sort()).toEqual(
      ['authenticity', 'confidence', 'flags', 'reasoning', 'relevance', 'tier'].sort(),
    )
    expect(score.relevance).toBe(0.9)
    expect(score.authenticity).toBe(1)
    expect(score.tier).toBe('push')
  })

  it('verify() 支持只用 url', async () => {
    const layer = createAiLayer({ env: testEnv(), prisma, logger: silentAiLogger })
    const score = await layer.verify({ url: 'https://example.com/posts/cursor-2-0' })
    expect(score.authenticity).toBeGreaterThan(0)
    expect(['push', 'pending', 'filtered']).toContain(score.tier)
  })

  it('verify() 两者都不给直接报错', async () => {
    const layer = createAiLayer({ env: testEnv(), prisma, logger: silentAiLogger })
    await expect(layer.verify({})).rejects.toThrow(/至少需要一个/)
  })

  it('stats() 反映当日用量与预算', async () => {
    const layer = createAiLayer({ env: testEnv(), prisma, logger: silentAiLogger })
    await layer.verify({ text: '一些内容', topic: 'Cursor' })
    const stats = await layer.stats()
    expect(stats.today.calls).toBeGreaterThan(0)
    expect(stats.today.tokensIn).toBeGreaterThan(0)
    expect(stats.budget.limit).toBe(200000)
    expect(stats.budget.degraded).toBe(false)
    expect(stats.byModel.length).toBeGreaterThan(0)
  })
})
