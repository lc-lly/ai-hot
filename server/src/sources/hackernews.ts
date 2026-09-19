import { mapLimit } from '../util/concurrency.js'
import { truncate } from '../util/text.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

const API = 'https://hacker-news.firebaseio.com/v0'
const DEFAULT_LIMIT = 60
/** HN 的 item 接口是单个查询，限并发避免打爆对端 */
const ITEM_CONCURRENCY = 8

interface HnItem {
  id: number
  type?: string
  by?: string
  time?: number
  title?: string
  url?: string
  text?: string
  score?: number
  descendants?: number
}

function toRawItem(item: HnItem): RawItem {
  return {
    externalId: `hn:${item.id}`,
    url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
    title: item.title ?? '',
    summary: item.text ? truncate(item.text, 400) : null,
    author: item.by ?? null,
    publishedAt: item.time ? new Date(item.time * 1000) : null,
    lang: 'en',
    raw: item,
  }
}

export const hackernewsAdapter: SourceAdapter = {
  kind: 'hackernews',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const limit = Number(ctx.config.limit ?? DEFAULT_LIMIT)

    const res = await ctx.fetch(`${API}/topstories.json`)
    if (!res.ok) throw new Error(`hackernews topstories 返回 HTTP ${res.status}`)
    const ids = (await res.json()) as unknown
    if (!Array.isArray(ids)) throw new Error('hackernews topstories 返回的不是数组')

    const picked = ids.slice(0, limit).filter((x): x is number => typeof x === 'number')

    const items = await mapLimit(picked, ITEM_CONCURRENCY, async (id): Promise<HnItem | null> => {
      try {
        const r = await ctx.fetch(`${API}/item/${id}.json`)
        if (!r.ok) return null
        return (await r.json()) as HnItem | null
      } catch {
        // 单条失败不应拖垮整批；返回 null 由下游过滤
        return null
      }
    })

    return items
      .filter((i): i is HnItem => i !== null && i.type === 'story' && Boolean(i.title))
      .map(toRawItem)
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${API}/maxitem.json`)
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
