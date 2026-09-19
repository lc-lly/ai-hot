import type { NotifyPolicy } from '../types.js'

/**
 * 来源种类的**单一事实来源**。
 *
 * 这份清单是 `server/src/routes/topics.ts` 的 `SOURCE_KINDS` 白名单在前端的
 * 镜像——服务端拒绝清单外的值，前端不该把它当成自由文本输入框。
 *
 * 之所以单独成文件：筛选栏的下拉、监控词表单的勾选框、卡片上的来源标签
 * 都要用同一份。散着写必然漂移，而漂移的表现是「筛选栏里有这个源、
 * 监控词表单里却没有」，看起来像 bug 但不会报错。
 */
export interface SourceKindMeta {
  value: string
  label: string
  /** 采集类还是搜索类。搜索类只在搜索 Tab 用，不参与定时采集 */
  group: 'feed' | 'search'
  /** 一句话说明它是什么，给监控词表单做提示 */
  hint: string
}

export const SOURCE_KINDS: readonly SourceKindMeta[] = [
  { value: 'hackernews', label: 'Hacker News', group: 'feed', hint: '官方 Firebase API，免 key' },
  { value: 'github-trending', label: 'GitHub 趋势', group: 'feed', hint: '按日/周/月的 star 增长榜' },
  { value: 'reddit', label: 'Reddit', group: 'feed', hint: '公开 JSON 接口，免 key' },
  { value: 'rss', label: 'RSS 订阅', group: 'feed', hint: '任意 RSS/Atom 源，需在服务端配置地址' },
  { value: 'bilibili', label: 'B站热门', group: 'feed', hint: '综合热门榜，带点赞/转发/播放数' },
  { value: 'baidu-hot', label: '百度热搜', group: 'feed', hint: '全站热搜榜，按关键词过滤后入库' },
  { value: 'hn-algolia', label: 'HN 搜索', group: 'search', hint: '按关键词搜 HN 历史条目' },
  { value: 'reddit-search', label: 'Reddit 搜索', group: 'search', hint: '按关键词搜 Reddit' },
  { value: 'github-search', label: 'GitHub 搜索', group: 'search', hint: '搜仓库，免 key，有速率限制' },
  { value: 'bilibili-search', label: 'B站搜索', group: 'search', hint: '搜视频，带点赞/播放数；连打会被风控' },
  { value: 'sogou-weixin', label: '微信文章', group: 'search', hint: '搜狗微信文章搜索；结果链接几小时后会失效' },
  { value: 'bing-search', label: 'Bing 搜索', group: 'search', hint: '必应网页搜索的 RSS，免 key' },
]

/** 参与定时采集的源（不含搜索类）。监控词的「不限来源」指的是这一组。 */
export const FEED_KINDS = SOURCE_KINDS.filter((k) => k.group === 'feed')

export const KIND_LABELS: Record<string, string> = Object.fromEntries(
  SOURCE_KINDS.map((k) => [k.value, k.label]),
)

export const NOTIFY_POLICY_META: readonly { value: NotifyPolicy; label: string; hint: string }[] = [
  { value: 'high_only', label: '只推重要及以上', hint: 'urgent / high 才通知，噪音最小' },
  { value: 'all_confirmed', label: '全部已核实', hint: '只要过了真伪判定就通知' },
  { value: 'digest', label: '每日摘要', hint: '不即时推，攒成一条日报' },
]

export const NOTIFY_POLICY_LABELS: Record<string, string> = Object.fromEntries(
  NOTIFY_POLICY_META.map((p) => [p.value, p.label]),
)
