import type { PrismaClient } from '@prisma/client'
import type { Env } from '../env.js'
import type { DeepSeekClient } from './client.js'
import { AiUnavailableError } from './client.js'
import type { BudgetTracker } from './budget.js'
import { ageHoursOf, computeConfidence } from './crosscheck.js'
import type { PrefilterState } from './prefilter.js'
import { runAuthenticity } from './authenticity.js'
import { runRelevance, type L1Verdict } from './relevance.js'
import type { AiFlag, AiLogger, AiState, Tier } from './types.js'

/**
 * triage —— 把 L0 → L1 → L2 → L3 串起来，并把结果落到 `HotItem`。
 *
 * 落库范围严格按契约 §6.2：
 *   - **写** `HotItem.authenticity / aiFlags / aiReasoning / aiScoredAt / aiState`（条目级）
 *   - **不写** `Match`（关键词级，阶段 4 才建行）
 *   - `confidence` / `tier` 是 `Match` 的字段，所以只在返回值里给出，让阶段 4 去写
 *
 * 单条失败绝不影响其它条目；整轮失败也绝不抛到调用方——
 * 采集定时任务不能因为 AI 挂了就整条流水线停摆。
 */

export interface TriageCriteria {
  /** 命中任一即算候选；空数组 = 不做关键词筛选（此时所有条目都进 AI） */
  keywords: string[]
  exclude: string[]
}

export interface TriageOptions {
  criteria?: TriageCriteria
  /** 单轮最多处理多少条 */
  limit?: number
  /** 每个关键词最多送多少条进 L1 */
  maxItemsPerKeyword?: number
  now?: Date
  /** 一并重跑 `failed` 的条目（默认不重跑，避免失败条目反复烧钱） */
  retryFailed?: boolean
}

/** 单个关键词在一条内容上的 L1 判定结果。 */
export interface KeywordVerdict {
  /** 0..1 */
  relevance: number
  /** L1 判定「这条的主旨就是在讲它」 */
  isAbout: boolean
}

export interface TriageItemResult {
  itemId: string
  state: AiState
  relevance: number | null
  authenticity: number | null
  confidence: number | null
  tier: Tier | null
  flags: AiFlag[]
  reasoning: string | null
  matchedKeywords: string[]
  /** L1 认为「确实关于」的关键词 */
  aboutKeywords: string[]
  /**
   * 关键词 → **该关键词自己**的 L1 判定。
   *
   * **为什么必须逐关键词留着，而不是只用上面那个 `relevance`：**
   * `relevance` 是「该条目在所有关键词上的**最大**相关度」，而 `Match` 是
   * (关键词, 条目) 一级的。拿最大值去填每一个关键词的 Match，会让
   * 「关于 Claude 的相关度 95%」被抄到「关于 AI 编程」那一行上——
   * 用户筛了 AI 编程，看到的却是 Claude 的分数。
   * 这正是契约 §4 反复警告的「筛选了关键词 A，卡片显示关键词 B 的相关度」。
   */
  keywordVerdicts: Record<string, KeywordVerdict>
}

export interface TriageResult {
  considered: number
  done: number
  skipped: number
  failed: number
  /** 因缺 key / 超预算而没能评分的条数，保持 pending 等下一轮 */
  pending: number
  degraded: boolean
  degradeReason: 'no_api_key' | 'budget' | null
  l1Calls: number
  l2Calls: number
  results: TriageItemResult[]
}

export interface TriageDeps {
  prisma: PrismaClient
  env: Env
  client: DeepSeekClient
  budget: BudgetTracker
  prefilter: PrefilterState
  logger: AiLogger
}

/** 从 `Topic` 表读启用的关键词（只读，Topic 的 CRUD 属于阶段 4） */
export async function loadCriteriaFromTopics(prisma: PrismaClient): Promise<TriageCriteria> {
  const topics = await prisma.topic.findMany({ where: { enabled: true } })
  const keywords: string[] = []
  const exclude: string[] = []

  const parse = (raw: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(raw || '[]')
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  }

  for (const topic of topics) {
    keywords.push(topic.name, ...parse(topic.include))
    exclude.push(...parse(topic.exclude))
  }

  return {
    keywords: [...new Set(keywords.map((k) => k.trim()).filter(Boolean))],
    exclude: [...new Set(exclude.map((e) => e.trim()).filter(Boolean))],
  }
}

interface ClusterContext {
  sourceCount: number
}

export async function runTriage(deps: TriageDeps, options: TriageOptions = {}): Promise<TriageResult> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? 50
  const criteria = options.criteria ?? { keywords: [], exclude: [] }
  const maxPerKeyword = options.maxItemsPerKeyword ?? 50

  const empty: TriageResult = {
    considered: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    degraded: false,
    degradeReason: null,
    l1Calls: 0,
    l2Calls: 0,
    results: [],
  }

  const rows = await deps.prisma.hotItem.findMany({
    where: {
      aiState: options.retryFailed ? { in: ['pending', 'failed'] } : 'pending',
    },
    orderBy: { fetchedAt: 'desc' },
    take: limit,
    include: { source: { select: { name: true, weight: true } } },
  })

  if (rows.length === 0) return empty

  // 逐条结果先不带 `keywordVerdicts`——它要等 L1 跑完才存在，
  // 在函数末尾一次性补上，免得 5 个 push 点各抄一遍。
  const results: Array<Omit<TriageItemResult, 'keywordVerdicts'>> = []
  /** itemId → 关键词 → 该关键词自己的判定（见 `TriageItemResult.keywordVerdicts`） */
  const perKeyword = new Map<string, Record<string, KeywordVerdict>>()
  /** 收尾时才把 `keywordVerdicts` 贴回去；缺 key 的提前返回也要用它 */
  const collect = (): TriageItemResult[] =>
    results.map((r) => ({ ...r, keywordVerdicts: perKeyword.get(r.itemId) ?? {} }))
  const markSkipped = async (itemId: string, reason: string): Promise<void> => {
    await deps.prisma.hotItem.update({
      where: { id: itemId },
      data: {
        aiState: 'skipped',
        authenticity: null,
        aiFlags: '[]',
        aiReasoning: reason,
        aiScoredAt: now,
      },
    })
    results.push({
      itemId,
      state: 'skipped',
      relevance: null,
      authenticity: null,
      confidence: null,
      tier: null,
      flags: [],
      reasoning: reason,
      matchedKeywords: [],
      aboutKeywords: [],
    })
  }

  // ---------------------------------------------------------------- L0
  // **去重集合的作用域是「一轮」，不是「一个进程」。**
  //
  // `prefilter` 这个对象挂在 `AiLayer` 上，而 `AiLayer` 被 `aiLayerFor` 的
  // WeakMap 缓存着活满整个进程——不在这里清空的话，第一轮见过的键会一直留着。
  // 后果不是「少花一次钱」，而是**永久漏报**：条目被 L0 挡掉时键已经记下，
  // 之后 `routes/topics.ts` 的 `reviveSkipped` 把它改回 pending（用户放宽了
  // 监控词），下一轮却因为「上一轮见过」被判成 `重复条目`——一条从没被评过的
  // 条目，从此再也进不了 AI。AI 预算耗尽把条目留在 pending 时同理。
  //
  // 跨轮次的重复靠下面那次 DB 查询（`alreadyHandled`）与 ingest 的
  // `@@unique([sourceId, externalId])`，不靠这个集合。
  deps.prefilter.reset()

  // 先把已处理过（done / skipped）的同内容条目灌进去重集合，
  // 这样跨源重复不会在下一轮又被送进 AI 花一次钱。
  const hashes = rows.map((r) => r.contentHash)
  const alreadyHandled = await deps.prisma.hotItem.findMany({
    where: { contentHash: { in: hashes }, aiState: { in: ['done', 'skipped'] } },
    select: { contentHash: true },
  })
  for (const row of alreadyHandled) deps.prefilter.add(`h:${row.contentHash}`)

  interface Candidate {
    id: string
    url: string
    title: string
    summary: string | null
    contentHash: string
    author: string | null
    publishedAt: Date | null
    fetchedAt: Date
    sourceName: string | null
    sourceWeight: number
    clusterId: string | null
    matchedKeywords: string[]
  }

  const candidates: Candidate[] = []
  for (const row of rows) {
    const decision = deps.prefilter.consider(
      { url: row.url, title: row.title, summary: row.summary, contentHash: row.contentHash },
      criteria,
    )

    if (decision.action === 'reject') {
      // 「未命中任何关键词」也走 skipped：它不是坏数据，只是这一轮不需要它。
      // 若之后新增了能命中它的关键词，条目的 aiState 已不是 pending，
      // 需要阶段 4 的关键词新增流程显式重置（见报告中的说明）。
      await markSkipped(row.id, decision.detail)
      continue
    }

    candidates.push({
      id: row.id,
      url: row.url,
      title: row.title,
      summary: row.summary,
      contentHash: row.contentHash,
      author: row.author,
      publishedAt: row.publishedAt,
      fetchedAt: row.fetchedAt,
      sourceName: row.source.name,
      sourceWeight: row.source.weight,
      clusterId: row.clusterId,
      matchedKeywords: decision.matchedKeywords,
    })
  }

  // ------------------------------------------------- 缺 key：降级，不崩
  if (!deps.client.enabled) {
    deps.logger({
      level: 'warn',
      channel: 'ai',
      message: `AI 不可用（DEEPSEEK_API_KEY 未配置且 AI_MOCK=0），${candidates.length} 条保持 pending，服务不受影响`,
    })
    return {
      ...empty,
      considered: rows.length,
      skipped: results.length,
      pending: candidates.length,
      degraded: true,
      degradeReason: 'no_api_key',
      results: collect(),
    }
  }

  // ---------------------------------------------------------------- L1
  const verdicts = new Map<string, L1Verdict>()
  const about = new Map<string, string[]>()
  let l1Calls = 0

  for (const keyword of criteria.keywords) {
    const batch = candidates.slice(0, maxPerKeyword)
    if (batch.length === 0) break
    const res = await runRelevance(
      { client: deps.client, logger: deps.logger },
      keyword,
      batch.map((c) => ({ id: c.id, title: c.title, summary: c.summary, url: c.url })),
    )
    l1Calls += res.calls

    for (const [id, verdict] of res.verdicts) {
      const current = verdicts.get(id)
      // 一个条目可能关于多个关键词，取相关度最高的那次判定作为条目级相关性
      if (!current || verdict.relevance > current.relevance) verdicts.set(id, verdict)
      if (verdict.isAboutTopic) {
        const list = about.get(id) ?? []
        list.push(keyword)
        about.set(id, list)
      }

      const bag = perKeyword.get(id) ?? {}
      bag[keyword] = { relevance: verdict.relevance, isAbout: verdict.isAboutTopic }
      perKeyword.set(id, bag)
    }
  }

  // ---------------------------------------------------------------- 预算
  const budgetDegraded = await deps.budget.isDegraded(now)

  // ---------------------------------------------------------------- L2 + L3
  const clusterCache = new Map<string, ClusterContext>()
  const clusterContextOf = async (clusterId: string | null): Promise<ClusterContext> => {
    if (!clusterId) return { sourceCount: 1 }
    const cached = clusterCache.get(clusterId)
    if (cached) return cached
    // 只读 Cluster —— 簇的填充不属于 AI 层，这里拿不到就当单来源
    const cluster = await deps.prisma.cluster.findUnique({
      where: { id: clusterId },
      include: { items: { select: { sourceId: true } } },
    })
    const ctx: ClusterContext = cluster
      ? { sourceCount: new Set(cluster.items.map((i) => i.sourceId)).size }
      : { sourceCount: 1 }
    clusterCache.set(clusterId, ctx)
    return ctx
  }

  let l2Calls = 0
  let done = 0
  let failed = 0
  let pending = 0

  for (const candidate of candidates) {
    const relevance = verdicts.get(candidate.id)?.relevance ?? null

    if (budgetDegraded) {
      // spec §4.4：超预算后降级为只跑 L0 + L1。没有 L2 就没有 authenticity，
      // 置信度无从谈起，所以条目留在 pending 等预算重置，而不是给一个假分数。
      pending += 1
      results.push({
        itemId: candidate.id,
        state: 'pending',
        relevance,
        authenticity: null,
        confidence: null,
        tier: null,
        flags: [],
        reasoning: null,
        matchedKeywords: candidate.matchedKeywords,
        aboutKeywords: about.get(candidate.id) ?? [],
      })
      continue
    }

    try {
      const verdict = await runAuthenticity(
        { client: deps.client, logger: deps.logger },
        {
          id: candidate.id,
          title: candidate.title,
          summary: candidate.summary,
          url: candidate.url,
          author: candidate.author,
          publishedAt: candidate.publishedAt,
          sourceName: candidate.sourceName,
        },
      )
      l2Calls += 1

      await deps.prisma.hotItem.update({
        where: { id: candidate.id },
        data: {
          aiState: 'done',
          authenticity: verdict.authenticity,
          aiFlags: JSON.stringify(verdict.flags),
          aiReasoning: verdict.reasoning,
          aiScoredAt: now,
        },
      })

      const ctx = await clusterContextOf(candidate.clusterId)
      const cross = computeConfidence({
        relevance: relevance ?? 0,
        authenticity: verdict.authenticity,
        sourceCount: ctx.sourceCount,
        sourceWeight: candidate.sourceWeight,
        ageHours: ageHoursOf({
          publishedAt: candidate.publishedAt,
          fetchedAt: candidate.fetchedAt,
          now,
        }),
        flags: verdict.flags,
      })

      done += 1
      results.push({
        itemId: candidate.id,
        state: 'done',
        relevance,
        authenticity: verdict.authenticity,
        confidence: cross.confidence,
        tier: cross.tier,
        flags: verdict.flags,
        reasoning: verdict.reasoning,
        matchedKeywords: candidate.matchedKeywords,
        aboutKeywords: about.get(candidate.id) ?? [],
      })
    } catch (e) {
      // 没 key / 超预算：整轮降级，后续条目不再逐条试错
      if (e instanceof AiUnavailableError) {
        deps.logger({
          level: 'warn',
          channel: 'ai',
          message: `AI 降级（${e.code}），剩余条目保持 pending: ${e.message}`,
        })
        pending += 1
        results.push({
          itemId: candidate.id,
          state: 'pending',
          relevance,
          authenticity: null,
          confidence: null,
          tier: null,
          flags: [],
          reasoning: null,
          matchedKeywords: candidate.matchedKeywords,
          aboutKeywords: about.get(candidate.id) ?? [],
        })
        continue
      }

      // 其它错误（网络、解析、5xx）：标 failed，不重试，避免烧钱循环
      const message = e instanceof Error ? e.message : String(e)
      await deps.prisma.hotItem.update({
        where: { id: candidate.id },
        data: { aiState: 'failed', aiFlags: '[]', aiReasoning: message, aiScoredAt: now },
      })
      deps.logger({
        level: 'error',
        channel: 'ai',
        message: `L2 判定失败条 ${candidate.id}: ${message}`,
      })
      failed += 1
      results.push({
        itemId: candidate.id,
        state: 'failed',
        relevance,
        authenticity: null,
        confidence: null,
        tier: null,
        flags: [],
        reasoning: message,
        matchedKeywords: candidate.matchedKeywords,
        aboutKeywords: about.get(candidate.id) ?? [],
      })
    }
  }

  const summary: TriageResult = {
    considered: rows.length,
    done,
    skipped: results.filter((r) => r.state === 'skipped').length,
    failed,
    pending,
    degraded: budgetDegraded,
    degradeReason: budgetDegraded ? 'budget' : null,
    l1Calls,
    l2Calls,
    // 这里补齐 `keywordVerdicts`：只有走过 L1 的条目才有，skipped 的恒为空对象
    results: collect(),
  }

  deps.logger({
    level: 'info',
    channel: 'ai',
    message: `triage 完成: 处理 ${summary.considered} 条，done ${done} / skipped ${summary.skipped} / failed ${failed} / pending ${pending}`,
    meta: { l1Calls, l2Calls, degraded: summary.degraded },
  })

  return summary
}
