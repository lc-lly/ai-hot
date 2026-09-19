/** 一个数据源抓到的单条内容，已规范化。不含任何数据库层面的字段。 */
export interface RawItem {
  /** 源内稳定唯一的 ID，用于去重。约定带前缀，如 `hn:12345` */
  externalId: string
  url: string
  title: string
  summary: string | null
  author: string | null
  publishedAt: Date | null
  /** ISO 639-1，未知时 null */
  lang: string | null
  /** 源原始载荷，原样存库便于回溯 */
  raw: unknown
}

/**
 * adapter 的运行上下文。`fetch` 由调用方注入，
 * 因此测试可以传入假实现，adapter 永远不碰全局 fetch。
 */
export interface FetchContext {
  sourceId: string
  /** 来自 Source.config 的 JSON 解析结果 */
  config: Record<string, unknown>
  fetch: typeof globalThis.fetch
  now: Date
}

export interface SourceAdapter {
  /** 与 Source.kind 对应，全局唯一 */
  kind: string
  fetch(ctx: FetchContext): Promise<RawItem[]>
  health(ctx: FetchContext): Promise<{ ok: boolean; detail: string }>
}
