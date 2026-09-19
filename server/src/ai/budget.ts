import type { PrismaClient } from '@prisma/client'
import type { AiStats, UsageTotals } from './types.js'

/** spec §4.4：AI 结果按 prompt 哈希缓存，TTL 7 天 */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * DeepSeek 价格（美元 / 百万 token）。
 *
 * 这是**估算**，只用于成本面板的展示量级，不参与任何判定。
 * 官方调价时改这里即可；匹配不到就落到 DEFAULT_PRICING，
 * 宁可显示一个保守的估值，也不要因为模型改名让面板整块报错。
 */
const PRICING: ReadonlyArray<{ match: RegExp; inPerM: number; outPerM: number }> = [
  { match: /flash|fast|lite|chat|small|mini|v3/i, inPerM: 0.27, outPerM: 1.1 },
  { match: /pro|reason|max|v4|r1/i, inPerM: 0.55, outPerM: 2.19 },
]

const DEFAULT_PRICING = { inPerM: 0.5, outPerM: 1.5 }

export function pricingOf(model: string): { inPerM: number; outPerM: number } {
  for (const row of PRICING) if (row.match.test(model)) return row
  return DEFAULT_PRICING
}

export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const { inPerM, outPerM } = pricingOf(model)
  return (tokensIn / 1e6) * inPerM + (tokensOut / 1e6) * outPerM
}

/**
 * 极粗的 token 估算，只在 AI_MOCK=1 下用来往 `AiCall` 里记一个量级正确的数，
 * 好让成本面板与预算降级在离线测试里也能被验证。
 * 中文大约 1 token ≈ 1.5 字符，取 3 是偏保守（估多不估少）。
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3))
}

export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export interface AiCallRecord {
  purpose: string
  model: string
  promptHash: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  ok: boolean
  error?: string | null
  cached?: boolean
}

const EMPTY_TOTALS: UsageTotals = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }

export interface BudgetTracker {
  /** 今天的用量（带 30s 内存缓存，避免每次调用都打一次库） */
  usage(now?: Date): Promise<UsageTotals>
  byModel(now?: Date): Promise<Array<UsageTotals & { model: string }>>
  /** 今日已用 token >= 上限 */
  isDegraded(now?: Date): Promise<boolean>
  /** 写审计行并更新内存计数 */
  record(row: AiCallRecord): Promise<void>
  /** 供 `/api/ai/stats` 直接用 */
  stats(now?: Date): Promise<AiStats>
  /** 记一行「没花钱」的调用（缓存命中 / mock），token 计 0 */
  invalidate(): void
}

export function createBudgetTracker(
  prisma: PrismaClient,
  options: { limit: number; now?: () => Date; memoMs?: number },
): BudgetTracker {
  const now = options.now ?? (() => new Date())
  const memoMs = options.memoMs ?? 30_000
  let memo: { at: number; totals: UsageTotals; byModel: Array<UsageTotals & { model: string }> } | null =
    null

  async function load(clock: Date) {
    const ifStale = clock.getTime() - (memo?.at ?? 0) > memoMs
    if (memo && !ifStale) return memo

    const since = startOfDay(clock)
    const rows = await prisma.aiCall.findMany({
      where: { createdAt: { gte: since } },
      select: { model: true, promptTokens: true, completionTokens: true },
    })

    const totals: UsageTotals = { ...EMPTY_TOTALS }
    const perModel = new Map<string, UsageTotals & { model: string }>()
    for (const row of rows) {
      const tokensIn = row.promptTokens
      const tokensOut = row.completionTokens
      const costUsd = estimateCostUsd(row.model, tokensIn, tokensOut)

      totals.calls += 1
      totals.tokensIn += tokensIn
      totals.tokensOut += tokensOut
      totals.costUsd += costUsd

      const bucket = perModel.get(row.model) ?? { model: row.model, ...EMPTY_TOTALS }
      bucket.calls += 1
      bucket.tokensIn += tokensIn
      bucket.tokensOut += tokensOut
      bucket.costUsd += costUsd
      perModel.set(row.model, bucket)
    }

    memo = {
      at: clock.getTime(),
      totals,
      byModel: [...perModel.values()].sort((a, b) => b.calls - a.calls),
    }
    return memo
  }

  const usedTokens = (t: UsageTotals) => t.tokensIn + t.tokensOut

  return {
    async usage(clock) {
      return (await load(clock ?? now())).totals
    },

    async byModel(clock) {
      return (await load(clock ?? now())).byModel
    },

    async isDegraded(clock) {
      const snapshot = await load(clock ?? now())
      return usedTokens(snapshot.totals) >= options.limit
    },

    async record(row) {
      await prisma.aiCall.create({
        data: {
          purpose: row.purpose,
          model: row.model,
          promptHash: row.promptHash,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          latencyMs: row.latencyMs,
          ok: row.ok,
          error: row.error ?? null,
          cached: row.cached ?? false,
        },
      })
      // 记账后立刻让缓存失效，下一次 usage() 重新读库
      memo = null
    },

    invalidate() {
      memo = null
    },

    async stats(clock) {
      const at = clock ?? now()
      const snapshot = await load(at)
      const used = usedTokens(snapshot.totals)
      return {
        today: snapshot.totals,
        byModel: snapshot.byModel,
        budget: {
          limit: options.limit,
          used,
          degraded: used >= options.limit,
        },
      }
    },
  }
}
