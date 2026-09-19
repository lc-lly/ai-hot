/**
 * 纯展示用的格式化。
 *
 * 旧版这里的 `asciiBar` / `heatBar` / `heatCell` / `pad` / `sourceTag`
 * 是为「单屏 ASCII 终端」写的，新版不用了（热度改用真实的互动数字 + 进度条）。
 * 保留下来的都是与视觉风格无关的纯函数。
 */

import type { ItemMetrics, MetricKey } from '../types.js'

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** `14:32` */
export function hhmmOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

export function dateTimeOf(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(
    d.getHours(),
  )}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * 相对时间。
 *
 * 中文而不是 `3h` 这种缩写——正文是 DM Sans 混中文，混一个英文缩写
 * 在卡片上会很突兀。
 */
export function agoOf(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return `${Math.floor(s / (86400 * 30))} 个月前`
}

/** 「还热着」的窗口。一小时内算新。 */
export const FRESH_WINDOW_MS = 60 * 60 * 1000

/**
 * 这条是不是「刚发生」的。
 *
 * 用来决定时间戳要不要被强调（变色 + 脉冲点）。判据是**发布时刻**，
 * 不是抓取时刻——抓取时刻只说明我们什么时候看到的，
 * 一条三年前的旧闻今天被抓到，不该长得像刚发生的。
 *
 * 未来的时间戳（时钟偏差、源站写错）**不算新**：`age >= 0` 那半边条件。
 * 否则一条 `publishedAt` 在明天的条目会永远挂着脉冲点。
 */
export function isFresh(iso: string | null, now = Date.now()): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  const age = now - t
  return age >= 0 && age < FRESH_WINDOW_MS
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return '—'
  }
}

const FLAG_LABEL: Record<string, string> = {
  clickbait: '标题党',
  ai_generated: '疑似 AI 生成',
  rumor: '传闻',
  stale: '旧闻',
  ad: '广告',
  unverified: '未证实',
}

export function flagLabel(flag: string): string {
  return FLAG_LABEL[flag] ?? flag
}

/**
 * 千分位分组：`1234` → `1,234`。
 *
 * 统计卡用它而**不用** `compactNum` 的缩写：那里显示的是「库里累计抓到多少
 * 条」，`1.2k` 会把这个数变得模糊，而它恰恰是页面上最该被读准的数字之一。
 *
 * 单独放在 `lib` 里而不是留在 `NumberTicker` 内部，是因为 `NumberTicker`
 * 现在是 `React.lazy` 加载的（见 `StatCards.tsx`）：Suspense 的 fallback
 * 需要在**不 import 那个 chunk** 的前提下渲染出**一模一样**的文本，
 * 否则数字会从 `1234` 跳成 `1,234`，闪一下。
 */
const grouper = new Intl.NumberFormat('zh-CN')

export function groupNum(n: number): string {
  return grouper.format(n)
}

/** 大数字缩写：`1234` → `1.2k`。卡片上的互动计数用它。 */
export function compactNum(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

/**
 * 互动计数的排列顺序与图标名。
 *
 * **顺序是固定的，但渲染时只取 `metrics` 里真实存在的键**——
 * 顺序固定是为了不同卡片之间同一指标总在同一位置（可以竖着扫），
 * 只取存在的键是为了不把「这个源不提供」渲染成「0」。
 */
export const METRIC_ORDER: ReadonlyArray<{ key: MetricKey; icon: string; label: string }> = [
  { key: 'points', icon: 'arrow-up', label: '点数' },
  { key: 'stars', icon: 'star', label: '今日 star' },
  { key: 'likes', icon: 'heart', label: '点赞' },
  { key: 'comments', icon: 'message-circle', label: '评论' },
  { key: 'replies', icon: 'message-circle', label: '回复' },
  { key: 'reposts', icon: 'repeat-2', label: '转发' },
  { key: 'quotes', icon: 'quote', label: '引用' },
  { key: 'views', icon: 'eye', label: '浏览' },
  { key: 'followers', icon: 'users', label: '粉丝' },
]

/** 按 `METRIC_ORDER` 排出「实际有值」的指标。空数组 = 这个源不提供互动数据。 */
export function orderedMetrics(
  metrics: ItemMetrics,
): Array<{ key: MetricKey; icon: string; label: string; value: number }> {
  const out: Array<{ key: MetricKey; icon: string; label: string; value: number }> = []
  for (const def of METRIC_ORDER) {
    const value = metrics[def.key]
    // `!== undefined` 而不是真值判断：**真实的 0 要显示**（HN 的 0 评论是真信息）
    if (value !== undefined) out.push({ ...def, value })
  }
  return out
}
