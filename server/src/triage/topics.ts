import type { PrismaClient } from '@prisma/client'
import type { TriageCriteria } from '../ai/index.js'

/**
 * 「关键词 → 属于哪个监控词」的映射表。
 *
 * ## 为什么不直接用 `ai/triage.ts` 的 `loadCriteriaFromTopics`
 *
 * 那个函数把所有监控词的 `name + include` **摊平成一个关键词数组**，
 * 于是 `['Claude', 'AI 编程']` 这条信息就没了——只知道「这条命中了 Claude」，
 * 不知道「所以它属于「Claude 动态」这个监控词」。
 *
 * 而 `Match` 是 **(监控词, 条目)** 一级的表。没有这层映射就写不了 Match，
 * 只能退而求其次把「全库最高相关度」抄到每一行上，那正是契约 §4 反复警告的
 * 「筛选了关键词 A，卡片显示的是关键词 B 的相关度」。
 *
 * ## 单一事实来源
 *
 * 本模块同时产出 `criteria`（喂给 L0 预筛）和 `topics`（用来写 Match），
 * 两者由**同一次读取**派生。分开算的话，某天 `include` 的解析规则改了一处，
 * 就会出现「预筛放行的词，写 Match 时找不到对应监控词」这种静默丢数据的 bug。
 */

/** 与 `routes/topics.ts` 的 `NOTIFY_POLICIES` 保持一致（那边是校验用的白名单）。 */
export type NotifyPolicy = 'high_only' | 'all_confirmed' | 'digest'

const NOTIFY_POLICIES: readonly string[] = ['high_only', 'all_confirmed', 'digest']

export interface TopicRule {
  id: string
  name: string
  /**
   * 这个监控词的全部触发词：`name` + `include`，去重。
   *
   * `name` 一定要算进去——用户建了一个叫「Claude」的监控词却没填 include 时，
   * 他期望的就是「标题里出现 Claude 就告诉我」。不算 `name` 的话这个词
   * 永远不会命中任何东西，而界面上看不出任何异常。
   */
  keywords: string[]
  /** 空数组 = 不限来源 */
  sourceKinds: string[]
  minConfidence: number
  notifyPolicy: NotifyPolicy
}

export interface TopicRules {
  /** 顺序与 `Topic.createdAt desc` 一致，**稳定**：同一批数据两次调用结果相同 */
  topics: TopicRule[]
  /** 所有监控词关键词的并集，交给 L0 预筛 */
  criteria: TriageCriteria
}

/** 解析 schema 里的 JSON 数组列。脏数据一律当空数组，不让整个 triage 挂掉。 */
export function parseList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function toPolicy(raw: unknown): NotifyPolicy {
  return typeof raw === 'string' && NOTIFY_POLICIES.includes(raw)
    ? (raw as NotifyPolicy)
    : 'high_only'
}

/**
 * 读启用的监控词，产出「映射表 + 预筛条件」。
 *
 * **只在 `enabled = true` 的词上工作**：停用是用户明确说的「别管它了」，
 * 把它的关键词混进 `criteria` 会让一批本该被预筛挡掉的条目白花一次 L1 的钱。
 *
 * 没有任何启用的监控词时返回空表 + 空 criteria。此时 `ai/triage.ts` 的
 * 预筛会**放行全部条目**（空 keywords 不等于「全部挡掉」，见 `prefilter.ts`）
 * ——这是有意为之：用户还没配词，AI 至少应该给条目留下真伪判定，
 * 让卡片上的真伪徽章不是空的。
 */
export async function loadTopicRules(prisma: PrismaClient): Promise<TopicRules> {
  const rows = await prisma.topic.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      include: true,
      exclude: true,
      sourceKinds: true,
      minConfidence: true,
      notifyPolicy: true,
    },
  })

  const topics: TopicRule[] = []
  const keywords: string[] = []
  const exclude: string[] = []

  for (const row of rows) {
    // name 在前：`include` 里重复写了 name 时去重会保留先出现的那个位置
    const own = dedupe([row.name, ...parseList(row.include)])
    topics.push({
      id: row.id,
      name: row.name,
      keywords: own,
      sourceKinds: parseList(row.sourceKinds),
      minConfidence: clamp01(row.minConfidence, 0.5),
      notifyPolicy: toPolicy(row.notifyPolicy),
    })

    keywords.push(...own)
    exclude.push(...parseList(row.exclude))
  }

  return {
    topics,
    criteria: { keywords: dedupe(keywords), exclude: dedupe(exclude) },
  }
}

function dedupe(list: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of list) {
    const term = raw.trim()
    if (term !== '' && !out.includes(term)) out.push(term)
  }
  return out
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback
}
