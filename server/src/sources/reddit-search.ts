import { readQuery } from './query.js'
import { parseListing } from './reddit.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

/**
 * Reddit 全站搜索 —— **搜索类**适配器，不参与定时采集。
 *
 * 与 `reddit.ts` 的区别只有一个：那个按 subreddit 拉 hot 榜，这个按关键词
 * 搜全站。**返回结构完全一样**（都是 listing JSON），所以解析直接复用
 * `reddit.ts` 的 `parseListing`，不重写一份——两份解析必然漂移，
 * 而漂移的表现是「订阅能收到、搜索收不到」这种极难查的差异。
 *
 * ## `restrict_sr=0` 是必须的
 *
 * 不显式关掉它，Reddit 的行为取决于 URL 里有没有 `/r/xxx/` 前缀——
 * 没有前缀时默认已经是全站搜，但那是**隐式**的。写出来，语义才不依赖
 * 服务端某天改默认值。
 */

const ENDPOINT = 'https://www.reddit.com/search.json'
const UA = 'ai-hot/0.1 (+https://github.com/local/ai-hot)'
const DEFAULT_LIMIT = 25

const SORTS = ['relevance', 'hot', 'top', 'new'] as const

export const redditSearchAdapter: SourceAdapter = {
  kind: 'reddit-search',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const query = readQuery(ctx)
    if (query === null) return []

    const limit = Number(ctx.config.limit ?? DEFAULT_LIMIT)
    const sortRaw = String(ctx.config.sort ?? 'relevance')
    const sort = (SORTS as readonly string[]).includes(sortRaw) ? sortRaw : 'relevance'

    const url =
      `${ENDPOINT}?q=${encodeURIComponent(query)}&sort=${sort}` +
      `&limit=${Math.min(100, Math.max(1, limit))}&restrict_sr=0&raw_json=1`

    const res = await ctx.fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`reddit-search HTTP ${res.status}`)

    // subreddit 参数只用于失败时的报错信息，搜索结果不按子版块分组
    return parseListing(await res.json(), `search:${query}`)
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${ENDPOINT}?q=test&limit=1&restrict_sr=0`, {
        headers: { 'user-agent': UA },
      })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
