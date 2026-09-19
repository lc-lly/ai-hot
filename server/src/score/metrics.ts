/**
 * 原始互动计数 —— 卡片上那一行 `👍1.2k 💬88`。
 *
 * ## 为什么需要这个文件
 *
 * `score/heat.ts` 把原始互动量归一化成 0..1 的 `heat` 之后，**原始数值就丢了**。
 * 卡片既要「热度分」也要「真实数字」（用户更信 `1,234` 而不是 `0.62`），
 * 所以在这里按 kind 再取一次。
 *
 * ## 为什么是「按源自适应」而不是固定字段
 *
 * 各源能给的指标差别极大，实测：
 *
 * | kind              | 能取到什么                          |
 * |-------------------|-------------------------------------|
 * | `hackernews`      | `score`（点数）、`descendants`（评论） |
 * | `reddit`          | `score`（赞）、`num_comments`         |
 * | `github-trending` | `starsToday`（今日 star）             |
 * | `bilibili`        | `like` / `share` / `view` / `reply`  |
 * | `bilibili-search` | 同上，但**没有 `share`**              |
 * | `rss` / `baidu-hot` / `sogou-weixin` / `bing-search` | **什么都没有** |
 *
 * 参考项目卡片上那排饱满的互动数，靠的正是 Twitter / B站 / 微博这类天然带
 * 点赞转发浏览的源。接入 B站 之后我们才第一次真的填满了那一排；
 * 其余国内源（百度热搜、搜狗、Bing）仍然填不满，这是它们的接口决定的。
 *
 * 所以约定：**取不到就不出现在结果里，前端不渲染**。
 * 绝不要为了「看起来一样」而填 `0` —— `0` 会被读成「有 0 个赞」，
 * 而事实是「这个源不提供这个指标」。
 */

/**
 * 指标白名单。
 *
 * 只列已知的，未知 key 一律丢弃——`raw` 是外部输入，
 * 不能让它往 DTO 里塞任意字段。
 */
export const METRIC_KEYS = [
  'points',
  'comments',
  'stars',
  'likes',
  'reposts',
  'replies',
  'quotes',
  'views',
  'followers',
] as const

export type MetricKey = (typeof METRIC_KEYS)[number]

/** 只含「确实取到了值」的键。空对象 = 这个源不提供互动数据。 */
export type ItemMetrics = Partial<Record<MetricKey, number>>

function parseRaw(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null
  const value = typeof raw === 'string' ? safeJson(raw) : raw
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/** 数字，或是「看起来像数字的字符串」（`"1,234"` / `"1.2k"`）。其余 → null。 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const text = v.trim()
  if (text === '') return null

  const direct = Number(text)
  if (Number.isFinite(direct)) return direct

  // github-trending 存的是 "1,234 stars today" / "1.2k stars today" 这种文本
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([kK])?/.exec(text)
  if (!m?.[1]) return null
  const base = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(base)) return null
  return m[2] === undefined ? base : base * 1000
}

/** 取第一个能解析出数字的字段。 */
function firstNumber(
  payload: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = num(payload[key])
    if (value !== null) return value
  }
  return null
}

/** 按 kind 从 `raw` 提取互动计数。取不到的键不出现在返回值里。 */
export function metricsOf(kind: string | null | undefined, raw: unknown): ItemMetrics {
  const payload = parseRaw(raw)
  if (payload === null) return {}

  const out: ItemMetrics = {}
  const put = (key: MetricKey, value: number | null): void => {
    if (value !== null) out[key] = value
  }

  switch (kind) {
    case 'hackernews':
    // 搜索类与对应的采集类取同一批字段：适配器已经对齐过 `raw` 的形状
    case 'hn-algolia':
      put('points', firstNumber(payload, ['score', 'points']))
      put('comments', firstNumber(payload, ['descendants', 'num_comments']))
      break

    case 'reddit':
    case 'reddit-search':
      put('points', firstNumber(payload, ['score', 'ups']))
      put('comments', firstNumber(payload, ['num_comments']))
      break

    case 'github-trending':
      put('stars', firstNumber(payload, ['starsToday', 'stars']))
      break

    case 'github-search':
      // `github-search` 给的是总 star 数，与 trending 的「今日新增」不是一回事。
      // 卡片上写「★ 12.3k」时用户看到的是仓库总星数，这是对的。
      put('stars', firstNumber(payload, ['stars']))
      break

    // B站两兄弟。**必须显式列出来**：它们的字段名是 `like` / `share` / `view` /
    // `reply`，而下面 default 分支嗅探的是 `like_count` / `shares` / `view_count`——
    // 一个都对不上。不加这个 case，B站 卡片上那排数字会是空的，
    // 而互动阈值闸门（`pipeline/engagement.ts`）也会因为「取不到指标」
    // 而完全失效：它只在该源提供了指标时才判负，一个都取不到就一律放行。
    case 'bilibili':
    case 'bilibili-search':
      put('likes', firstNumber(payload, ['like']))
      put('reposts', firstNumber(payload, ['share']))
      put('views', firstNumber(payload, ['view']))
      put('replies', firstNumber(payload, ['reply']))
      break

    // 百度热搜**故意留空**。它确实带一个数（`hotScore`，量级 300 万~800 万），
    // 但那是百度自己的热度值，不是互动计数；放进 `points` 槽位会让卡片上出现
    // 一个挂着「点数」标签和箭头图标的数字，标签是错的。
    // 它只喂 `score/heat.ts`。显式写出来是为了让下一个人知道这是决定，不是遗漏。
    case 'baidu-hot':
      break

    default:
      // 未知 kind：仍然尝试通用字段，取不到就是空对象。
      // 这样新接的源只要 raw 里带了标准字段就能自动显示，不必改这里。
      put('points', firstNumber(payload, ['score', 'points', 'ups']))
      put('comments', firstNumber(payload, ['num_comments', 'descendants', 'comments']))
      put('stars', firstNumber(payload, ['starsToday', 'stars']))
      put('likes', firstNumber(payload, ['like_count', 'likes', 'favorite_count']))
      put('reposts', firstNumber(payload, ['retweet_count', 'reposts', 'shares']))
      put('replies', firstNumber(payload, ['reply_count', 'replies']))
      put('quotes', firstNumber(payload, ['quote_count', 'quotes']))
      put('views', firstNumber(payload, ['view_count', 'views', 'impressions']))
      put('followers', firstNumber(payload, ['followers', 'followers_count']))
      break
  }

  return out
}
