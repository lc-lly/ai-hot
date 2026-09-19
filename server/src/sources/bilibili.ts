import { truncate } from '../util/text.js'
import { browserHeaders } from './http.js'
import { passesTitleFilter, readKeywords } from './keywords.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

/**
 * B站综合热门榜 —— **采集类**适配器。
 *
 * ## 为什么是它：这是唯一能填满「点赞 / 转发 / 浏览」三项的源
 *
 * 参考项目卡片上那排饱满的互动数，靠的正是 B站 这类天然带互动计数的平台。
 * 实测 `stat` 里 `view` / `like` / `share` / `reply` / `favorite` / `coin`
 * 一应俱全，而 RSS、百度热搜、搜狗、Bing 一个都拿不出来。
 *
 * ## 为什么入库前要过关键词白名单
 *
 * 热门榜是**全站**热门，与 AI 的相关度很低。不过滤的话每轮 50 条视频会
 * 直接把雷达盘淹掉——而 L0 预筛只挡 AI 花费、不挡入库和展示。
 * 见 `sources/keywords.ts` 的说明。
 *
 * ## 风控
 *
 * B站的接口在**限流时不一定改 HTTP 状态码**，而是照样回 200、把
 * `code` 字段置成 `-412`。只判 `res.ok` 会把「被风控了」当成
 * 「这个榜就是空的」——静默返回空数组是最坏的结果，用户会以为
 * B站 今天没有热门视频。所以 `code !== 0` 必须当错误抛。
 */

const ENDPOINT = 'https://api.bilibili.com/x/web-interface/popular'
const REFERER = 'https://www.bilibili.com/'
/** 该接口单页上限就是 50，传再大也不会多给 */
const MAX_PS = 50
const DEFAULT_PS = 50

interface PopularVideo {
  bvid?: unknown
  title?: unknown
  desc?: unknown
  pubdate?: unknown
  owner?: { name?: unknown } | null
  stat?: Record<string, unknown> | null
}

/** 数字或 null。B站 的计数都是 number，但 `raw` 是外部输入，不假设类型。 */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 秒级时间戳 → Date。缺失或非正数一律 null，不编造时间。 */
function toDate(seconds: unknown): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}

/**
 * `owner` 收敛成字符串。
 *
 * 照抄 `sources/rss.ts` 的 `authorOf` 那条教训：外部数据里作者字段
 * 变成对象/数组是**真实发生过**的事故，而它违反 `RawItem.author: string | null`
 * 的契约后，Prisma 的 `createMany` 会**整批**拒绝——该源每轮采集全军覆没，
 * 表现却是「这个源没内容」。
 */
function ownerName(owner: PopularVideo['owner']): string | null {
  const name = owner?.name
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
}

/**
 * 解析 `popular` 接口的 `data.list`。结构不符返回空数组。
 *
 * `keywords` 为空数组 = 不过滤（显式配空的语义，见 `keywords.ts`）。
 */
export function parsePopular(
  payload: unknown,
  keywords: readonly string[] = [],
): RawItem[] {
  const list = (payload as { data?: { list?: unknown } } | null)?.data?.list
  if (!Array.isArray(list)) return []

  const out: RawItem[] = []
  for (const raw of list) {
    const video = raw as PopularVideo

    const bvid = typeof video.bvid === 'string' ? video.bvid.trim() : ''
    const title = typeof video.title === 'string' ? video.title.trim() : ''
    // 没有 bvid 就没有稳定主键、没有能打开的链接，这条没有价值
    if (bvid === '' || title === '') continue

    const desc = typeof video.desc === 'string' ? video.desc.trim() : ''
    // 只看标题。看 `desc` 会放进《三年之期已到…【第9集】》这种——它的摘要
    // 写的是「AI生成视频，非真实事件」，那是免责声明不是内容。见 `keywords.ts`
    if (!passesTitleFilter(title, keywords)) continue

    const stat = video.stat ?? {}

    out.push({
      externalId: `bilibili:${bvid}`,
      url: `https://www.bilibili.com/video/${bvid}`,
      title,
      summary: desc === '' ? null : truncate(desc, 400),
      author: ownerName(video.owner),
      publishedAt: toDate(video.pubdate),
      lang: 'zh',
      // 字段名与 `score/metrics.ts` 里 `case 'bilibili'` 的读取方式一一对应。
      // 显式列出而不是把整个 `stat` 铺进来：stat 里还有 now_rank / vt / vv
      // 这类与展示无关的字段，铺进来只会让 `raw` 变胖且难读。
      raw: {
        view: num(stat['view']),
        like: num(stat['like']),
        share: num(stat['share']),
        reply: num(stat['reply']),
        favorite: num(stat['favorite']),
        coin: num(stat['coin']),
        danmaku: num(stat['danmaku']),
        bvid,
      },
    })
  }
  return out
}

export const bilibiliAdapter: SourceAdapter = {
  kind: 'bilibili',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const ps = Math.min(MAX_PS, Math.max(1, Number(ctx.config.ps ?? DEFAULT_PS) || DEFAULT_PS))
    const keywords = readKeywords(ctx.config)

    const res = await ctx.fetch(`${ENDPOINT}?ps=${ps}&pn=1`, {
      headers: browserHeaders(REFERER),
    })
    if (!res.ok) throw new Error(`bilibili HTTP ${res.status}`)

    const payload = await res.json()
    const code = (payload as { code?: unknown } | null)?.code
    if (typeof code === 'number' && code !== 0) {
      const message = (payload as { message?: unknown } | null)?.message
      throw new Error(
        `bilibili 接口 code=${code}${typeof message === 'string' ? ` (${message})` : ''}，通常是触发风控（-412），稍后再试`,
      )
    }

    return parsePopular(payload, keywords)
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${ENDPOINT}?ps=1&pn=1`, { headers: browserHeaders(REFERER) })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
