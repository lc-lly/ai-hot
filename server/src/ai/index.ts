import { createBudgetTracker, type BudgetTracker } from './budget.js'
import { createDeepSeekClient, AiUnavailableError, type DeepSeekClient } from './client.js'
import { ageHoursOf, computeConfidence } from './crosscheck.js'
import { runAuthenticity } from './authenticity.js'
import { runRelevance } from './relevance.js'
import { PrefilterState } from './prefilter.js'
import { loadCriteriaFromTopics, runTriage, type TriageCriteria, type TriageItemResult, type TriageOptions, type TriageResult } from './triage.js'
import {
  consoleAiLogger,
  type AiDeps,
  type AiLogger,
  type AiStats,
  type ItemScore,
} from './types.js'

/**
 * AI 层的门面。
 *
 * 只暴露两件东西：`createAiLayer` 给进程用，类型给调用方用。
 * 内部四层（L0/L1/L2/L3）都是纯模块，可以单独 import 来测，
 * 但业务代码一律走门面，免得各模块自己拼一套参数。
 */

/** 未配置关键词时的兜底领域（spec §8：`discover` 的默认范围是「AI 编程」） */
export const DEFAULT_TOPIC = 'AI 编程'

/** `Setting` 表里领域配置的键，与阶段 5 的 discover 共用 */
export const DOMAIN_SETTING_KEY = 'discover.domain'

export interface VerifyInput {
  url?: string
  text?: string
  /** 判断相关性用的关键词；缺省从 Setting 读，再缺省为「AI 编程」 */
  topic?: string
  /** 来源可信权重，缺省 1.0 */
  sourceWeight?: number
  publishedAt?: Date | null
}

export interface AiLayer {
  readonly env: AiDeps['env']
  readonly client: DeepSeekClient
  readonly budget: BudgetTracker
  readonly logger: AiLogger
  readonly prefilter: PrefilterState
  readonly enabled: boolean
  models(): ReturnType<DeepSeekClient['models']>
  /** 启动时调一次；失败非致命（spec §4.3） */
  probe(): ReturnType<DeepSeekClient['probe']>
  /** `POST /api/ai/verify` 的实现 */
  verify(input: VerifyInput): Promise<ItemScore>
  /** 批量三层过滤。阶段 4/5 的定时任务直接调它 */
  triage(options?: TriageOptions): Promise<TriageResult>
  /** `GET /api/ai/stats` 的实现 */
  stats(now?: Date): Promise<AiStats>
  /** Topic 表的只读快照，供 triage 默认使用 */
  loadCriteria(): Promise<TriageCriteria>
}

/** 把一段自由文本切成「标题 + 正文」。第一行当标题，其余当摘要。 */
export function splitText(
  text: string | undefined,
  url: string | undefined,
): { title: string; summary: string; url: string | null } {
  const body = (text ?? '').trim()
  if (body) {
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const title = lines[0] ?? body.slice(0, 120)
    const rest = lines.length > 1 ? lines.slice(1).join('\n') : body
    return { title: title.slice(0, 400), summary: rest, url: url ?? null }
  }

  if (url) {
    // 只有 URL 时用路径末段当标题，聊胜于无；L2 的 prompt 里 url 本身也是判断依据
    try {
      const parsed = new URL(url)
      const segment = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname
      return {
        title: decodeURIComponent(segment).replace(/[-_]+/g, ' ').slice(0, 400),
        summary: '',
        url,
      }
    } catch {
      return { title: url.slice(0, 400), summary: '', url }
    }
  }

  return { title: '', summary: '', url: null }
}

export function createAiLayer(deps: AiDeps): AiLayer {
  const logger = deps.logger ?? consoleAiLogger
  const budget = createBudgetTracker(deps.prisma, {
    limit: deps.env.AI_DAILY_TOKEN_BUDGET,
    now: deps.now,
  })
  const client = createDeepSeekClient({ ...deps, logger, budget })
  const prefilter = new PrefilterState()

  async function defaultTopic(): Promise<string> {
    try {
      const row = await deps.prisma.setting.findUnique({ where: { key: DOMAIN_SETTING_KEY } })
      const value = row?.value?.trim()
      return value || DEFAULT_TOPIC
    } catch {
      return DEFAULT_TOPIC
    }
  }

  async function verify(input: VerifyInput): Promise<ItemScore> {
    const now = deps.now ? deps.now() : new Date()
    const split = splitText(input.text, input.url)

    if (!split.title) {
      throw new Error('url 与 text 至少需要一个')
    }

    // 没有 key 就别往下走了：直接给一个明确的「能力不可用」，
    // 而不是让 L1 先失败一次、日志里留下一条看起来像 bug 的「批次失败」
    if (!client.enabled) {
      throw new AiUnavailableError(
        'NO_API_KEY',
        'DEEPSEEK_API_KEY 未配置，AI 能力不可用（补上 key 后无需改代码即可生效）',
      )
    }

    const topic = input.topic?.trim() || (await defaultTopic())

    // L1：这段内容是否「关于」该关键词
    const l1 = await runRelevance({ client, logger }, topic, [
      { id: 'target', title: split.title, summary: split.summary, url: split.url ?? '' },
    ])
    const relevance = l1.verdicts.get('target')?.relevance ?? 0
    const l1Reason = l1.verdicts.get('target')?.reason ?? ''

    // L2：真伪（可能抛 AiUnavailableError，交给路由映射成 503）
    const l2 = await runAuthenticity(
      { client, logger },
      {
        id: 'target',
        title: split.title,
        summary: split.summary,
        url: split.url,
        publishedAt: input.publishedAt ?? null,
        sourceName: 'verify',
      },
    )

    // L3：单条没有簇，sourceCount 固定 1
    const cross = computeConfidence({
      relevance,
      authenticity: l2.authenticity,
      sourceCount: 1,
      sourceWeight: input.sourceWeight ?? 1,
      ageHours: ageHoursOf({ publishedAt: input.publishedAt ?? null, fetchedAt: now, now }),
      flags: l2.flags,
    })

    const reasoning = [l1Reason, l2.reasoning].filter(Boolean).join('；')

    return {
      relevance,
      authenticity: l2.authenticity,
      confidence: cross.confidence,
      flags: l2.flags,
      reasoning,
      tier: cross.tier,
    }
  }

  return {
    env: deps.env,
    client,
    budget,
    logger,
    prefilter,
    enabled: client.enabled,
    models: () => client.models(),
    probe: () => client.probe(),
    verify,
    triage: (options) => runTriage({ ...deps, client, budget, prefilter, logger }, options),
    stats: (now) => budget.stats(now),
    loadCriteria: () => loadCriteriaFromTopics(deps.prisma),
  }
}

export { AiUnavailableError }
export type { TriageCriteria, TriageItemResult, TriageOptions, TriageResult }
export type { AiLogger, AiStats, ItemScore, AiFlag, Tier, AiState } from './types.js'
export { AI_FLAGS, normalizeFlags } from './types.js'
export { classifyTier, computeConfidence, TIER_PENDING_MIN, TIER_PUSH_MIN } from './crosscheck.js'
export { PrefilterState, prefilterItem } from './prefilter.js'
export { runTriage, loadCriteriaFromTopics } from './triage.js'
