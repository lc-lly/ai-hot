import { domain as domainOf } from './domain.js'
import { heat as heatOf } from './heat.js'
import { importanceOf, isImportance } from './importance.js'
import { metricsOf } from './metrics.js'
import { AI_STATES, type AiState, type ItemDTO, type ItemMatch } from './types.js'

/**
 * `HotItem`（含 `source` 关联）→ 契约 §3.1 的 `ItemDTO`。
 *
 * 阶段 3 之外的人也会用：WS 广播 `item` 消息时（阶段 2 / 5）必须走这里，
 * 否则前端会同时收到两种形状的 item。
 */
export interface ItemRowInput {
  id: string
  title: string
  url: string
  summary?: string | null
  author?: string | null
  lang?: string | null
  publishedAt?: Date | string | null
  fetchedAt?: Date | string | null
  aiState?: string | null
  authenticity?: number | null
  /** `HotItem.aiFlags`，DB 里是 JSON 字符串 */
  aiFlags?: unknown
  /** `HotItem.aiReasoning` */
  aiReasoning?: string | null
  /** `HotItem.raw`，DB 里是 JSON 字符串 */
  raw?: unknown
  source?: { name: string; kind: string } | null
  /** 物化列；为 null/undefined 时现算兜底（见 `toItemDTO`） */
  heatScore?: number | null
  domain?: string | null
  importance?: string | null
  clusterId?: string | null
  /** `HotItem.matches`（含 topic 关联）。未 include 时是 undefined */
  matches?: readonly MatchRowInput[] | null
}

/** `Match` 行 + 其 `topic` 关联。 */
export interface MatchRowInput {
  topicId: string
  relevance?: number | null
  confidence?: number | null
  isAbout?: boolean | null
  reasoning?: string | null
  topic?: { name: string } | null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** 归一 `aiState` 到 schema 的四态之一，意外值一律当 `pending`。 */
export function toAiState(v: unknown): AiState {
  return typeof v === 'string' && (AI_STATES as readonly string[]).includes(v)
    ? (v as AiState)
    : 'pending'
}

/**
 * 解析 `aiFlags`。
 *
 * 阶段 2 还没跑时列值可能是 `"[]"`（schema 默认）、`null`，甚至已经解析好的数组，
 * 三种都要能吃下，且**任何异常输入都降级为 `[]` 而不是抛**——列表页不该因为一条脏数据整页 500。
 */
export function parseFlags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value !== 'string') return []

  const text = value.trim()
  if (text === '') return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** 0..1 的有限数，其余（含 null/NaN/越界）→ null。 */
function toUnit(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null
}

function toBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/**
 * 把 `Match[]` 塌缩成单值投影。
 *
 * ## 为什么要塌缩而不是给数组
 *
 * 一条 item 命中 3 个关键词时，「卡片该显示哪个相关度」这个问题会从后端
 * 漏到前端，每个组件都要重新回答一次。在这里回答一次就够了。
 *
 * ## `preferredTopicId` 存在的理由
 *
 * 用户按关键词 A 筛选时，卡片必须显示 **A 的**相关度，而不是全库最高的那条 B。
 * 少了这个参数就会出现「筛选了 A，卡片上写着 B 的相关度」——极难排查。
 */
function projectMatch(
  matches: readonly MatchRowInput[] | null | undefined,
  preferredTopicId: string | undefined,
): ItemMatch | null {
  if (!matches || matches.length === 0) return null

  const pick =
    preferredTopicId === undefined
      ? // 没有指定就取相关度最高的；relevance 为 null 的排最后
        [...matches].sort((a, b) => (toUnit(b.relevance) ?? -1) - (toUnit(a.relevance) ?? -1))[0]
      : matches.find((m) => m.topicId === preferredTopicId)

  if (!pick) return null

  return {
    topicId: pick.topicId,
    topicName: pick.topic?.name ?? '',
    relevance: toUnit(pick.relevance),
    confidence: toUnit(pick.confidence),
    // 三态：true/false 是 AI 的判定，null 是「还没来得及判」
    isAbout: toBool(pick.isAbout),
    reasoning: pick.reasoning ?? null,
  }
}

export interface ToItemOptions {
  /**
   * 当前查询是按哪个关键词筛的。传了就保证 `match` 返回**它**的那条，
   * 而不是全库相关度最高的那条。
   */
  preferredTopicId?: string
}

/**
 * 读时把一行 `HotItem` 组装成 `ItemDTO`。
 *
 * `heat` / `domain` / `importance` **优先取物化列**（那三个列是为 SQL 排序与
 * 筛选而存在的），列还没有值时现算兜底。两条路径同一套纯函数，
 * 所以物化与现算的结果必然一致。
 */
export function toItemDTO(row: ItemRowInput, opts: ToItemOptions = {}): ItemDTO {
  const summary = row.summary ?? null
  const source = row.source ? { name: row.source.name, kind: row.source.kind } : null
  const kind = source?.kind ?? null
  const flags = parseFlags(row.aiFlags)

  const heat =
    typeof row.heatScore === 'number' && Number.isFinite(row.heatScore)
      ? row.heatScore
      : heatOf(kind, row.raw)

  return {
    id: row.id,
    title: row.title,
    url: row.url,
    summary,
    author: row.author ?? null,
    lang: row.lang ?? null,
    publishedAt: toIso(row.publishedAt),
    fetchedAt: toIso(row.fetchedAt) ?? new Date(0).toISOString(),
    aiState: toAiState(row.aiState),
    source,

    heat,
    domain: row.domain ?? domainOf(row.title, summary),

    authenticity:
      typeof row.authenticity === 'number' && Number.isFinite(row.authenticity)
        ? row.authenticity
        : null,
    flags,
    reasoning: row.aiReasoning ?? null,

    importance: isImportance(row.importance) ? row.importance : importanceOf({ heat, flags }),
    metrics: metricsOf(kind, row.raw),
    clusterId: row.clusterId ?? null,
    match: projectMatch(row.matches, opts.preferredTopicId),
  }
}
