import { parseFeed } from './rss.js'
import { browserHeaders } from './http.js'
import { readQuery } from './query.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

/**
 * Bing 网页搜索 —— **搜索类**适配器，不参与定时采集。
 *
 * ## 为什么是网页搜索而不是新闻搜索
 *
 * 原本想用的是 `bing.com/news/search?q=X&format=RSS`，但**这个端点已经失效**：
 * 实测它返回 302 后送到的是必应首页 HTML，不再是 RSS。`format=RSS` 参数
 * 还在的时候它是最好用的一个源。现在只有**网页搜索**这一条路：
 *
 * ```
 * https://www.bing.com/search?q=X&format=rss   ✅ 合法 RSS 2.0
 * https://www.bing.com/news/search?q=X&format=RSS   ❌ 302 到首页 HTML
 * ```
 *
 * `www.bing.com` 会 302 到 `cn.bing.com`，`fetch` 默认跟随，所以两边都能用。
 *
 * ## 为什么不自己解析 RSS
 *
 * 直接复用 `sources/rss.ts` 导出的 `parseFeed`——同一套实体解码、截断、
 * 日期兜底逻辑，没必要为 Bing 再写一遍。只做两处修正（见 `toBingItems`）。
 */

const ENDPOINT = 'https://www.bing.com/search'
const REFERER = 'https://www.bing.com/'
const DEFAULT_LIMIT = 20

/**
 * 把 `parseFeed` 的产出改成 Bing 该有的样子。
 *
 * 两处必须改：
 *
 * 1. **`externalId`**。`parseFeed` 一律写 `rss:<feed名>:<guid>`，对 Bing 来说
 *    这个前缀是误导——它既不是 RSS 源也没有 guid。注意要连 feed 名一起去掉：
 *    我们给 `parseFeed` 的 feed 名就是 `'bing'`，只换前缀会得到 `bing:bing:xxx`，
 *    把源名写了两遍。`externalId` 只需在**同一个源内**唯一，源名本身由
 *    `sourceId` 表达，不该在这里重复。
 * 2. **`author`**。Bing 的条目没有作者字段，`parseFeed` 会回落到 feed 名，
 *    卡片上就会出现「作者：Bing 网页搜索」这种把搜索引擎当作者显示的怪东西。
 *    取不到就如实置 null。
 */
function toBingItems(items: readonly RawItem[], query: string): RawItem[] {
  return items.map((item) => ({
    ...item,
    externalId: item.externalId.replace(/^rss:bing:/, 'bing:'),
    author: null,
    raw: { ...(item.raw as Record<string, unknown>), query },
  }))
}

export const bingSearchAdapter: SourceAdapter = {
  kind: 'bing-search',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const query = readQuery(ctx)
    if (query === null) return []

    const limit = Math.max(1, Math.min(50, Number(ctx.config.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT))
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=rss&count=${limit}`

    const res = await ctx.fetch(url, { headers: browserHeaders(REFERER) })
    if (!res.ok) throw new Error(`bing-search HTTP ${res.status}`)

    const xml = await res.text()

    // 拿到的不是 XML 就说明被跳转到了首页/验证页。静默返回空数组会伪装成
    // 「必应上搜不到这个关键词」，而事实是端点又变了——必须炸出来让人看见。
    if (!xml.trimStart().startsWith('<?xml')) {
      throw new Error('bing-search 没有返回 RSS（端点可能又改版了，实测返回的是 HTML）')
    }

    // 不传 `lang`：`parseFeed` 会把它落成 `null`。必应 RSS 也不带语言标记
    const items = await parseFeed(xml, { name: 'bing', url })
    return toBingItems(items, query).slice(0, limit)
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${ENDPOINT}?q=test&format=rss`, {
        headers: browserHeaders(REFERER),
      })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
