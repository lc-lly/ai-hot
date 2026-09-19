import type { PrismaClient } from '@prisma/client'
import {
  createAiLayer,
  type AiLayer,
  type TriageItemResult,
  type TriageResult,
} from '../ai/index.js'
import type { AiDeps, AiLogger } from '../ai/types.js'
import { loadEnv, type Env } from '../env.js'
import { resolveNotifier } from '../jobs/seams.js'
import type { NotifyFn } from '../jobs/types.js'
import { log as realtimeLog } from '../realtime/index.js'
import { importanceOf, isImportance, type Importance } from '../score/importance.js'
import { loadTopicRules, type TopicRule } from './topics.js'

/**
 * `triage` 的门面 —— `jobs/seams.ts` 的 `loadTriageRunner()` 动态 import 的就是这里。
 *
 * ## 它在整条链路里的位置
 *
 * ```
 *   ai/triage.ts          →  本文件            →   notify/
 *   L0/L1/L2/L3 打分          写 Match 行           按策略发通知
 *   （只写 HotItem）         （唯一的 Match 写入点）
 * ```
 *
 * `ai/triage.ts` **刻意不写 Match**（文件头写明了「Match 是阶段 4 才建行」）。
 * 把落库留在这里，是因为写 Match 需要「关键词属于哪个监控词」这层信息，
 * 而那层信息只有本模块有（见 `./topics.ts` 的说明）。
 *
 * ## 为什么必须自己 `loadEnv()`
 *
 * `TriageRunOptions`（`jobs/types.ts`）里没有 `env`，只有 `{prisma, now, limit, retryFailed}`
 * ——`runTriageJob` 就是这么调的。而 `createAiLayer` 需要 `env` 才知道有没有 API key。
 * 所以这里自己读；`loadEnv()` 是纯函数、每次重读 `process.env`，代价可忽略。
 *
 * ## AiLayer 必须记忆化
 *
 * `createAiLayer()` 构造函数里会**发一次 fire-and-forget 的 `/models` 探测**。
 * 每小时一次的定时任务如果每次都新建一层，就是每小时打一次探测请求——
 * 而且 `budget` 与 `prefilter` 的状态（当轮去重集合）也会每次重置。
 * 按 prisma 实例缓存（`WeakMap`），一个进程一层。
 */

/** 进程级缓存：prisma 实例 → AI 层。测试里换 prisma 就等于换一层。 */
const layers = new WeakMap<PrismaClient, AiLayer>()

function aiLogger(): AiLogger {
  return (event) => {
    realtimeLog({
      level: event.level,
      channel: 'ai',
      message: event.message,
      ...(event.meta === undefined ? {} : { meta: event.meta }),
    })
  }
}

/**
 * 取（或建）进程内共享的 AI 层。
 *
 * 导出它是为了让 `routes/ai.ts` 复用同一个实例——`POST /api/ai/verify`
 * 和定时任务必须看到**同一份**预算用量，否则 `AI_DAILY_TOKEN_BUDGET`
 * 会被两条路径各自算一遍，实际花掉两倍。
 *
 * `overrides` 是给测试用的注入点（假 fetch / 静默 logger / 固定时钟）。
 * **带了 overrides 就不进缓存**——一个被注入了假 fetch 的层如果被缓存下来，
 * 下一个真实的调用方会拿到它，然后所有 AI 请求都打到一个 mock 上。
 */
export function aiLayerFor(
  prisma: PrismaClient,
  env: Env,
  overrides?: Pick<AiDeps, 'fetch' | 'logger' | 'now'>,
): AiLayer {
  const injected = overrides !== undefined && Object.keys(overrides).length > 0
  if (!injected) {
    const cached = layers.get(prisma)
    if (cached) return cached
  }

  const made = createAiLayer({
    env,
    prisma,
    logger: overrides?.logger ?? aiLogger(),
    ...(overrides?.fetch === undefined ? {} : { fetch: overrides.fetch }),
    ...(overrides?.now === undefined ? {} : { now: overrides.now }),
  })

  if (!injected) layers.set(prisma, made)
  return made
}

export interface TriageRunDeps {
  prisma: PrismaClient
  /** 缺省 `loadEnv()`。定时任务的调用路径不会传它。 */
  env?: Env
  now: Date
  /** 单轮最多处理多少条。**这就是每小时的费用天花板**（见 `jobs/triage.ts`） */
  limit?: number
  retryFailed?: boolean
  /** 注入用：测试传假的 AI 层 / 通知器，不碰网络也不写通知 */
  ai?: AiLayer
  notify?: NotifyFn
}

/** `ai/triage.ts` 的返回值 + 本模块自己产出的三个计数。 */
export interface TriageRunSummary extends TriageResult {
  /** 写进 `Match` 表的行数（新增 + 更新） */
  matched: number
  /** 因通知策略 / 阈值而标为 `pushed` 的 Match 数 */
  pushed: number
  /** 实际投递出去的通知条数（站内 + 邮件 + 推送各算一条） */
  notified: number
}

/** 一条待落库的 Match，算好之后统一写。 */
interface MatchDraft {
  topic: TopicRule
  item: ItemRow
  relevance: number | null
  isAbout: boolean | null
  /** 条目级；与关键词无关 */
  confidence: number | null
  authenticity: number | null
  flags: string[]
  reasoning: string | null
}

interface ItemRow {
  id: string
  title: string
  url: string
  summary: string | null
  importance: Importance
  sourceKind: string | null
}

/**
 * 跑一轮三层过滤：评分 → 写 Match → 按策略通知。
 *
 * **绝不抛**。三层过滤是定时任务的一环，AI 挂了、库锁了都不该让整条流水线停摆
 * ——`ai/triage.ts` 已经把「单条失败不影响其它条目」做到了，
 * 这里负责兜住它之外的部分（写 Match、发通知），失败记日志并计入摘要。
 */
export async function runTriage(deps: TriageRunDeps): Promise<TriageRunSummary> {
  const env = deps.env ?? loadEnv()
  const ai = deps.ai ?? aiLayerFor(deps.prisma, env)
  const { topics, criteria } = await loadTopicRules(deps.prisma)

  const result = await ai.triage({
    criteria,
    limit: deps.limit,
    now: deps.now,
    retryFailed: deps.retryFailed,
  })

  // 没有任何启用的监控词时不必写 Match：Match 是「监控词 × 条目」的关系，
  // 没有监控词就没有主语。条目级的真伪判定已经由 ai/triage.ts 落在 HotItem 上了。
  if (topics.length === 0 || result.results.length === 0) {
    return { ...result, matched: 0, pushed: 0, notified: 0 }
  }

  const items = await loadItemRows(deps.prisma, result.results)
  const drafts = buildDrafts(result.results, topics, items)

  if (drafts.length === 0) {
    return { ...result, matched: 0, pushed: 0, notified: 0 }
  }

  const notifier = await resolveNotifier(deps.prisma, deps.notify)
  const { matched, pushed, notified } = await persist(deps.prisma, notifier.notify, drafts, deps.now)

  realtimeLog({
    level: 'info',
    channel: 'ai',
    message: `triage 落库：Match ${matched} 行，推送 ${pushed} 条，通知渠道 [${notifier.source}] 投递 ${notified} 条`,
    meta: { matched, pushed, notified, notifier: notifier.source },
  })

  return { ...result, matched, pushed, notified }
}

/** 把本轮涉及到的条目一次性读回来。缺 `id` 的条目（被删了）直接跳过。 */
async function loadItemRows(
  prisma: PrismaClient,
  results: readonly TriageItemResult[],
): Promise<Map<string, ItemRow>> {
  const ids = [...new Set(results.map((r) => r.itemId))]
  if (ids.length === 0) return new Map()

  const rows = await prisma.hotItem.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      title: true,
      url: true,
      summary: true,
      importance: true,
      heatScore: true,
      aiFlags: true,
      source: { select: { kind: true } },
    },
  })

  const map = new Map<string, ItemRow>()
  for (const row of rows) {
    // 重要度优先取物化列，没有就现算——与 `score/dto.ts` 的 `toItemDTO` 同一套口径，
    // 两条路径不会给出不同的档位。
    const importance = isImportance(row.importance)
      ? row.importance
      : importanceOf({ heat: row.heatScore ?? 0.3, flags: parseFlags(row.aiFlags) })

    map.set(row.id, {
      id: row.id,
      title: row.title,
      url: row.url,
      summary: row.summary,
      importance,
      sourceKind: row.source?.kind ?? null,
    })
  }
  return map
}

function parseFlags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * 把「条目级结果」展开成「监控词 × 条目」的 Match 草稿。
 *
 * ## 什么情况下**不**建 Match
 *
 * 只有当某个监控词的关键词**确实命中了这条内容**时才建行。判据是二者之一：
 *
 * - **字面命中**：该词的某个关键词出现在 `matchedKeywords` 里（L0 正则命中）；
 * - **主旨命中**：L1 判定 `isAbout = true`（字面没出现，但内容就是在讲它——
 *   「Claude 发布新版本」这条里可能通篇没写「AI 编程」，但它显然属于那个监控词）。
 *
 * 不加这条限制的话，一次 triage 会给每个监控词都写一行（L1 对**所有**关键词
 * 都出了分），于是库里塞满 `relevance = 0.05` 的 Match，监控词列表页的
 * 「累计命中」变成一个没有意义的数字。
 *
 * ## 相关度取的是「该监控词自己的」
 *
 * `TriageItemResult.relevance` 是**全库最大**相关度，只能用于条目级展示。
 * 写进 Match 的必须是 `keywordVerdicts` 里**属于这个监控词**的关键词的最大值——
 * 这是 `ai/triage.ts` 专门留下 `keywordVerdicts` 的原因，见那里的注释。
 */
function buildDrafts(
  results: readonly TriageItemResult[],
  topics: readonly TopicRule[],
  items: ReadonlyMap<string, ItemRow>,
): MatchDraft[] {
  const drafts: MatchDraft[] = []

  for (const result of results) {
    // 没跑过 L1 的条目（缺 key、被预筛跳过）没有任何关键词级判定，
    // 写出来的 Match 会是一行「相关度未知、是否关于未知」的空壳。
    // 留在下一轮真正评过再写。
    if (Object.keys(result.keywordVerdicts).length === 0) continue

    const item = items.get(result.itemId)
    if (item === undefined) continue

    for (const topic of topics) {
      // 监控词限定了来源种类时，只有该种类的条目才算命中。
      // 这一步不顺延到预筛里去：预筛是全局的，而来源限制是每个监控词自己的。
      if (topic.sourceKinds.length > 0) {
        if (item.sourceKind === null || !topic.sourceKinds.includes(item.sourceKind)) continue
      }

      const projected = project(result, topic)
      if (projected === null) continue

      const literalHit = topic.keywords.some((k) => result.matchedKeywords.includes(k))
      if (!literalHit && projected.isAbout !== true) continue

      drafts.push({
        topic,
        item,
        relevance: projected.relevance,
        isAbout: projected.isAbout,
        confidence: result.confidence,
        authenticity: result.authenticity,
        flags: result.flags,
        reasoning: result.reasoning,
      })
    }
  }

  return drafts
}

/**
 * 取某个监控词在这条内容上的判定。
 *
 * `isAbout` 的**三态**必须保住：`true` = 主旨就是它，`false` = L1 明确说了不是，
 * `null` = 这个词压根没被 L1 判过。把 `null` 写成 `false` 会让卡片显示
 * 「间接相关」，而事实是「还没判定」——这与 `heat` 取不到时给 0.3 而不是 0
 * 是同一类错误（见 `score/heat.ts`）。
 */
function project(
  result: TriageItemResult,
  topic: TopicRule,
): { relevance: number | null; isAbout: boolean | null } | null {
  let relevance: number | null = null
  let isAbout: boolean | null = null
  let judged = false

  for (const keyword of topic.keywords) {
    const verdict = result.keywordVerdicts[keyword]
    if (verdict === undefined) continue
    judged = true
    if (relevance === null || verdict.relevance > relevance) relevance = verdict.relevance
    if (verdict.isAbout) isAbout = true
    else if (isAbout === null) isAbout = false
  }

  return judged ? { relevance, isAbout } : null
}

/**
 * 落库 + 通知。
 *
 * 顺序有讲究：**先写 Match 再发通知**。反过来的话通知里引用的 `matchId`
 * 还不存在，前端点通知跳转时会对不上；而且发信失败（SMTP 挂了）也不该
 * 连带把 Match 一起回滚掉——判定结果是花钱换来的，通知只是它的一个出口。
 */
async function persist(
  prisma: PrismaClient,
  notify: NotifyFn,
  drafts: readonly MatchDraft[],
  now: Date,
): Promise<{ matched: number; pushed: number; notified: number }> {
  const existing = await loadExisting(prisma, drafts)

  let matched = 0
  let pushed = 0
  let notified = 0

  for (const draft of drafts) {
    const decided = decide(draft)
    const prior = existing.get(key(draft))

    // 已经推送过的不要重复推：下一轮 triage 会把同一个 Match 重新算出来，
    // 若不加这道闸，用户每轮都会收到同一条通知。判定结果刷新，
    // 但 `notifiedAt` 与 `pushed` 状态保持不变。
    if (decided.notify && prior?.notifiedAt == null) {
      const matchId = await writeMatch(prisma, draft, decided)
      matched += 1
      if (await deliver(prisma, notify, matchId, draft, decided, now)) {
        notified += 1
        pushed += 1
      }
      continue
    }

    await writeMatch(prisma, draft, decided, prior?.notifiedAt != null ? 'pushed' : undefined)
    matched += 1
    if (prior?.notifiedAt != null) pushed += 1
  }

  return { matched, pushed, notified }
}

interface Existing {
  id: string
  notifiedAt: Date | null
}

async function loadExisting(
  prisma: PrismaClient,
  drafts: readonly MatchDraft[],
): Promise<Map<string, Existing>> {
  const topicIds = [...new Set(drafts.map((d) => d.topic.id))]
  const itemIds = [...new Set(drafts.map((d) => d.item.id))]
  const rows = await prisma.match.findMany({
    where: { topicId: { in: topicIds }, itemId: { in: itemIds } },
    select: { id: true, topicId: true, itemId: true, notifiedAt: true },
  })
  const map = new Map<string, Existing>()
  for (const row of rows) map.set(`${row.topicId} ${row.itemId}`, { id: row.id, notifiedAt: row.notifiedAt })
  return map
}

function key(draft: MatchDraft): string {
  return `${draft.topic.id} ${draft.item.id}`
}

interface Decision {
  status: 'pending' | 'pushed' | 'rejected_by_ai'
  notify: boolean
  /** 通知的级别：tier 为 push 时是 push，否则 pending（契约 §3.2） */
  level: 'push' | 'pending'
}

/**
 * 「这条 Match 该不该通知」——三个 `notifyPolicy` 的**唯一**解释处。
 *
 * ## 与界面上那句说明的对齐
 *
 * `web/src/lib/kinds.ts` 的 `NOTIFY_POLICY_META` 是已经冻结的用户文案：
 *
 * | 策略 | 界面文案 | 这里的实现 |
 * |---|---|---|
 * | `high_only` | 「urgent / high 才通知，噪音最小」 | 看**重要程度** |
 * | `all_confirmed` | 「只要过了真伪判定就通知」 | 看 `authenticity !== null` |
 * | `digest` | 「不即时推，攒成一条日报」 | 恒不推，交给 `jobs/digest` |
 *
 * `high_only` 用的是**重要程度**（`urgent`/`high`）而不是置信度档位 `tier`，
 * 这是照着界面文案实现的——用户看到的是「只推重要及以上」，
 * 那么判断依据就必须是他能在卡片上看到的那个四色徽章，而不是一个他不认识的
 * `tier`。两个字段都基于置信度派生，但口径不同，以界面为准。
 *
 * 置信度阈值（`topic.minConfidence`）在三种策略下都**先过一道**：
 * 低于阈值的判定为 `rejected_by_ai`——**保留在库里，不是删除**，
 * 这是 spec §4.2 的原则（低置信不删，只降级，留可找回的痕迹）。
 */
function decide(draft: MatchDraft): Decision {
  const { topic, confidence, authenticity } = draft

  if (confidence === null) {
    // 还没评完（缺 key / 超预算）：留在 pending，下一轮继续
    return { status: 'pending', notify: false, level: 'pending' }
  }

  if (confidence < topic.minConfidence) {
    return { status: 'rejected_by_ai', notify: false, level: 'pending' }
  }

  const level: 'push' | 'pending' = confidence >= 0.8 ? 'push' : 'pending'

  switch (topic.notifyPolicy) {
    case 'all_confirmed':
      return { status: 'pending', notify: authenticity !== null, level }
    case 'digest':
      return { status: 'pending', notify: false, level }
    case 'high_only':
    default:
      return {
        status: 'pending',
        notify: draft.item.importance === 'urgent' || draft.item.importance === 'high',
        level,
      }
  }
}

async function writeMatch(
  prisma: PrismaClient,
  draft: MatchDraft,
  decided: Decision,
  /** 覆盖 `decided.status`。只有一个用途：保住上一轮的 `pushed`，见 `persist`。 */
  statusOverride?: string,
): Promise<string> {
  const data = {
    relevance: draft.relevance,
    authenticity: draft.authenticity,
    isAbout: draft.isAbout,
    confidence: draft.confidence,
    flags: JSON.stringify(draft.flags),
    reasoning: draft.reasoning,
    status: statusOverride ?? decided.status,
  }

  // upsert 而不是 create：`@@unique([topicId, itemId])` 保证同一对只可能有一行，
  // 而重跑（尤其是 `retryFailed` 和用户点「立即扫描」）会反复到达这里。
  const row = await prisma.match.upsert({
    where: { topicId_itemId: { topicId: draft.topic.id, itemId: draft.item.id } },
    create: { topicId: draft.topic.id, itemId: draft.item.id, ...data },
    update: data,
    select: { id: true },
  })
  return row.id
}

/** 发一条通知。成功返回 `true`，并回写 `notifiedAt` / `status`。失败只记日志。 */
async function deliver(
  prisma: PrismaClient,
  notify: NotifyFn,
  matchId: string,
  draft: MatchDraft,
  decided: Decision,
  now: Date,
): Promise<boolean> {
  const summary = draft.item.summary?.trim()
  const body = draft.reasoning?.trim() || summary || draft.item.url

  try {
    await notify({
      level: decided.level,
      title: `${draft.topic.name} · ${draft.item.title}`,
      body: body.slice(0, 500),
      itemId: draft.item.id,
      topicId: draft.topic.id,
      payload: {
        matchId,
        url: draft.item.url,
        relevance: draft.relevance,
        confidence: draft.confidence,
        importance: draft.item.importance,
        isAbout: draft.isAbout,
      },
    })
    await prisma.match.update({
      where: { id: matchId },
      data: { notifiedAt: now, status: 'pushed' },
    })
    return true
  } catch (e) {
    // 通知失败不回滚 Match：判定结果是花钱换来的，通知只是它的一个出口
    realtimeLog({
      level: 'error',
      channel: 'ai',
      message: `通知投递失败（${draft.topic.name}）: ${e instanceof Error ? e.message : String(e)}`,
      meta: { matchId },
    })
    return false
  }
}

export { loadTopicRules, type TopicRule, type TopicRules } from './topics.js'
