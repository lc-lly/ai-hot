import * as cheerio from 'cheerio'
import { stripHtml, truncate } from '../util/text.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

const BASE = 'https://github.com/trending'

/** 从 Trending 页面 HTML 解析仓库列表。纯函数，便于用 fixture 测试。 */
export function parseTrendingHtml(html: string): RawItem[] {
  const $ = cheerio.load(html)
  const out: RawItem[] = []

  $('article.Box-row').each((_, el) => {
    const $el = $(el)
    const href = $el.find('h2 a').first().attr('href') ?? ''
    const repoPath = href.trim().replace(/^\/+/, '')
    if (!repoPath.includes('/')) return

    const summary = stripHtml($el.find('p').first().text())
    const lang = $(el).find('[itemprop="programmingLanguage"]').first().text().trim()
    const starsToday = $el.find('span.d-inline-block.float-sm-right').first().text().trim()

    out.push({
      externalId: `gh:${repoPath}`,
      url: `https://github.com/${repoPath}`,
      title: repoPath,
      summary: summary ? truncate(summary, 300) : null,
      author: repoPath.split('/')[0] ?? null,
      publishedAt: null,
      lang: lang || null,
      raw: { repoPath, starsToday },
    })
  })

  return out
}

export const githubTrendingAdapter: SourceAdapter = {
  kind: 'github-trending',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const since = String(ctx.config.since ?? 'daily')
    const language = ctx.config.language ? `/${String(ctx.config.language)}` : ''
    const url = `${BASE}${language}?since=${encodeURIComponent(since)}`

    const res = await ctx.fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ai-hot/0.1)' },
    })
    if (!res.ok) throw new Error(`github trending 返回 HTTP ${res.status}`)

    return parseTrendingHtml(await res.text())
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(BASE, { headers: { 'user-agent': 'Mozilla/5.0' } })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
