import { clamp01, round3, type AiFlag, type Tier } from './types.js'

/**
 * L3 —— 交叉验证（纯代码，零成本）。
 *
 * spec §4 的公式：`sourceCount × sourceWeight × recency → confidence`。
 * 直译过来就是：一条消息有多少个**独立**来源在说、这些来源有多可信、有多新。
 *
 * 三种因子加权成一个 0..1 的交叉验证分，再与 L1 的相关性、L2 的真伪分合成
 * 最终 `confidence`，按契约 §3.5 的阈值分流。
 *
 * 注意：`confidence` 与 `tier` 落在 `Match` 上是**阶段 4** 的事（契约 §6.2），
 * 本模块只产出纯函数结果，不写库。
 */

/** 契约 §3.5 冻结阈值 */
export const TIER_PUSH_MIN = 0.8
export const TIER_PENDING_MIN = 0.5

/** 新鲜度窗口：超过 72 小时视为不新鲜 */
export const RECENCY_WINDOW_HOURS = 72

const W_RELEVANCE = 0.35
const W_AUTHENTICITY = 0.35
const W_CROSS = 0.3

/** 来源权重 1.5 及以上即视为满分级可信（官方源 / 一线媒体） */
const WEIGHT_FULL = 1.5

/** 每个「负面标签」的置信度折扣 */
const FLAG_PENALTY_STEP = 0.15

/**
 * 参与惩罚的标签。
 * `stale` 与 `unverified` 刻意不在列：它们对置信度的影响已经体现在
 * L2 给出的低 `authenticity` 上，再罚一次等于同一件事扣两遍分。
 */
const PENALIZED_FLAGS: readonly AiFlag[] = ['clickbait', 'rumor', 'ad', 'ai_generated']

export function classifyTier(confidence: number): Tier {
  if (confidence >= TIER_PUSH_MIN) return 'push'
  if (confidence >= TIER_PENDING_MIN) return 'pending'
  return 'filtered'
}

/** 1 个来源 → 0.5；3 个及以上 → 1.0。单个来源不该直接满分，但也不能归零。 */
export function sourceFactorOf(sourceCount: number): number {
  // 拿不到簇信息时按「单来源」算，而不是按 0 算——0 会让缺数据看起来像「没人报道」
  if (!Number.isFinite(sourceCount)) return 0.5
  const n = Math.max(1, Math.floor(sourceCount))
  return clamp01(Math.log2(n + 1) / Math.log2(4))
}

export function weightFactorOf(sourceWeight: number): number {
  if (!Number.isFinite(sourceWeight)) return 0
  return clamp01(Math.max(0, sourceWeight) / WEIGHT_FULL)
}

export function recencyFactorOf(ageHours: number): number {
  if (!Number.isFinite(ageHours)) return 0
  return clamp01(1 - Math.max(0, ageHours) / RECENCY_WINDOW_HOURS)
}

export function flagPenaltyOf(flags: readonly AiFlag[]): number {
  const hits = flags.filter((f) => PENALIZED_FLAGS.includes(f)).length
  return clamp01(1 - FLAG_PENALTY_STEP * hits)
}

export interface AgeInput {
  publishedAt?: Date | null
  fetchedAt?: Date | null
  now?: Date
}

/**
 * 条目年龄（小时）。优先用发布时间；没有发布时间就退到抓取时间。
 * 发布时间在未来（源站时钟错乱）时按 0 处理——否则新鲜度会算出负分被钳死。
 */
export function ageHoursOf(input: AgeInput): number {
  const now = input.now ?? new Date()
  const basis = input.publishedAt ?? input.fetchedAt ?? null
  if (!basis) return Number.POSITIVE_INFINITY
  const diff = now.getTime() - basis.getTime()
  if (!Number.isFinite(diff)) return Number.POSITIVE_INFINITY
  return Math.max(0, diff / 3_600_000)
}

export interface CrossCheckInput {
  /** L1 相关性 0..1 */
  relevance: number
  /** L2 真伪 0..1 */
  authenticity: number
  /** 同一事件簇内的独立来源数；拿不到簇信息时传 1 */
  sourceCount: number
  /** 来源可信权重（`Source.weight`） */
  sourceWeight: number
  ageHours: number
  flags?: readonly AiFlag[]
}

export interface CrossCheckResult {
  confidence: number
  tier: Tier
  sourceFactor: number
  weightFactor: number
  recencyFactor: number
  /** 三因子合成的交叉验证分 */
  crossScore: number
  /** 标签折扣系数 */
  penalty: number
}

export function computeConfidence(input: CrossCheckInput): CrossCheckResult {
  const relevance = clamp01(input.relevance)
  const authenticity = clamp01(input.authenticity)
  const sourceFactor = sourceFactorOf(input.sourceCount)
  const weightFactor = weightFactorOf(input.sourceWeight)
  const recencyFactor = recencyFactorOf(input.ageHours)

  const crossScore = clamp01(
    0.5 * sourceFactor + 0.25 * weightFactor + 0.25 * recencyFactor,
  )
  const penalty = flagPenaltyOf(input.flags ?? [])

  const raw = W_RELEVANCE * relevance + W_AUTHENTICITY * authenticity + W_CROSS * crossScore
  const confidence = round3(clamp01(raw * penalty))

  return {
    confidence,
    tier: classifyTier(confidence),
    sourceFactor: round3(sourceFactor),
    weightFactor: round3(weightFactor),
    recencyFactor: round3(recencyFactor),
    crossScore: round3(crossScore),
    penalty: round3(penalty),
  }
}
