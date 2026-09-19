/**
 * 防御性解析层。
 *
 * 存在的理由：`heat` / `domain` / `authenticity` / `flags` / `reasoning`
 * 由并行的后端 agent 补齐，前端开发期间这些字段大概率缺席；
 * WS 的 `item` 消息与 `/api/items` 的元素也不保证字段完全一致。
 * 前端的规矩是：**任何字段缺失都降级成默认值，绝不抛错、绝不白屏**。
 * 默认值取自契约 §3.3（heat 取不到给 0.3 而不是 0）与 §3.4（domain 兜底 `其他`）。
 */

import {
  IMPORTANCE_LEVELS,
  METRIC_KEYS,
  NOTIFY_POLICIES,
  type AiState,
  type Importance,
  type ItemDTO,
  type ItemMatch,
  type ItemMetrics,
  type LogChannel,
  type LogDTO,
  type LogLevel,
  type MetricKey,
  type NotifyPolicy,
  type Pagination,
  type StatsDTO,
  type TopicDTO,
} from '../types.js'

export const DEFAULT_HEAT = 0.3
export const DEFAULT_DOMAIN = '其他'

/**
 * `importance` 缺席时的兜底。
 *
 * 后端保证它非空，所以这个分支只在「前端比后端新」时才会走到。
 * 选 `medium` 而不是 `low`，是为了与 `DEFAULT_HEAT = 0.3` 保持一致：
 * 0.3 正好落在 medium 档（见 `server/src/score/importance.ts` 的 BANDS）。
 * 不知道的时候站在中间，既不惊动也不轻饶。
 */
export const DEFAULT_IMPORTANCE: Importance = 'medium'

const AI_STATES: readonly AiState[] = ['pending', 'done', 'skipped', 'failed']
const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
const CHANNELS: readonly LogChannel[] = ['fetch', 'ai', 'notify', 'system']
const KNOWN_FLAGS = ['clickbait', 'ai_generated', 'rumor', 'stale', 'ad', 'unverified']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function iso(v: unknown, fallback: string | null): string | null {
  const s = str(v)
  if (!s) return fallback
  return Number.isNaN(new Date(s).getTime()) ? fallback : s
}

/** 0..1 区间内的数，越界裁剪；取不到时用 provided 默认 */
function unit(v: unknown, fallback: number): number {
  const n = num(v)
  if (n === null) return fallback
  return Math.min(1, Math.max(0, n))
}

export function normalizeFlags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const f of v) {
    if (typeof f === 'string' && KNOWN_FLAGS.includes(f) && !out.includes(f)) out.push(f)
  }
  return out
}

export function normalizeImportance(v: unknown): Importance {
  return typeof v === 'string' && (IMPORTANCE_LEVELS as readonly string[]).includes(v)
    ? (v as Importance)
    : DEFAULT_IMPORTANCE
}

/**
 * 互动计数。
 *
 * **两条不变的规矩**：
 * 1. 只保留白名单里的键——`metrics` 来自后端的 `raw`（外部输入），
 *    不放任它往 DTO 里塞任意字段；
 * 2. **缺失的键不补 0**。`{points: 0}` 会被渲染成「0 赞」，而事实是
 *    「这个源不提供点赞数」。空对象是合法的，调用方据此整行不渲染。
 *
 * 但**真实的 0 要保留**：HN 的 `descendants: 0` 就是「确实没人评论」，
 * 那是真信息，与「取不到」不是一回事。
 */
export function normalizeMetrics(v: unknown): ItemMetrics {
  if (!isRecord(v)) return {}
  const out: ItemMetrics = {}
  for (const key of METRIC_KEYS) {
    const n = num(v[key])
    if (n !== null && n >= 0) out[key as MetricKey] = Math.round(n)
  }
  return out
}

/**
 * 「条目 × 关键词」的命中投影。
 *
 * **返回 null 表示「未评估」，不是「相关度为 0」。** 这个区别必须一路带到
 * 渲染层：把 null 显示成 `0%` 会被读成「AI 认真评估后认为无关」，
 * 而事实是「根本没评估」。所以这里对缺失的 `relevance` 保留 `null`，
 * 不用 0 顶替。
 */
export function normalizeMatch(v: unknown): ItemMatch | null {
  if (!isRecord(v)) return null
  const topicId = str(v['topicId'])
  if (!topicId) return null

  const rel = num(v['relevance'])
  const conf = num(v['confidence'])
  const about = v['isAbout']

  return {
    topicId,
    topicName: str(v['topicName']) ?? '',
    relevance: rel === null ? null : Math.min(1, Math.max(0, rel)),
    confidence: conf === null ? null : Math.min(1, Math.max(0, conf)),
    // 三态：只有真的是布尔的才认，其余（含 undefined）一律 null
    isAbout: typeof about === 'boolean' ? about : null,
    reasoning: str(v['reasoning']),
  }
}

function nonNegInt(v: unknown, fallback: number): number {
  const n = num(v)
  return n === null ? fallback : Math.max(0, Math.round(n))
}

/** 单条 ItemDTO。缺 id 或 title 视为坏数据，返回 null 由调用方丢弃。 */
export function normalizeItem(raw: unknown): ItemDTO | null {
  if (!isRecord(raw)) return null
  const id = str(raw['id'])
  const title = str(raw['title'])
  if (!id || !title) return null

  const sourceRaw = raw['source']
  const source =
    isRecord(sourceRaw) && str(sourceRaw['name'])
      ? {
          name: str(sourceRaw['name']) ?? '',
          kind: str(sourceRaw['kind']) ?? '',
        }
      : null

  const aiStateRaw = str(raw['aiState'])
  const aiState =
    aiStateRaw && (AI_STATES as readonly string[]).includes(aiStateRaw)
      ? (aiStateRaw as AiState)
      : 'pending'

  const auth = num(raw['authenticity'])

  return {
    id,
    title,
    url: str(raw['url']) ?? '',
    summary: str(raw['summary']),
    author: str(raw['author']),
    lang: str(raw['lang']),
    publishedAt: iso(raw['publishedAt'], null),
    fetchedAt: iso(raw['fetchedAt'], new Date().toISOString()) ?? new Date().toISOString(),
    aiState,
    source,
    heat: unit(raw['heat'], DEFAULT_HEAT),
    domain: str(raw['domain']) ?? DEFAULT_DOMAIN,
    authenticity: auth === null ? null : Math.min(1, Math.max(0, auth)),
    flags: normalizeFlags(raw['flags']),
    reasoning: str(raw['reasoning']),

    importance: normalizeImportance(raw['importance']),
    metrics: normalizeMetrics(raw['metrics']),
    clusterId: str(raw['clusterId']),
    match: normalizeMatch(raw['match']),
  }
}

/**
 * 分页信封。
 *
 * `totalPages` 后端已保证 >= 1（空结果也是「第 1/1 页」而不是「第 1/0 页」），
 * 但前端仍然重算一遍兜底——它要拿去渲染「第 x / y 页」，
 * 一个 0 会让文案变成「第 1 / 0 页」。
 */
export function normalizePagination(v: unknown, itemCount: number): Pagination {
  const rec = isRecord(v) ? v : {}
  const pageSize = Math.max(1, nonNegInt(rec['pageSize'], itemCount > 0 ? itemCount : 20))
  const total = nonNegInt(rec['total'], itemCount)
  return {
    page: Math.max(1, nonNegInt(rec['page'], 1)),
    pageSize,
    total,
    totalPages: Math.max(1, nonNegInt(rec['totalPages'], Math.ceil(total / pageSize) || 1)),
  }
}

/** 监控词。`include`/`exclude`/`sourceKinds` 后端已解析成数组，这里再兜一层。 */
export function normalizeTopic(raw: unknown): TopicDTO | null {
  if (!isRecord(raw)) return null
  const id = str(raw['id'])
  const name = str(raw['name'])
  if (!id || !name) return null

  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []

  const policy = str(raw['notifyPolicy'])
  const conf = num(raw['minConfidence'])

  return {
    id,
    name,
    include: list(raw['include']),
    exclude: list(raw['exclude']),
    sourceKinds: list(raw['sourceKinds']),
    minConfidence: conf === null ? 0.5 : Math.min(1, Math.max(0, conf)),
    notifyPolicy:
      policy && (NOTIFY_POLICIES as readonly string[]).includes(policy)
        ? (policy as NotifyPolicy)
        : 'high_only',
    enabled: raw['enabled'] !== false,
    createdAt: iso(raw['createdAt'], null) ?? new Date().toISOString(),
    matchCount: nonNegInt(raw['matchCount'], 0),
  }
}

export function normalizeTopics(raw: unknown): TopicDTO[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw['data'])
      ? (raw['data'] as unknown[])
      : isRecord(raw) && Array.isArray(raw['topics'])
        ? (raw['topics'] as unknown[])
        : []
  const out: TopicDTO[] = []
  for (const entry of list) {
    const topic = normalizeTopic(entry)
    if (topic) out.push(topic)
  }
  return out
}

export function normalizeItems(raw: unknown): ItemDTO[] {
  // 兼容 `{ items: [...] }` / `{ data: [...] }` / 裸数组三种形状
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw['items'])
      ? (raw['items'] as unknown[])
      : isRecord(raw) && Array.isArray(raw['data'])
        ? (raw['data'] as unknown[])
        : []
  const out: ItemDTO[] = []
  for (const entry of list) {
    const item = normalizeItem(entry)
    if (item) out.push(item)
  }
  return out
}

let localLogSeq = 0

/** 前端自己产生的日志行（WS / 轮询事件），channel 固定 system */
export function localLog(level: LogLevel, message: string): LogDTO {
  localLogSeq += 1
  return {
    id: `local-${Date.now()}-${localLogSeq}`,
    ts: new Date().toISOString(),
    level,
    channel: 'system',
    message,
    local: true,
  }
}

/**
 * 单条日志。`/api/logs` 的元素形状契约只说是「最近日志」，
 * 所以 id / ts / level / channel 全部容错。
 */
export function normalizeLog(raw: unknown, index: number): LogDTO | null {
  if (!isRecord(raw)) {
    if (typeof raw === 'string') {
      return {
        id: `srv-str-${index}-${raw.slice(0, 12)}`,
        ts: new Date().toISOString(),
        level: 'info',
        channel: 'system',
        message: raw,
      }
    }
    return null
  }

  const levelRaw = str(raw['level'])
  const channelRaw = str(raw['channel'])
  const level =
    levelRaw && (LEVELS as readonly string[]).includes(levelRaw) ? (levelRaw as LogLevel) : 'info'
  const channel =
    channelRaw && (CHANNELS as readonly string[]).includes(channelRaw)
      ? (channelRaw as LogChannel)
      : 'system'

  const message =
    str(raw['message']) ?? str(raw['msg']) ?? str(raw['text']) ?? JSON.stringify(raw).slice(0, 200)

  const ts = iso(raw['ts'], null) ?? iso(raw['createdAt'], null) ?? new Date().toISOString()
  const id = str(raw['id']) ?? `srv-${ts}-${index}-${message.slice(0, 16)}`

  const meta = isRecord(raw['meta']) ? (raw['meta'] as Record<string, unknown>) : undefined
  return meta ? { id, ts, level, channel, message, meta } : { id, ts, level, channel, message }
}

export function normalizeLogs(raw: unknown): LogDTO[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw['logs'])
      ? (raw['logs'] as unknown[])
      : isRecord(raw) && Array.isArray(raw['items'])
        ? (raw['items'] as unknown[])
        : []
  const out: LogDTO[] = []
  for (let i = 0; i < list.length; i += 1) {
    const log = normalizeLog(list[i], i)
    if (log) out.push(log)
  }
  return out
}

/**
 * 统计卡。
 *
 * 旧版是 `{pending, todayMatches, tokensToday}`——那三个字段与新卡片的
 * 四个数字**一个都对不上**。改形状时如果漏改这里，`normalizeStats` 会因为
 * 找不到 `pending` 而返回 null，整个对象被静默丢弃，四张卡永远是 0。
 *
 * 所以现在的锚点是 `total`：它必然存在，也必然是个数。
 */
export function normalizeStats(raw: unknown): StatsDTO | null {
  if (!isRecord(raw)) return null
  const total = num(raw['total'])
  if (total === null) return null
  return {
    total: Math.max(0, Math.round(total)),
    today: nonNegInt(raw['today'], 0),
    urgent: nonNegInt(raw['urgent'], 0),
    topicCount: nonNegInt(raw['topicCount'], 0),
    unread: nonNegInt(raw['unread'], 0),
  }
}
