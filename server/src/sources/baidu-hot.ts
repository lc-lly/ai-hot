import { truncate } from '../util/text.js'
import { browserHeaders } from './http.js'
import { passesTitleFilter, readKeywords } from './keywords.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

/**
 * 百度热搜榜 —— **采集类**适配器。
 *
 * ## 数据怎么拿
 *
 * 榜单不是一个 JSON 接口，而是服务端渲染进 HTML 的一段**注释**：
 *
 * ```html
 * <!--s-data:{"data":{"cards":[{"content":[...],"updateTime":"1789636905"}]}}-->
 * ```
 *
 * 所以要先正则抠出注释体再 `JSON.parse`。**不要**改用 cheerio 去解析
 * DOM——榜单是脚本渲染的，DOM 里没有条目，只有这段注释里有。
 *
 * ## 为什么入库前必须过关键词白名单
 *
 * 热搜榜是**全站**热搜。实测某一刻的 51 条里，与 AI 沾边的只有 3 条
 * （「宇树科技大涨」「美国大模型已被日本错误历史观污染」「严禁AI魔改」），
 * 其余是社会新闻、体育、娱乐。而 L0 预筛只挡 AI 花费、**不挡入库和展示**，
 * 不过滤就等于每轮往雷达盘灌 48 条无关内容。见 `sources/keywords.ts`。
 *
 * ## hotScore 为什么不进 `metrics`
 *
 * 它是百度自己的热度值（量级 300 万 ~ 800 万），不是点赞/转发/浏览。
 * 塞进 `metrics` 的 `points` 槽位会让卡片上出现一个挂了「点数」标签和
 * 箭头图标的数字——标签是错的。它只喂给 `score/heat.ts` 当热度用。
 */

const ENDPOINT = 'https://top.baidu.com/board'
const REFERER = 'https://top.baidu.com/'
/** 只认这一种注释标记；百度改版时这里会失败，届时应当抛错而不是静默返回空 */
const S_DATA = /<!--s-data:([\s\S]*?)-->/

interface BaiduHotItem {
  query?: unknown
  desc?: unknown
  hotScore?: unknown
  hotChange?: unknown
  rawUrl?: unknown
  url?: unknown
  index?: unknown
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 「7904587」→ 7904587。解析不出来返回 null。 */
function parseScore(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/** 卡片级 `updateTime`：秒级时间戳的**字符串**。 */
function toDate(seconds: unknown): Date | null {
  const n = parseScore(seconds)
  return n === null || n <= 0 ? null : new Date(n * 1000)
}

/**
 * 从榜单页面 HTML 抠出条目。找不到那段注释就抛错。
 *
 * 「找不到注释」与「榜单今天没有内容」是两回事：前者是百度改版了、
 * 适配器已经失效，必须炸出来让人看见；后者只是一个空数组。
 * 把前者静默成后者，表现就是「这个源连续几天没内容」而没人知道为什么。
 */
export function parseHotBoard(html: string, keywords: readonly string[] = []): RawItem[] {
  const matched = S_DATA.exec(html)
  const payloadText = matched?.[1]
  if (payloadText === undefined) {
    throw new Error('百度热搜：页面里找不到 <!--s-data:--> 注释，可能是榜单改版了')
  }

  let payload: unknown
  try {
    payload = JSON.parse(payloadText)
  } catch (e) {
    throw new Error(`百度热搜：s-data 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`)
  }

  const cards = (payload as { data?: { cards?: unknown } } | null)?.data?.cards
  if (!Array.isArray(cards)) return []

  const out: RawItem[] = []
  for (const card of cards) {
    const list = (card as { content?: unknown } | null)?.content
    if (!Array.isArray(list)) continue
    const updatedAt = toDate((card as { updateTime?: unknown }).updateTime)

    for (const raw of list) {
      const item = raw as BaiduHotItem

      const query = str(item.query)
      const url = str(item.rawUrl) || str(item.url)
      if (query === '' || url === '') continue

      const desc = str(item.desc)
      // 只看热搜词。加上 `desc` 会让误报率翻倍——实测 7 条里 4 条是
      // 「摘要里顺带提了一个词」而非真讲这件事。见 `keywords.ts` 的表
      if (!passesTitleFilter(query, keywords)) continue

      out.push({
        // 用热搜词而不是 `index` 当主键：名次每分钟都在变，
        // 拿它做 ID 会让同一条热搜每轮都变成「新条目」重复入库
        externalId: `baidu:hot:${query}`,
        url,
        title: query,
        summary: desc === '' ? null : truncate(desc, 400),
        author: null,
        publishedAt: updatedAt,
        lang: 'zh',
        raw: {
          hotScore: parseScore(item.hotScore),
          hotChange: str(item.hotChange) || null,
        },
      })
    }
  }
  return out
}

export const baiduHotAdapter: SourceAdapter = {
  kind: 'baidu-hot',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const tab = str(ctx.config.tab) || 'realtime'
    const keywords = readKeywords(ctx.config)

    const res = await ctx.fetch(`${ENDPOINT}?tab=${encodeURIComponent(tab)}`, {
      headers: browserHeaders(REFERER),
    })
    if (!res.ok) throw new Error(`baidu-hot HTTP ${res.status}`)

    return parseHotBoard(await res.text(), keywords)
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${ENDPOINT}?tab=realtime`, { headers: browserHeaders(REFERER) })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
