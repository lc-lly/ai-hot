import Parser from 'rss-parser'
import { stripHtml, truncate } from '../util/text.js'
import { passesTitleFilter, readOptInKeywords } from './keywords.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

interface RssFeed {
  name: string
  url: string
  lang?: string
}

function readFeeds(config: Record<string, unknown>): RssFeed[] {
  if (!Array.isArray(config.feeds)) return []
  return config.feeds.filter(
    (f): f is RssFeed =>
      typeof f === 'object' && f !== null && typeof (f as RssFeed).name === 'string' && typeof (f as RssFeed).url === 'string',
  )
}

/**
 * `item.creator` 的实际类型取决于 feed 方言：RSS 2.0 的 `<dc:creator>` 是字符串，
 * 而 Atom 的 `<author>` 会被 rss-parser 解析成**对象**（`{ name: ['...'], title: [...] }`）。
 * 后者直接塞进 `RawItem.author` 就违反了 `string | null` 契约，写库时会被 Prisma
 * 以「author 不是 String」拒绝，且是**整批 createMany 一起失败**——该源每轮采集全军覆没。
 * 这里统一收敛成字符串，取不到就回落到 feed 名。
 */
function authorOf(creator: unknown, feedName: string): string {
  if (typeof creator === 'string') return creator.trim() || feedName
  const raw = (creator as { name?: unknown } | null | undefined)?.name
  const name = Array.isArray(raw) ? raw[0] : raw
  return typeof name === 'string' && name.trim() ? name.trim() : feedName
}

/**
 * 解析一份 RSS/Atom XML。
 * 用 parseString 而不是 parseURL —— 网络访问必须走 ctx.fetch，否则无法离线测试。
 */
export async function parseFeed(xml: string, feed: RssFeed, parser = new Parser()): Promise<RawItem[]> {
  const parsed = await parser.parseString(xml)

  return (parsed.items ?? [])
    .map((item): RawItem | null => {
      const url = (item.link ?? '').trim()
      if (!url) return null
      const rawTitle = (item.title ?? '').trim()
      if (!rawTitle) return null

      const guid = (item.guid ?? url).trim()
      const rawSummary = item.contentSnippet ?? item.summary ?? item.content ?? ''

      return {
        externalId: `rss:${feed.name}:${guid}`,
        url,
        title: rawTitle,
        summary: rawSummary ? truncate(stripHtml(rawSummary), 500) : null,
        author: authorOf(item.creator, feed.name),
        publishedAt: item.isoDate ? new Date(item.isoDate) : null,
        lang: feed.lang ?? null,
        raw: item,
      }
    })
    .filter((i): i is RawItem => i !== null)
}

export const rssAdapter: SourceAdapter = {
  kind: 'rss',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const feeds = readFeeds(ctx.config)
    if (feeds.length === 0) return []

    /*
      白名单是**按需**的：没配 `keywords` 就一条都不过滤。

      过滤放在这里而不是 `parseFeed` 里，是因为 `parseFeed` 被
      `sources/bing-search.ts` 复用了——把过滤塞进解析器，搜索类源会连带
      被订阅源的配置影响，而且那边根本不该有入库白名单。

      没配 = 全收，这是与榜单源相反的默认值，理由见 `readOptInKeywords`。
    */
    const keywords = readOptInKeywords(ctx.config)

    const out: RawItem[] = []
    const failures: string[] = []

    for (const feed of feeds) {
      try {
        const res = await ctx.fetch(feed.url, { headers: { 'user-agent': 'ai-hot/0.1' } })
        if (!res.ok) {
          failures.push(`${feed.name}: HTTP ${res.status}`)
          continue
        }
        const items = await parseFeed(await res.text(), feed)
        // 只看标题。看摘要的话，RSS 的 summary 往往是**全文**，
        // 正文里提一次 AI 就会把整条放进来——比榜单源那边更糟
        out.push(...items.filter((i) => passesTitleFilter(i.title, keywords)))
      } catch (e) {
        failures.push(`${feed.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (out.length === 0 && failures.length > 0) {
      throw new Error(`rss 全部 feed 失败 -> ${failures.join('; ')}`)
    }
    return out
  },

  async health(ctx: FetchContext) {
    const feeds = readFeeds(ctx.config)
    if (feeds.length === 0) return { ok: false, detail: '未配置任何 feed' }
    const first = feeds[0] as RssFeed
    try {
      const res = await ctx.fetch(first.url, { headers: { 'user-agent': 'ai-hot/0.1' } })
      return { ok: res.ok, detail: `${first.name}: HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
