import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { AiLayer, TriageItemResult, TriageResult } from '../src/ai/index.js'
import { createPrisma } from '../src/db.js'
import { runTriage } from '../src/triage/index.js'
import { loadTopicRules } from '../src/triage/topics.js'

/**
 * `src/triage/**` 的契约测试。
 *
 * 这里**不碰 DeepSeek**：注入一个假的 `AiLayer`，让 `triage()` 直接返回
 * 构造好的 `TriageResult`。被测的是门面自己的逻辑——写 `Match`、
 * 按策略通知——那正是 `ai/triage.ts` 刻意不做、只在这里发生的事。
 */

let prisma: PrismaClient
let hnSourceId: string
let rssSourceId: string

const TOPIC_A = 'triage-test-主题词'
const TOPIC_B = 'triage-test-另一个'

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
  const hn = await prisma.source.upsert({
    where: { kind_name: { kind: 'hackernews', name: 'triage-test-hn' } },
    update: {},
    create: { kind: 'hackernews', name: 'triage-test-hn', config: '{}' },
  })
  const rss = await prisma.source.upsert({
    where: { kind_name: { kind: 'rss', name: 'triage-test-rss' } },
    update: {},
    create: { kind: 'rss', name: 'triage-test-rss', config: '{}' },
  })
  hnSourceId = hn.id
  rssSourceId = rss.id
})

async function cleanup(): Promise<void> {
  await prisma.match.deleteMany({ where: { topic: { name: { in: [TOPIC_A, TOPIC_B] } } } })
  await prisma.topic.deleteMany({ where: { name: { in: [TOPIC_A, TOPIC_B] } } })
  await prisma.hotItem.deleteMany({ where: { sourceId: { in: [hnSourceId, rssSourceId] } } })
  await prisma.notification.deleteMany({ where: { title: { startsWith: TOPIC_A } } })
  await prisma.notification.deleteMany({ where: { title: { startsWith: TOPIC_B } } })
}

beforeEach(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.source.deleteMany({ where: { id: { in: [hnSourceId, rssSourceId] } } })
  await prisma.$disconnect()
})

async function makeTopic(opts: {
  name: string
  include?: string[]
  sourceKinds?: string[]
  notifyPolicy?: string
  minConfidence?: number
}): Promise<string> {
  const row = await prisma.topic.create({
    data: {
      name: opts.name,
      include: JSON.stringify(opts.include ?? []),
      exclude: '[]',
      sourceKinds: JSON.stringify(opts.sourceKinds ?? []),
      notifyPolicy: opts.notifyPolicy ?? 'high_only',
      minConfidence: opts.minConfidence ?? 0.5,
    },
  })
  return row.id
}

async function makeItem(opts: {
  sourceId: string
  title?: string
  importance?: string
}): Promise<string> {
  const row = await prisma.hotItem.create({
    data: {
      sourceId: opts.sourceId,
      externalId: `triage-${Math.random().toString(36).slice(2)}`,
      url: `https://example.com/${Math.random().toString(36).slice(2)}`,
      title: opts.title ?? '一条测试内容',
      summary: '摘要',
      contentHash: Math.random().toString(36).slice(2),
      importance: opts.importance ?? 'medium',
      heatScore: 0.5,
      aiState: 'done',
    },
  })
  return row.id
}

/**
 * 假的 AI 层。只实现门面真正用到的 `triage()`，
 * 其余成员不会被调用，所以断言式的 cast 是安全的。
 */
function fakeLayer(result: TriageResult): AiLayer {
  return { triage: async () => result } as unknown as AiLayer
}

function itemResult(over: Partial<TriageItemResult> & { itemId: string }): TriageItemResult {
  return {
    state: 'done',
    relevance: 0.5,
    authenticity: 0.9,
    confidence: 0.85,
    tier: 'push',
    flags: [],
    reasoning: '看起来是真的',
    matchedKeywords: [],
    aboutKeywords: [],
    keywordVerdicts: {},
    ...over,
  }
}

function wrap(results: TriageItemResult[]): TriageResult {
  return {
    considered: results.length,
    done: results.length,
    skipped: 0,
    failed: 0,
    pending: 0,
    degraded: false,
    degradeReason: null,
    l1Calls: 1,
    l2Calls: results.length,
    results,
  }
}

const NOW = new Date('2026-09-16T10:00:00Z')

describe('loadTopicRules', () => {
  it('每个监控词自己带关键词，而不是摊平成一锅', async () => {
    await makeTopic({ name: TOPIC_A, include: ['Claude', 'Anthropic'] })
    await makeTopic({ name: TOPIC_B, include: ['Cursor'] })

    const { topics, criteria } = await loadTopicRules(prisma)

    const a = topics.find((t) => t.name === TOPIC_A)
    const b = topics.find((t) => t.name === TOPIC_B)
    // name 本身也是关键词：用户建了「Cursor」监控词却没填 include 时，
    // 他期望的就是标题里出现 Cursor 就命中
    expect(a?.keywords).toEqual([TOPIC_A, 'Claude', 'Anthropic'])
    expect(b?.keywords).toEqual([TOPIC_B, 'Cursor'])
    expect(criteria.keywords).toEqual(
      expect.arrayContaining([TOPIC_A, 'Claude', 'Anthropic', TOPIC_B, 'Cursor']),
    )
  })

  it('停用的监控词不进 criteria，也不建 Match', async () => {
    const id = await makeTopic({ name: TOPIC_A, include: ['zebra-unique-token'] })
    await prisma.topic.update({ where: { id }, data: { enabled: false } })

    const { topics, criteria } = await loadTopicRules(prisma)
    expect(topics.find((t) => t.name === TOPIC_A)).toBeUndefined()
    expect(criteria.keywords).not.toContain('zebra-unique-token')
  })
})

describe('写 Match', () => {
  it('每个监控词拿到**它自己**的相关度，而不是全库最高分', async () => {
    const idA = await makeTopic({ name: TOPIC_A, include: ['Claude'] })
    const idB = await makeTopic({ name: TOPIC_B, include: ['AI 编程'] })
    const itemId = await makeItem({ sourceId: hnSourceId })

    // 这条内容主旨是关于 Claude 的，只是顺带提了 AI 编程
    await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId,
            matchedKeywords: ['Claude', 'AI 编程'],
            keywordVerdicts: {
              Claude: { relevance: 0.95, isAbout: true },
              'AI 编程': { relevance: 0.2, isAbout: false },
            },
          }),
        ]),
      ),
    })

    const matchA = await prisma.match.findUnique({
      where: { topicId_itemId: { topicId: idA, itemId } },
    })
    const matchB = await prisma.match.findUnique({
      where: { topicId_itemId: { topicId: idB, itemId } },
    })

    // 这正是契约 §4 警告的「筛选了关键词 A，卡片显示的是关键词 B 的相关度」
    expect(matchA?.relevance).toBe(0.95)
    expect(matchA?.isAbout).toBe(true)
    expect(matchB?.relevance).toBe(0.2)
    expect(matchB?.isAbout).toBe(false)
  })

  it('没被判过的关键词不建 Match——「没判」不是「不相关」', async () => {
    await makeTopic({ name: TOPIC_A, include: ['Claude'] })
    const idB = await makeTopic({ name: TOPIC_B, include: ['Zig'] })
    const itemId = await makeItem({ sourceId: hnSourceId })

    await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId,
            matchedKeywords: ['Claude'],
            keywordVerdicts: { Claude: { relevance: 0.9, isAbout: true } },
          }),
        ]),
      ),
    })

    // Zig 那个监控词一个字都没被判过，建一行 isAbout=null 的 Match 会让卡片
    // 显示「间接相关」——而事实是「还没判定」
    const matchB = await prisma.match.findUnique({
      where: { topicId_itemId: { topicId: idB, itemId } },
    })
    expect(matchB).toBeNull()
  })

  it('isAbout 为真也可以建 Match：字面没出现但主旨就是它', async () => {
    const idA = await makeTopic({ name: TOPIC_A, include: ['AI 编程'] })
    const itemId = await makeItem({ sourceId: hnSourceId })

    await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId,
            // 标题里一个关键词都没出现，是 L1 判出来「就是在讲这个」
            matchedKeywords: [],
            keywordVerdicts: { 'AI 编程': { relevance: 0.88, isAbout: true } },
          }),
        ]),
      ),
    })

    const match = await prisma.match.findUnique({
      where: { topicId_itemId: { topicId: idA, itemId } },
    })
    expect(match?.isAbout).toBe(true)
    expect(match?.relevance).toBe(0.88)
  })

  it('监控词限定了来源种类时，不符的条目不建 Match', async () => {
    const idA = await makeTopic({ name: TOPIC_A, sourceKinds: ['rss'] })
    const itemId = await makeItem({ sourceId: hnSourceId })

    await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId,
            matchedKeywords: [TOPIC_A],
            keywordVerdicts: { [TOPIC_A]: { relevance: 0.9, isAbout: true } },
          }),
        ]),
      ),
    })

    expect(await prisma.match.findUnique({ where: { topicId_itemId: { topicId: idA, itemId } } })).toBeNull()
  })

  it('没跑过 L1 的条目一个 Match 都不写', async () => {
    const idA = await makeTopic({ name: TOPIC_A })
    const itemId = await makeItem({ sourceId: hnSourceId })

    await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId,
            state: 'pending',
            confidence: null,
            relevance: null,
            keywordVerdicts: {},
          }),
        ]),
      ),
    })

    expect(await prisma.match.findUnique({ where: { topicId_itemId: { topicId: idA, itemId } } })).toBeNull()
  })
})

describe('通知策略', () => {
  it('high_only：只推 urgent / high 的条目', async () => {
    await makeTopic({ name: TOPIC_A, notifyPolicy: 'high_only' })
    const urgent = await makeItem({ sourceId: hnSourceId, importance: 'urgent' })
    const low = await makeItem({ sourceId: hnSourceId, importance: 'low' })

    const result = await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId: urgent,
            matchedKeywords: [TOPIC_A],
            keywordVerdicts: { [TOPIC_A]: { relevance: 0.9, isAbout: true } },
          }),
          itemResult({
            itemId: low,
            matchedKeywords: [TOPIC_A],
            keywordVerdicts: { [TOPIC_A]: { relevance: 0.9, isAbout: true } },
          }),
        ]),
      ),
    })

    expect(result.matched).toBe(2)
    expect(result.pushed).toBe(1)
    expect(result.notified).toBe(1)

    const rows = await prisma.notification.findMany({ where: { title: { startsWith: TOPIC_A } } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.level).toBe('push')
    expect(JSON.parse(rows[0]?.channels ?? '[]')).toContain('inapp')
  })

  it('digest：绝不即时推，但 Match 照写', async () => {
    const idA = await makeTopic({ name: TOPIC_A, notifyPolicy: 'digest' })
    const itemId = await makeItem({ sourceId: hnSourceId, importance: 'urgent' })

    const result = await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId,
            matchedKeywords: [TOPIC_A],
            keywordVerdicts: { [TOPIC_A]: { relevance: 0.9, isAbout: true } },
          }),
        ]),
      ),
    })

    expect(result.matched).toBe(1)
    expect(result.notified).toBe(0)
    expect(await prisma.notification.count({ where: { title: { startsWith: TOPIC_A } } })).toBe(0)

    const match = await prisma.match.findUnique({
      where: { topicId_itemId: { topicId: idA, itemId } },
    })
    expect(match?.status).toBe('pending')
  })

  it('置信度低于阈值判为 rejected_by_ai——保留，不删除', async () => {
    const idA = await makeTopic({ name: TOPIC_A, minConfidence: 0.9 })
    const itemId = await makeItem({ sourceId: hnSourceId, importance: 'urgent' })

    await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId,
            confidence: 0.4,
            matchedKeywords: [TOPIC_A],
            keywordVerdicts: { [TOPIC_A]: { relevance: 0.9, isAbout: true } },
          }),
        ]),
      ),
    })

    const match = await prisma.match.findUnique({
      where: { topicId_itemId: { topicId: idA, itemId } },
    })
    // spec §4.2：低置信不删，只降级，留可找回的痕迹
    expect(match).not.toBeNull()
    expect(match?.status).toBe('rejected_by_ai')
    expect(await prisma.notification.count({ where: { title: { startsWith: TOPIC_A } } })).toBe(0)
  })

  it('重跑不会重复推送同一条', async () => {
    await makeTopic({ name: TOPIC_A })
    const itemId = await makeItem({ sourceId: hnSourceId, importance: 'urgent' })

    const layer = fakeLayer(
      wrap([
        itemResult({
          itemId,
          matchedKeywords: [TOPIC_A],
          keywordVerdicts: { [TOPIC_A]: { relevance: 0.9, isAbout: true } },
        }),
      ]),
    )

    const first = await runTriage({ prisma, now: NOW, ai: layer })
    const second = await runTriage({ prisma, now: NOW, ai: layer })

    expect(first.notified).toBe(1)
    expect(second.notified).toBe(0)
    expect(second.pushed).toBe(1) // 状态仍是 pushed，只是没有再发一次
    expect(await prisma.notification.count({ where: { title: { startsWith: TOPIC_A } } })).toBe(1)
  })
})

describe('没有监控词时', () => {
  it('不写 Match，也不报错', async () => {
    const itemId = await makeItem({ sourceId: hnSourceId })
    const result = await runTriage({
      prisma,
      now: NOW,
      ai: fakeLayer(
        wrap([
          itemResult({
            itemId,
            matchedKeywords: [],
            keywordVerdicts: { something: { relevance: 0.5, isAbout: true } },
          }),
        ]),
      ),
    })

    expect(result.matched).toBe(0)
    expect(result.notified).toBe(0)
  })
})
