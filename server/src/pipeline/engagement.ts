import { metricsOf, type MetricKey } from '../score/metrics.js'

/**
 * 互动阈值闸门 —— 「点赞 > 10 且 转发 > 5 且 浏览 > 500」。
 *
 * ## 为什么必须有这个文件，以及为什么它不是一道简单的 if
 *
 * 用户要的是「互动量太低的就别收」。难点在于：**这三个数只有极少数源提供**。
 * 实测的现状是
 *
 * | kind                                   | 能提供什么            |
 * |----------------------------------------|-----------------------|
 * | `bilibili` / `bilibili-search`          | like / share / view   |
 * | `hackernews` / `hn-algolia`             | points / comments     |
 * | `github-trending` / `github-search`     | stars                 |
 * | `rss` / `baidu-hot` / `sogou-weixin` / `bing-search` | **什么都没有** |
 *
 * 如果按字面执行「三项都必须 > 阈值」，那么除 B站 外的每一个源都会因为
 * 「拿不到点赞数」而被判负——库里最后只剩 B站 一个源，与用户「信息源太少」
 * 的诉求正好相反。
 *
 * 所以这里的口径是：**只在源确实提供了该项指标时才判负**。
 * 一个指标都没有的源（RSS、百度热搜…）直接放行。
 * 这是和用户确认过的取舍，不是实现时的偷懒。
 *
 * ## 为什么 AND 而不是 OR
 *
 * 用户明确要求「三项全满足」。后果要清楚：B站 热门榜上最低的一条
 * 也有 `like=8799 / share=191 / view=40135`，所以**这道闸门对热门榜
 * 几乎不过滤任何东西**（实测 50/50 全过）。它真正起作用的地方是
 * B站关键词搜索——那里能挡掉「播放几百、点赞个位数」的标题党。
 * 阈值可在源的 `config.engagement` 里逐源覆盖，需要收紧时不必改代码。
 *
 * ## 为什么返回原因字符串而不是 boolean
 *
 * `collect` 的日志与 `/api/sources/:id/collect` 的回执都要能回答
 * 「这轮为什么只入库了 3 条」。返回 `null | string` 让调用点第一次就能
 * 把原因带出去，不必为了写日志再算一遍。
 */

export interface EngagementThresholds {
  /** 点赞数下限，严格大于 */
  likes: number
  /** 转发数下限，严格大于 */
  reposts: number
  /** 浏览数下限，严格大于 */
  views: number
}

/** 用户拍定的默认值。 */
export const DEFAULT_ENGAGEMENT_THRESHOLDS: EngagementThresholds = {
  likes: 10,
  reposts: 5,
  views: 500,
}

/**
 * 参与判定的指标。
 *
 * 只有这三项。`metricsOf` 还能给出 `points` / `stars` / `comments` / `followers` 等，
 * 它们**不在这里**——HN 的点数、GitHub 的 star 与「点赞/转发/浏览」不是同一把尺子，
 * 拿 10 去卡 star 会把整个 GitHub 源清空。
 */
const GATED_METRICS: ReadonlyArray<{
  metric: MetricKey
  key: keyof EngagementThresholds
  label: string
}> = [
  { metric: 'likes', key: 'likes', label: '点赞' },
  { metric: 'reposts', key: 'reposts', label: '转发' },
  { metric: 'views', key: 'views', label: '浏览' },
]

/**
 * 从源的 config 里读阈值覆盖。`config.engagement` 可以是部分字段。
 * 读不到或读坏了都回落到默认值——阈值配错不该让整轮采集挂掉。
 */
export function readThresholds(config: Record<string, unknown>): EngagementThresholds {
  const raw = config.engagement
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return DEFAULT_ENGAGEMENT_THRESHOLDS
  }

  const patch = raw as Record<string, unknown>
  const pick = (key: keyof EngagementThresholds): number => {
    const value = Number(patch[key])
    return Number.isFinite(value) ? value : DEFAULT_ENGAGEMENT_THRESHOLDS[key]
  }

  return { likes: pick('likes'), reposts: pick('reposts'), views: pick('views') }
}

/**
 * 单条判定。通过返回 `null`，被拒返回可读原因。
 *
 * 「严格大于」按用户原话实现：`likes === 10` 是**不通过**的。
 *
 * @param kind       `Source.kind`
 * @param raw        `RawItem.raw`
 * @param thresholds 省略则用默认值
 */
export function checkEngagement(
  kind: string | null | undefined,
  raw: unknown,
  thresholds: EngagementThresholds = DEFAULT_ENGAGEMENT_THRESHOLDS,
): string | null {
  const metrics = metricsOf(kind, raw)

  const failures: string[] = []
  let judged = 0

  for (const rule of GATED_METRICS) {
    const value = metrics[rule.metric]
    // 这个源不提供这项指标 → 不判负。见文件头「只在确实提供了该项指标时才判负」
    if (value === undefined) continue

    judged += 1
    const min = thresholds[rule.key]
    // 写成 `!(value > min)` 而不是 `value <= min`：NaN 也会走到「不通过」，
    // 而 `metricsOf` 虽已过滤掉非有限数，这里的防御不该依赖上游不出错
    if (!(value > min)) failures.push(`${rule.label} ${value} ≤ ${min}`)
  }

  if (judged === 0) return null
  return failures.length === 0 ? null : failures.join('，')
}
