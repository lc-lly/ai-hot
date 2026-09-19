import { createHash } from 'node:crypto'
import * as cheerio from 'cheerio'
import { stripHtml, truncate } from '../util/text.js'
import { browserHeaders } from './http.js'
import { readQuery } from './query.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

/**
 * 搜狗微信文章搜索 —— **搜索类**适配器，不参与定时采集。
 *
 * ## 抓的是 HTML，不是接口
 *
 * 搜狗没有给出 JSON 接口，只能解析搜索结果页。实测单个结果的 DOM 是：
 *
 * ```html
 * <div class="txt-box">
 *   <h3><a href="/link?url=...&token=...">标题（含 <em> 高亮）</a></h3>
 *   <p class="txt-info">摘要</p>
 *   <div class="s-p">
 *     <span class="all-time-y2">公众号名</span>
 *     <span class="s2"><script>document.write(timeConvert('1789624932'))</script></span>
 *   </div>
 * </div>
 * ```
 *
 * 注意公众号名在 `.all-time-y2` 里（不是类名看起来的「时间」），
 * 而发布时间藏在 `.s2` 里那段 `document.write` 的**脚本源码**中——
 * 页面上它是渲染出来的，在 HTML 源码里它只是一段字符串，必须正则抠。
 *
 * ## 链接会过期
 *
 * `href` 是搜狗自己的 `/link?url=...&token=...` 跳转地址，带时效性 token。
 * 这里原样存下来而不去解析真实地址：解析需要为每条结果再打一次搜狗，
 * 10 条就是 10 次额外请求，而搜狗的反爬比 B站 更凶。代价是这条链接
 * 几小时后可能失效。搜索结果不落库（`routes/search.ts`），
 * 只影响「当场点开」，可以接受。
 *
 * ## 反爬
 *
 * 被拦时搜狗返回的是验证码页而不是搜索结果。**必须把这种情况当错误抛**：
 * 静默返回空数组等于告诉用户「微信里没有这个话题」，而事实是被拦了。
 */

const ENDPOINT = 'https://weixin.sogou.com/weixin'
const REFERER = 'https://weixin.sogou.com/'
const DEFAULT_LIMIT = 10

/** 被拦时的页面特征。命中任一即认定为反爬拦截而不是「没有结果」。 */
const BLOCK_MARKERS = [
  '请输入验证码',
  'antispider',
  'seccode',
  '用户您好，您的访问过于频繁',
  '您的访问出错了',
]

/** `document.write(timeConvert('1789624932'))` 里的秒级时间戳 */
const TIME_CONVERT = /timeConvert\(\s*'(\d+)'\s*\)/

function text(v: string | undefined): string {
  return typeof v === 'string' ? stripHtml(v).trim() : ''
}

/**
 * 用「公众号 + 标题 + 链接」的摘要当 `externalId`。
 *
 * 不用链接本身：它长达数百字符（带 token），塞进 DTO 的 id 里会让
 * 日志与 React key 都变得没法看。摘要在同一批结果里不会撞。
 */
function articleId(account: string, title: string, url: string): string {
  const digest = createHash('sha256').update(`${account}\n${title}\n${url}`).digest('hex')
  return `sogou:${digest.slice(0, 16)}`
}

/**
 * 解析搜索结果页。被反爬拦截时抛错，正常但无结果时返回空数组。
 */
export function parseSearchPage(html: string, query: string): RawItem[] {
  const $ = cheerio.load(html)
  const boxes = $('.txt-box')

  if (boxes.length === 0) {
    const blocked = BLOCK_MARKERS.find((marker) => html.includes(marker))
    if (blocked !== undefined) {
      throw new Error(`sogou-weixin 被反爬拦截（页面出现「${blocked}」）`)
    }
    return []
  }

  const out: RawItem[] = []
  boxes.each((_, el) => {
    const $el = $(el)
    const $link = $el.find('h3 a').first()

    const title = text($link.text())
    const href = ($link.attr('href') ?? '').trim()
    if (title === '' || href === '') return

    // 有极少数结果是直链，多数是站内跳转，两种都要能点开
    const url = href.startsWith('http') ? href : `https://weixin.sogou.com${href}`

    const account = text($el.find('.s-p .all-time-y2').first().text())
    const summary = text($el.find('p.txt-info').first().text())

    // 时间只存在于脚本源码里，`text()` 拿不到，得从原始 HTML 里正则抠
    const stamp = TIME_CONVERT.exec($el.find('.s-p .s2').html() ?? '')?.[1]
    const seconds = stamp === undefined ? Number.NaN : Number(stamp)

    out.push({
      externalId: articleId(account, title, url),
      url,
      title,
      summary: summary === '' ? null : truncate(summary, 400),
      author: account === '' ? null : account,
      publishedAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null,
      lang: 'zh',
      // 搜狗只给标题、摘要、公众号、时间，**没有任何互动计数**。
      // 于是 `checkEngagement` 对它不判负（三项指标一个都没有），
      // 而 `score/heat.ts` 会给出 HEAT_FALLBACK。这是设计好的行为，不是漏取。
      raw: { query, account },
    })
  })

  return out
}

export const sogouWeixinAdapter: SourceAdapter = {
  kind: 'sogou-weixin',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const query = readQuery(ctx)
    if (query === null) return []

    const limit = Math.max(1, Math.min(50, Number(ctx.config.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT))
    // 该接口一页就是 10 条，且不分页参数；limit 只用于最终截断
    const url = `${ENDPOINT}?type=2&query=${encodeURIComponent(query)}`

    const res = await ctx.fetch(url, { headers: browserHeaders(REFERER) })
    if (!res.ok) throw new Error(`sogou-weixin HTTP ${res.status}`)

    return parseSearchPage(await res.text(), query).slice(0, limit)
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${ENDPOINT}?type=2&query=test`, {
        headers: browserHeaders(REFERER),
      })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
