import { stripInlineTags, truncate } from '../util/text.js'
import { browserHeaders } from './http.js'
import { readQuery } from './query.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

/**
 * B站视频搜索 —— **搜索类**适配器，不参与定时采集。
 *
 * ## 为什么需要 query 才请求
 *
 * 它注册在同一个 registry 里，`collect` 会遍历所有启用的 Source。
 * 没有 query 却照发请求，等于每 15 分钟往 B站 打一次空查询——而 B站
 * 是有风控的（见下）。返回空数组 = 「这个源此刻没有内容」。
 *
 * ## 风控：这个接口真的会被拦
 *
 * 实测本机连续请求，**第 2 次就返回 412**。而且 B站 的风控不一定改
 * HTTP 状态码，也可能照样回 200 把 `code` 置成 `-412`。两种都要当错误抛：
 * 静默返回空数组会让用户以为「B站 上没有这个关键词」，而事实是被拦了。
 * 搜索路由侧的 60 秒结果缓存（`routes/search.ts`）同时也是一层保护。
 *
 * ## 字段映射
 *
 * 搜索接口的字段名与 `popular` 接口**不一样**：播放是 `play` 不是 `view`，
 * 评论是 `review` 不是 `reply`，而且**不提供转发数**（没有 share）。
 * 这里统一映射成 `popular` 的字段名后再放进 `raw`，让 `score/metrics.ts`
 * 与 `score/heat.ts` 只认一套字段。`share` 显式置 null 而不是省略——
 * 让读代码的人一眼看出「不是忘了取，是这个接口没有」。
 */

const ENDPOINT = 'https://api.bilibili.com/x/web-interface/search/type'
const REFERER = 'https://search.bilibili.com/'
const DEFAULT_LIMIT = 20
/** 该接口单页固定 20 条，传 page 翻页 */
const PAGE_SIZE = 20

interface SearchVideo {
  bvid?: unknown
  title?: unknown
  description?: unknown
  author?: unknown
  pubdate?: unknown
  play?: unknown
  like?: unknown
  review?: unknown
  favorites?: unknown
  danmaku?: unknown
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 字符串字段的统一清洗：非字符串 → 空串，然后去掉行内高亮标签。
 *
 * 这一步不能省。搜索接口会在命中的关键词上套高亮标签，实测返回的标题长这样：
 *
 * ```
 * <em class="keyword">大模型</em>微调
 * 【全748集】目前B站最全最细的AI<em class="keyword">大模型</em>零基础全
 * ```
 *
 * 不清洗的话这些标签会当成**标题的一部分**写进 `title`：卡片上显示
 * 「`<em class="keyword">大模型</em>微调`」，而关键词白名单与 L0 预筛
 * 也会拿这串带标签的文本去匹配。`description` 同样带标签。
 *
 * 用 `stripInlineTags` 而不是 `stripHtml`：后者是给块级 HTML 用的，
 * 它把标签换成空格，会把「AI大模型」切成「AI 大模型」。见 `util/text.ts`。
 */
function text(v: unknown): string {
  return typeof v === 'string' ? stripInlineTags(v) : ''
}

function toDate(seconds: unknown): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}

/**
 * 解析 `search/type` 的 `data.result`。结构不符返回空数组。
 *
 * 清洗全部走 `text()`（内含 `stripHtml`，见那里的说明）。
 */
function parseResults(payload: unknown, query: string): RawItem[] {
  const result = (payload as { data?: { result?: unknown } } | null)?.data?.result
  if (!Array.isArray(result)) return []

  const out: RawItem[] = []
  for (const raw of result) {
    const video = raw as SearchVideo

    const bvid = text(video.bvid)
    const title = text(video.title)
    if (bvid === '' || title === '') continue

    const desc = text(video.description)

    out.push({
      // 与 `bilibili.ts` 用同一个前缀：同一条视频无论从热门榜还是搜索进来，
      // 都是同一个 `externalId`，跨源去重时能对上
      externalId: `bilibili:${bvid}`,
      url: `https://www.bilibili.com/video/${bvid}`,
      title,
      summary: desc === '' ? null : truncate(desc, 400),
      author: text(video.author) || null,
      publishedAt: toDate(video.pubdate),
      lang: 'zh',
      raw: {
        view: num(video.play),
        like: num(video.like),
        reply: num(video.review),
        favorite: num(video.favorites),
        danmaku: num(video.danmaku),
        // 搜索接口没有转发数。显式 null 见文件头说明
        share: null,
        bvid,
        query,
      },
    })
  }
  return out
}

function httpError(status: number): Error {
  if (status === 412) {
    return new Error('bilibili-search 触发风控（HTTP 412），稍后再试')
  }
  return new Error(`bilibili-search HTTP ${status}`)
}

export const bilibiliSearchAdapter: SourceAdapter = {
  kind: 'bilibili-search',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const query = readQuery(ctx)
    if (query === null) return []

    const limit = Math.max(1, Math.min(60, Number(ctx.config.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT))
    const pages = Math.max(1, Math.ceil(limit / PAGE_SIZE))

    const out: RawItem[] = []
    for (let page = 1; page <= pages; page++) {
      const url =
        `${ENDPOINT}?search_type=video&keyword=${encodeURIComponent(query)}&page=${page}`

      const res = await ctx.fetch(url, { headers: browserHeaders(REFERER) })
      if (!res.ok) throw httpError(res.status)

      const payload = await res.json()
      const code = (payload as { code?: unknown } | null)?.code
      if (typeof code === 'number' && code !== 0) {
        const message = (payload as { message?: unknown } | null)?.message
        throw new Error(
          `bilibili-search 接口 code=${code}${typeof message === 'string' ? ` (${message})` : ''}，通常是触发风控`,
        )
      }

      const items = parseResults(payload, query)
      out.push(...items)
      // 这一页已经不满，再翻也是空的
      if (items.length < PAGE_SIZE) break
    }

    return out.slice(0, limit)
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${ENDPOINT}?search_type=video&keyword=test&page=1`, {
        headers: browserHeaders(REFERER),
      })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
