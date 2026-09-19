import { truncate } from '../util/text.js'
import { readQuery } from './query.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

/**
 * HN Algolia 搜索 —— **搜索类**适配器，不参与定时采集。
 *
 * 与 `hackernews.ts` 的区别：那个打的是官方 Firebase API（只能拿「此刻的前 N 名」），
 * 这个打的是 Algolia 的全文检索（能按关键词翻历史，且免 key、无限流）。
 * 两者抓到的条目在 `raw` 形状上刻意保持一致（`score` / `descendants`），
 * 于是 `score/heat.ts` 与 `score/metrics.ts` 对两者给出同样的热度与互动数。
 *
 * ## 为什么必须有 query 才请求
 *
 * 它注册在同一个 registry 里，`collect` 会遍历**所有启用的 Source**。
 * 没有 query 却照发请求的话，等于每 15 分钟往 Algolia 打一次空查询，
 * 还会把一堆与用户无关的热门条目灌进 `HotItem`。
 * 返回空数组 = 「这个源此刻没有内容」，而不是「失败了」。
 */

const ENDPOINT = 'https://hn.algolia.com/api/v1/search'
const DEFAULT_HITS = 30
/** 超过这个年份的命中没有时效价值，只会稀释结果 */
const DEFAULT_MAX_AGE_DAYS = 30

interface AlgoliaHit {
  objectID?: string
  title?: string
  story_title?: string
  url?: string
  story_url?: string
  author?: string
  created_at_i?: number
  points?: number
  num_comments?: number
  story_text?: string
  comment_text?: string
}

/** 解析 Algolia 的 `hits`。结构不符返回空数组（由调用方决定算不算失败）。 */
export function parseHits(payload: unknown): RawItem[] {
  const hits = (payload as { hits?: unknown } | null)?.hits
  if (!Array.isArray(hits)) return []

  const out: RawItem[] = []
  for (const raw of hits) {
    const hit = raw as AlgoliaHit
    const id = hit.objectID
    if (typeof id !== 'string' || id === '') continue

    // 评论命中的是 story_title（它属于某个故事），故事命中的是 title
    const title = (hit.title ?? hit.story_title ?? '').trim()
    if (title === '') continue

    // Ask HN / Show HN 这类自贴没有外部 url，回落到 HN 自己的讨论页——
    // 卡片上「打开原文」必须有个能点的地方
    const url = hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${id}`
    const body = (hit.story_text ?? hit.comment_text ?? '').trim()

    out.push({
      externalId: `hn:${id}`,
      url,
      title,
      summary: body === '' ? null : truncate(stripHtml(body), 400),
      author: hit.author ?? null,
      publishedAt: typeof hit.created_at_i === 'number' ? new Date(hit.created_at_i * 1000) : null,
      lang: 'en',
      // 与 `hackernews.ts` 的 raw 保持同样的字段名：heat / metrics 两个模块
      // 按 kind 取数，字段名一致才能给出同样的热度。见本文件头。
      raw: {
        score: typeof hit.points === 'number' ? hit.points : null,
        descendants: typeof hit.num_comments === 'number' ? hit.num_comments : null,
        hnId: id,
      },
    })
  }
  return out
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const hnAlgoliaAdapter: SourceAdapter = {
  kind: 'hn-algolia',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const query = readQuery(ctx)
    if (query === null) return []

    const hits = Number(ctx.config.hits ?? DEFAULT_HITS)
    const days = Number(ctx.config.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS)
    const since = Math.floor((ctx.now.getTime() - days * 86_400_000) / 1000)

    const url =
      `${ENDPOINT}?query=${encodeURIComponent(query)}` +
      `&tags=story&hitsPerPage=${Math.min(100, Math.max(1, hits))}` +
      `&numericFilters=created_at_i>${since}`

    const res = await ctx.fetch(url)
    if (!res.ok) throw new Error(`hn-algolia HTTP ${res.status}`)
    return parseHits(await res.json())
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${ENDPOINT}?query=test&tags=story&hitsPerPage=1`)
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
