/**
 * HTTP 数据层。所有对 `/api/*` 的调用都从这里走。
 *
 * ## 为什么单独一层
 *
 * 上一版把 `fetch` 散在各个 hook 里，结果是：查询串的拼法有三份、
 * 错误处理有两套（有的吞、有的抛）、`AbortSignal` 只在其中一处传了。
 * 集中之后这些差异不存在了。
 *
 * ## 两条规矩
 *
 * 1. **每个函数都接受 `AbortSignal`**。筛选栏快速改动时旧请求必须能取消，
 *    否则「先发的慢请求后到」会把新结果覆盖掉。
 * 2. **错误统一抛 `ApiError`**，带 `status` 与服务端给的 `code`。
 *    调用方据此区分「404 就是没有」和「500 是真出错了」。
 */

import {
  normalizeItems,
  normalizePagination,
  normalizeStats,
  normalizeTopics,
  normalizeTopic,
} from '../lib/normalize.js'
import type {
  ItemDTO,
  ItemQuery,
  NotificationDTO,
  Pagination,
  StatsDTO,
  TopicDTO,
} from '../types.js'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 把 `ItemQuery` 拼成查询串。空值一律省略，不发 `?kind=` 这种空参数。 */
export function itemQueryString(q: ItemQuery): string {
  const p = new URLSearchParams()
  for (const [key, value] of Object.entries(q)) {
    if (value === undefined || value === null || value === '') continue
    p.set(key, String(value))
  }
  return p.toString()
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    })
  } catch (err) {
    // 网络层失败（后端没起、断网、被 abort）。abort 要让调用方原样看到
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, 'NETWORK', '连不上后端服务，请确认它已经启动')
  }

  // 204 没有 body
  if (res.status === 204) return null

  let body: unknown = null
  const text = await res.text()
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      throw new ApiError(res.status, 'BAD_JSON', `服务端返回了非 JSON 内容（${res.status}）`)
    }
  }

  if (!res.ok) {
    const errObj =
      typeof body === 'object' && body !== null
        ? (body as { error?: { code?: unknown; message?: unknown } }).error
        : undefined
    throw new ApiError(
      res.status,
      typeof errObj?.code === 'string' ? errObj.code : 'HTTP_ERROR',
      typeof errObj?.message === 'string' ? errObj.message : `请求失败（${res.status}）`,
    )
  }

  return body
}

export interface PageResult {
  items: ItemDTO[]
  pagination: Pagination
}

/**
 * 条目分页查询。
 *
 * 响应信封是 `{ data, pagination }`。这里**先归一化成 `items` 再返回**——
 * 组件不该知道传输层的字段名，那是契约的细节，不是 UI 的词汇。
 */
export async function fetchItems(query: ItemQuery, signal?: AbortSignal): Promise<PageResult> {
  const qs = itemQueryString(query)
  const body = await request(`/api/items${qs ? `?${qs}` : ''}`, { signal })
  const items = normalizeItems(body)
  const pagination = normalizePagination(
    typeof body === 'object' && body !== null ? (body as { pagination?: unknown }).pagination : undefined,
    items.length,
  )
  return { items, pagination }
}

export async function fetchStats(signal?: AbortSignal): Promise<StatsDTO | null> {
  return normalizeStats(await request('/api/stats', { signal }))
}

/** 站外搜索里单个源的执行结果。**失败要显示出来**，不能只是少了几个结果。 */
export interface SearchSourceReport {
  kind: string
  ok: boolean
  /** 过滤之后真正返回的条数 */
  count: number
  /** 被互动阈值挡掉的条数（点赞/转发/浏览不达标）。多数源恒为 0 */
  filtered: number
  ms: number
  error: string | null
}

export interface ExternalSearchResult {
  items: ItemDTO[]
  sources: SearchSourceReport[]
  /** 命中服务端 60 秒缓存。界面上可以据此说明「这是刚才那次的结果」 */
  cached: boolean
}

/**
 * 站外搜索（`/api/search`）。
 *
 * 与 `fetchItems` 的区别不只是端点：`fetchItems` 返回的是**库里带 AI 结论**的
 * 条目，这里返回的是**站外此刻**的结果，没有真伪判定、没有相关度——
 * 它们从来没被 AI 评过。卡片上那几个位置因此必须走「未评估」的渲染分支。
 *
 * 一次请求会同时打两三个站外 API，所以它比 `fetchItems` 慢得多（秒级）。
 * 调用方要按「这是慢操作」来设计交互，不能边打字边搜。
 */
export async function searchExternal(
  q: string,
  signal?: AbortSignal,
): Promise<ExternalSearchResult> {
  const body = await request(`/api/search?q=${encodeURIComponent(q)}`, { signal })
  const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}

  const sources: SearchSourceReport[] = []
  if (Array.isArray(rec['sources'])) {
    for (const entry of rec['sources']) {
      if (typeof entry !== 'object' || entry === null) continue
      const r = entry as Record<string, unknown>
      if (typeof r['kind'] !== 'string') continue
      sources.push({
        kind: r['kind'],
        ok: r['ok'] !== false,
        count: typeof r['count'] === 'number' ? r['count'] : 0,
        filtered: typeof r['filtered'] === 'number' ? r['filtered'] : 0,
        ms: typeof r['ms'] === 'number' ? r['ms'] : 0,
        error: typeof r['error'] === 'string' ? r['error'] : null,
      })
    }
  }

  return { items: normalizeItems(body), sources, cached: rec['cached'] === true }
}

export async function fetchTopics(signal?: AbortSignal): Promise<TopicDTO[]> {
  return normalizeTopics(await request('/api/topics', { signal }))
}

export interface TopicInput {
  name: string
  include: string[]
  exclude: string[]
  sourceKinds: string[]
  minConfidence: number
  notifyPolicy: TopicDTO['notifyPolicy']
  enabled?: boolean
}

export async function createTopic(input: TopicInput): Promise<TopicDTO | null> {
  const body = await request('/api/topics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return normalizeTopic(typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : null)
}

export async function updateTopic(id: string, patch: Partial<TopicInput>): Promise<TopicDTO | null> {
  const body = await request(`/api/topics/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return normalizeTopic(typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : null)
}

export async function deleteTopic(id: string): Promise<void> {
  await request(`/api/topics/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface JobOutcome {
  name: string
  ok: boolean
  skipped: boolean
  skipReason: string | null
  error: string | null
  durationMs: number
}

/**
 * 手动触发一次定时任务。
 *
 * **`skipped` 是一等公民，不是异常情况**：上一轮还在跑时服务端直接返回
 * `{skipped:true}`（不排队）。调用方必须把这个状态展示出来，
 * 否则用户点了「立即扫描」看到转圈突然停下、数据没变，会以为按钮坏了。
 * 扫描是分钟级的，撞上「上一轮还没跑完」是常态。
 */
export async function runJob(name: string): Promise<JobOutcome> {
  const body = await request(`/api/jobs/${encodeURIComponent(name)}/run`, { method: 'POST' })
  const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  return {
    name: typeof rec['name'] === 'string' ? rec['name'] : name,
    ok: rec['ok'] !== false,
    skipped: rec['skipped'] === true,
    skipReason: typeof rec['skipReason'] === 'string' ? rec['skipReason'] : null,
    error: typeof rec['error'] === 'string' ? rec['error'] : null,
    durationMs: typeof rec['durationMs'] === 'number' ? rec['durationMs'] : 0,
  }
}

/** 服务端 `/api/notifications` 的元素形状与 `NotificationDTO` 一致，这里只做防御性解析。 */
export async function fetchNotifications(signal?: AbortSignal): Promise<NotificationDTO[]> {
  const body = await request('/api/notifications', { signal })
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : []

  const out: NotificationDTO[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const r = entry as Record<string, unknown>
    if (typeof r['id'] !== 'string' || typeof r['title'] !== 'string') continue
    out.push({
      id: r['id'],
      createdAt: typeof r['createdAt'] === 'string' ? r['createdAt'] : new Date().toISOString(),
      title: r['title'],
      body: typeof r['body'] === 'string' ? r['body'] : '',
      level: r['level'] === 'push' ? 'push' : 'pending',
      read: r['read'] === true,
      itemId: typeof r['itemId'] === 'string' ? r['itemId'] : null,
      topicId: typeof r['topicId'] === 'string' ? r['topicId'] : null,
      channels: Array.isArray(r['channels'])
        ? (r['channels'] as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
    })
  }
  return out
}

export async function markAllRead(): Promise<void> {
  await request('/api/notifications/read-all', { method: 'POST' })
}

export async function markRead(id: string): Promise<void> {
  await request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' })
}
