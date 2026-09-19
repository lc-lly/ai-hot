/**
 * 契约 §3 的共享类型在前端的镜像。
 * 刻意与 server 分开放置（前端不 import server 目录，契约 §5 的模块边界），
 * 两侧以 docs/plans/2026-09-15-phase-2-8-interface-contract.md 为准绳。
 *
 * **加字段的流程**：server 的 `score/dto.ts` → 这里 → `lib/normalize.ts`。
 * 漏掉第三步不会报任何错，字段只是在传输层蒸发——本仓库最难查的一类 bug。
 */

export type AiState = 'pending' | 'done' | 'skipped' | 'failed'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogChannel = 'fetch' | 'ai' | 'notify' | 'system'
export type Tier = 'push' | 'pending' | 'filtered'

/** 重要程度分档。卡片四色徽章、筛选栏、统计卡「紧急热点」共用。 */
export type Importance = 'urgent' | 'high' | 'medium' | 'low'

export const IMPORTANCE_LEVELS: readonly Importance[] = ['urgent', 'high', 'medium', 'low']

/**
 * 卡片上那行互动计数的键。**按源自适应**：
 * 这个源不提供的指标根本不会出现在对象里，前端只渲染存在的键。
 * rss 类源恒为空对象，此时那一行整个不渲染。
 */
export type MetricKey =
  | 'points'
  | 'comments'
  | 'stars'
  | 'likes'
  | 'reposts'
  | 'replies'
  | 'quotes'
  | 'views'
  | 'followers'

export const METRIC_KEYS: readonly MetricKey[] = [
  'points',
  'comments',
  'stars',
  'likes',
  'reposts',
  'replies',
  'quotes',
  'views',
  'followers',
]

export type ItemMetrics = Partial<Record<MetricKey, number>>

/**
 * 「条目 × 关键词」的命中结果，后端已塌缩成单值。
 *
 * **`relevance` 是 0..1，不是 0-100。** 展示时 ×100。
 * 参考项目用 0-100，照抄会出现「相关度 0%」且不报错。
 */
export interface ItemMatch {
  topicId: string
  topicName: string
  /** 0..1，未评估时为 null */
  relevance: number | null
  /** 0..1 */
  confidence: number | null
  /** true=直接提及 / false=间接相关 / null=AI 尚未判定 */
  isAbout: boolean | null
  reasoning: string | null
}

/** 契约 §3.1 */
export interface ItemDTO {
  id: string
  title: string
  url: string
  summary: string | null
  author: string | null
  lang: string | null
  publishedAt: string | null
  fetchedAt: string
  aiState: AiState
  source: { name: string; kind: string } | null
  /** 读时计算，0..1（契约 §3.3）。后端未上线时前端兜底 0.3 */
  heat: number
  /** 契约 §3.4。后端未上线时前端兜底 '其他' */
  domain: string
  authenticity: number | null
  flags: string[]
  reasoning: string | null

  // ---- 界面重建新增 ----

  /** **非空**：确定性算出来的，任何条目都有档位，前端不需要处理「没有重要度」 */
  importance: Importance
  /** 按源自适应，空对象合法（rss 类源） */
  metrics: ItemMetrics
  /** 同一件事被多个源报道时非空 */
  clusterId: string | null
  /** **null = 未评估**，不是「相关度为 0」。必须按三态渲染 */
  match: ItemMatch | null
}

/** 契约 §3.2 */
export interface NotificationDTO {
  id: string
  createdAt: string
  title: string
  body: string
  level: 'push' | 'pending'
  read: boolean
  itemId: string | null
  topicId: string | null
  channels: string[]
}

/** 契约 §2.1 的 `log` 消息 data；`/api/logs` 的元素也按这个形状解析 */
export interface LogDTO {
  id: string
  ts: string
  level: LogLevel
  channel: LogChannel
  message: string
  meta?: Record<string, unknown>
  /** 前端自己产生的调试行（WS 重连 / 轮询事件），用 ⌁ 与后端日志区分 */
  local?: boolean
}

/**
 * 统计卡。**五个字段与 `GET /api/stats` 及 WS 的 `stats` 消息完全同形**，
 * 后端两条路径共用 `computeStats`，所以不会漂移。
 */
export interface StatsDTO {
  /** 全库总数，**不受筛选影响** */
  total: number
  /** 近 24 小时新增（滚动窗口，不是「今天 00:00」） */
  today: number
  /** `importance = 'urgent'` 的条数 */
  urgent: number
  /** **启用中**的监控词数 */
  topicCount: number
  unread: number
}

export type NotifyPolicy = 'high_only' | 'all_confirmed' | 'digest'

export const NOTIFY_POLICIES: readonly NotifyPolicy[] = ['high_only', 'all_confirmed', 'digest']

export interface TopicDTO {
  id: string
  name: string
  include: string[]
  exclude: string[]
  /** 空数组 = 不限来源 */
  sourceKinds: string[]
  minConfidence: number
  notifyPolicy: NotifyPolicy
  enabled: boolean
  createdAt: string
  matchCount: number
}

export interface SourceDTO {
  id: string
  name: string
  kind: string
  lastOk: boolean | null
  lastRunAt: string | null
  lastError: string | null
}

/** 契约 §2.1 的统一信封 */
export interface Envelope {
  type: string
  ts: string
  data: Record<string, unknown>
}

/**
 * `GET /api/items` 的响应信封（**冻结**）。
 *
 * `pagination.total` 是**筛选后**的条数；统计卡的 `total` 是全库。
 * 两者语义不同，混用会让「统计卡说 62 条、下面写着共 20 条」看起来像 bug。
 */
export interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface ItemsResponse {
  data: ItemDTO[]
  pagination: Pagination
}

/** 图表/列表查询参数。前后端共用同一套方言，见 `server/src/routes/items.ts`。 */
export interface ItemQuery {
  page?: number
  pageSize?: number
  sort?: 'fetchedAt' | 'publishedAt' | 'heat' | 'importance' | 'authenticity'
  order?: 'asc' | 'desc'
  q?: string
  kind?: string
  sourceId?: string
  topicId?: string
  importance?: Importance
  domain?: string
  timeRange?: '1h' | '24h' | '7d' | '30d'
  authenticity?: 'real' | 'suspicious'
  excludeFlags?: string
}
