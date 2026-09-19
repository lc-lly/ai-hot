import type { Importance } from './importance.js'
import type { ItemMetrics } from './metrics.js'

/**
 * 契约 §3.1 冻结的 `ItemDTO`。
 *
 * 它同时是 `GET /api/items` 的元素和 WS `item` 消息的 `data`——
 * 两处必须是同一个形状，所以类型只在这里定义一次。
 *
 * **唯一映射点是 `score/dto.ts` 的 `toItemDTO`。** 加字段只改那里，
 * HTTP 与 WS 两条路径自动同步。
 */
export interface ItemDTO {
  id: string
  title: string
  url: string
  summary: string | null
  author: string | null
  lang: string | null
  /** ISO 8601 */
  publishedAt: string | null
  /** ISO 8601 */
  fetchedAt: string
  /** 与 schema 的 HotItem.aiState 一致 */
  aiState: AiState
  source: { name: string; kind: string } | null

  // 阶段 3 新增，用于雷达盘与热点流。两者都在**读时计算**，不落库
  /** 0..1，见契约 §3.3 */
  heat: number
  /** 领域分类，见契约 §3.4 */
  domain: string

  // 条目级真伪判定（阶段 2 产出）。未评分时三者分别为 null / [] / null
  /** 0..1 */
  authenticity: number | null
  /** clickbait | ai_generated | rumor | stale | ad | unverified */
  flags: string[]
  /** AI 给出的理由，低置信时必须保留（spec §4.2） */
  reasoning: string | null

  // ---- 阶段 6（界面重建）新增 ----

  /**
   * 重要程度分档。卡片的四色首要徽章、筛选栏的「重要程度」、
   * 统计卡的「紧急热点」都用它。见 `score/importance.ts`。
   *
   * **非空**（不像 `authenticity` 可以为 null）：它是确定性算出来的，
   * 任何条目都有档位。前端不需要处理「没有重要度」的分支。
   */
  importance: Importance

  /**
   * 原始互动计数（点数/评论/star…）。**按源自适应**：
   * 这个源不提供的指标不会出现在对象里，前端只渲染存在的键。
   * 空对象 `{}` 是合法且常见的（rss 类源恒为空）。
   */
  metrics: ItemMetrics

  /** 事件簇。同一件事被多个源报道时非空。未聚类时为 null。 */
  clusterId: string | null

  /**
   * 「条目 × 关键词」的命中结果，**扁平化投影成单值**。
   *
   * 为什么不直接给 `matches: Match[]`：一条 item 命中 3 个关键词时，
   * 「卡片该显示哪个相关度」这个问题会从后端漏到前端，
   * 每个组件都要重新回答一次。在这里塌缩成 bestMatch 就只回答一次。
   *
   * **为 null = 未评估**，不是「相关度为 0」。前端必须按三态渲染：
   * 未评估 / 间接相关 / 直接提及。把 null 显示成 `0%` 是错的——
   * `0` 会被读成「AI 认真评估后认为无关」，而事实是「根本没评估」。
   * 这与 `heat` 取不到给 `0.3` 而不是 `0` 是同一条原则。
   */
  match: ItemMatch | null
}

/**
 * `Match` 的对外投影。
 *
 * 字段来源：`Match.relevance` / `confidence` / `reasoning` /
 * `isAbout`（阶段 3 新增列）+ `Topic.name`。
 */
export interface ItemMatch {
  topicId: string
  topicName: string
  /** 0..1。**与前端展示的 0-100 不同**，前端负责 ×100。 */
  relevance: number | null
  /** 0..1 */
  confidence: number | null
  /**
   * `true` = 直接提及（AI 判定「主旨就是关于它」）/ `false` = 间接相关 /
   * `null` = AI 尚未判定这一点。
   *
   * 注意语义是 `aboutKeywords`（主旨关于），**不是** `matchedKeywords`
   * （字面出现过）。后者会让卡片说「直接提及」而 AI 的真实判定
   * 只是「顺带提了一句」。
   */
  isAbout: boolean | null
  /** AI 给出的相关性理由 */
  reasoning: string | null
}

export type AiState = 'pending' | 'done' | 'skipped' | 'failed'

export const AI_STATES: readonly AiState[] = ['pending', 'done', 'skipped', 'failed']

/** 条目级真伪标记的全集，契约 §3.1 / §3.2 冻结。 */
export const AI_FLAGS: readonly string[] = [
  'clickbait',
  'ai_generated',
  'rumor',
  'stale',
  'ad',
  'unverified',
]
