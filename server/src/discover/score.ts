import { clamp01 } from '../score/index.js'

/**
 * 自动热点发现的打分 —— **纯函数**，三维度：新颖度 / 热度 / 增速。
 *
 * spec §8 的 `discover`：「对配置领域内的 cluster 做新颖度 / 热度 / 增速打分，
 * 超阈值进发现页并推送」。三个维度刻意是三种不同的东西：
 *
 * | 维度 | 回答的问题 | 依据 |
 * |---|---|---|
 * | 新颖度 novelty | 这事是不是刚发生 | `Cluster.firstSeenAt` 距现在多久 |
 * | 热度   heat    | 有多少人在说  | 条目读时 `heat` 的峰值 + 独立来源数 + 条目数 |
 * | 增速   growth  | 是不是在发酵  | 最近 6 小时新增条目数 + 增量占比 |
 *
 * 只用这三个，不做 TF-IDF、不做趋势回归、不看历史基线——
 * spec 的定位是轻量工具，这套口径能解释、能手算、能在单测里写死。
 */

/** 新颖度半衰期：24 小时后新颖度减半。 */
export const NOVELTY_HALF_LIFE_HOURS = 24

/** 增速窗口：只看最近 6 小时新增了多少条。 */
export const GROWTH_WINDOW_HOURS = 6

/** 三维度权重，和为 1。 */
export const DISCOVER_WEIGHTS = {
  novelty: 0.4,
  heat: 0.35,
  growth: 0.25,
} as const

/** 进入发现页 / 触发推送的默认阈值。 */
export const DISCOVER_THRESHOLD = 0.55

/** 增速里「够快」的参照：窗口内新增 3 条即视为满速。 */
const GROWTH_FULL_ITEMS = 3

/** 热度里「够多来源」的参照：3 个独立来源即满分。 */
const HEAT_FULL_SOURCES = 3

/** 热度里「够多条目」的参照：5 条即满分。 */
const HEAT_FULL_ITEMS = 5

export interface DiscoverInput {
  itemCount: number
  /** 独立来源数（`Cluster.sourceCount`） */
  sourceCount: number
  /** 组内条目读时热度（契约 §3.3）的峰值 0..1 */
  maxHeat: number
  firstSeenAt: Date
  /** 落在 `GROWTH_WINDOW_HOURS` 窗口内的条目数 */
  recentItemCount: number
}

export interface DiscoverScore {
  /** 0..1 */
  novelty: number
  /** 0..1 */
  heat: number
  /** 0..1 */
  growth: number
  /** 0..1 加权合成 */
  score: number
  /** 用于 UI 展示的「多久前」 */
  ageHours: number
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** 指数半衰：`0.5 ** (ageHours / HALF_LIFE)`。未来时间按 0 小时处理。 */
export function noveltyOf(ageHours: number): number {
  if (!Number.isFinite(ageHours)) return 0
  return clamp01(0.5 ** (Math.max(0, ageHours) / NOVELTY_HALF_LIFE_HOURS))
}

/** 峰值热度 6 成 + 来源多样性 2.5 成 + 条目量 1.5 成。 */
export function heatOf(input: { maxHeat: number; sourceCount: number; itemCount: number }): number {
  const peak = clamp01(input.maxHeat)
  const sources = clamp01(Math.max(0, input.sourceCount) / HEAT_FULL_SOURCES)
  const volume = clamp01(Math.max(0, input.itemCount) / HEAT_FULL_ITEMS)
  return clamp01(0.6 * peak + 0.25 * sources + 0.15 * volume)
}

/**
 * 窗口内新增条数（饱和到 `GROWTH_FULL_ITEMS`）占 6 成，
 * 增量占总量比例占 4 成。前者量「有多少」，后者量「有多集中」——
 * 一个 50 条里新增 3 条的簇不该和一个 3 条全新的簇得到同样的增速。
 */
export function growthOf(input: { recentItemCount: number; itemCount: number }): number {
  const total = Math.max(1, Math.floor(input.itemCount))
  const recent = Math.max(0, Math.floor(input.recentItemCount))
  const burst = clamp01(recent / GROWTH_FULL_ITEMS)
  const ratio = clamp01(recent / total)
  return clamp01(0.6 * burst + 0.4 * ratio)
}

export function scoreCluster(input: DiscoverInput, now: Date): DiscoverScore {
  const ageMs = now.getTime() - input.firstSeenAt.getTime()
  const ageHours = Number.isFinite(ageMs) ? Math.max(0, ageMs / 3_600_000) : Number.POSITIVE_INFINITY

  const novelty = noveltyOf(ageHours)
  const heat = heatOf(input)
  const growth = growthOf(input)

  const score = clamp01(
    DISCOVER_WEIGHTS.novelty * novelty +
      DISCOVER_WEIGHTS.heat * heat +
      DISCOVER_WEIGHTS.growth * growth,
  )

  return {
    novelty: round3(novelty),
    heat: round3(heat),
    growth: round3(growth),
    score: round3(score),
    ageHours: Number.isFinite(ageHours) ? round3(ageHours) : Number.POSITIVE_INFINITY,
  }
}
