import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bilibiliAdapter, parsePopular } from '../../src/sources/bilibili.js'
import { DEFAULT_AI_KEYWORDS } from '../../src/sources/keywords.js'
import { checkEngagement } from '../../src/pipeline/engagement.js'
import { metricsOf } from '../../src/score/metrics.js'
import type { FetchContext } from '../../src/sources/types.js'

const payload: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/bilibili-popular.json', import.meta.url), 'utf8'),
)

/** 造一个只有 code 的响应体，用来测风控与 HTTP 失败路径。 */
const jsonFetch = (body: unknown, status = 200) =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof globalThis.fetch

const ctx = (config: Record<string, unknown> = {}): FetchContext => ({
  sourceId: 'src-bili',
  config,
  fetch: jsonFetch(payload),
  now: new Date('2026-09-15T00:00:00Z'),
})

/**
 * 按 bvid 取解析结果。
 *
 * 不用下标：fixture 里 4 条、解析后剩 3 条，而带关键词过滤时又是另一批下标，
 * 数错一次就会写出「断言的是炒饭那条、标题却写着芯片」的测试——
 * 它照样会红，但红得让人找错方向。
 */
const byBvid = (bvid: string, keywords?: readonly string[]) =>
  parsePopular(payload, keywords).find((i) => i.externalId === `bilibili:${bvid}`)

/** fixture 里那条 pubdate=0、owner=null、desc 缺失的条目 */
const SPARSE = 'BV1zz411c7mF'

describe('parsePopular', () => {
  it('不传关键词时全收（显式配空数组 = 不过滤）', () => {
    // 4 条里有一条没有 bvid，它拿不到稳定主键和能打开的链接，必须丢掉
    expect(parsePopular(payload)).toHaveLength(3)
  })

  it('传默认 AI 词表时挡掉与 AI 无关的条目', () => {
    // 「三分钟学会炒蛋炒饭」不该进雷达盘——榜单是全站热门，
    // 不过滤的话每轮 50 条视频会把盘面淹掉，而 L0 预筛只挡 AI 花费、不挡入库
    const items = parsePopular(payload, DEFAULT_AI_KEYWORDS)
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.title)).not.toContain('三分钟学会炒蛋炒饭')
  })

  it('关键词只看标题与简介，不误伤', () => {
    const items = parsePopular(payload, DEFAULT_AI_KEYWORDS)
    expect(items.map((i) => i.externalId)).toEqual([
      'bilibili:BV1xx411c7mD',
      'bilibili:BV1zz411c7mF',
    ])
  })

  it('externalId 与 url 由 bvid 拼出', () => {
    expect(byBvid('BV1xx411c7mD')?.url).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
  })

  it('时间戳是秒级，转成 Date', () => {
    expect(byBvid('BV1xx411c7mD')?.publishedAt?.toISOString()).toBe(
      new Date(1789000000 * 1000).toISOString(),
    )
  })

  it('pubdate 为 0 时 publishedAt 是 null，不编造时间', () => {
    // 把 0 当成 1970-01-01 会让它排到时间窗外面，
    // 表现是「这条明明刚抓到却怎么都筛不出来」。
    expect(byBvid(SPARSE)?.publishedAt).toBeNull()
  })

  it('owner 缺失时 author 是 null，而不是 undefined 或对象', () => {
    // author 违反 `string | null` 契约会让 Prisma 的 createMany **整批**拒绝，
    // 该源每轮采集全军覆没，表现却是「这个源没内容」。rss.ts 出过这个事故。
    expect(byBvid(SPARSE)?.author).toBeNull()
  })

  it('owner 存在时 author 是名字字符串', () => {
    expect(byBvid('BV1xx411c7mD')?.author).toBe('技术宅小明')
  })

  it('desc 缺失时 summary 是 null', () => {
    expect(byBvid(SPARSE)?.summary).toBeNull()
  })

  it('raw 里只放与展示有关的计数，不把整个 stat 铺进来', () => {
    expect(byBvid('BV1xx411c7mD')?.raw).toEqual({
      view: 772253,
      like: 45120,
      share: 3120,
      reply: 880,
      favorite: 12000,
      coin: 5400,
      danmaku: 1200,
      bvid: 'BV1xx411c7mD',
    })
  })

  it('raw 的字段名与 metricsOf / 互动闸门对得上（端到端）', () => {
    // 这条是防「少写一个 case」的：metricsOf 的 default 分支嗅探的是
    // like_count / shares / view_count，一个都对不上 B站。
    // 少了 case 'bilibili'，卡片上那排数字会空、闸门也会整个失效
    // （它只在源提供了指标时才判负，一个都取不到就一律放行）。
    const first = byBvid('BV1xx411c7mD')
    expect(metricsOf('bilibili', first?.raw)).toEqual({
      likes: 45120,
      reposts: 3120,
      views: 772253,
      replies: 880,
    })
    expect(checkEngagement('bilibili', first?.raw)).toBeNull()
  })

  it('结构不符时返回空数组而不是抛错', () => {
    expect(parsePopular(null)).toEqual([])
    expect(parsePopular({})).toEqual([])
    expect(parsePopular({ data: { list: 'nope' } })).toEqual([])
  })
})

describe('bilibiliAdapter.fetch', () => {
  it('code=-412 但 HTTP 200 时必须抛错', async () => {
    // B站限流时**不一定改状态码**，而是照样回 200、把 code 置成 -412。
    // 只判 res.ok 会把「被风控了」当成「这个榜今天就是空的」——
    // 静默返回空数组是最坏的结果。
    const fetch = jsonFetch({ code: -412, message: '请求被拦截' })
    await expect(bilibiliAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/-412/)
  })

  it('错误信息里保留原始 code，方便用户自己去查', async () => {
    const fetch = jsonFetch({ code: -412, message: '请求被拦截' })
    await expect(bilibiliAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/请求被拦截/)
  })

  it('HTTP 非 2xx 时抛错并带上状态码', async () => {
    const fetch = jsonFetch({}, 429)
    await expect(bilibiliAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/429/)
  })

  it('默认请求 50 条', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await bilibiliAdapter.fetch({ ...ctx(), fetch: spy })
    expect(seen).toContain('ps=50')
    expect(seen).toContain('pn=1')
  })

  it('config.ps 超过单页上限时被夹到 50', async () => {
    // 该接口单页上限就是 50，传再大也不会多给
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await bilibiliAdapter.fetch({ ...ctx({ ps: 999 }), fetch: spy })
    expect(seen).toContain('ps=50')
  })

  it('config.keywords 显式配成空数组 = 不过滤', async () => {
    // 「我不想过滤」和「我懒得配」是相反的意图，必须能分开表达
    const items = await bilibiliAdapter.fetch(ctx({ keywords: [] }))
    expect(items).toHaveLength(3)
  })

  it('带上浏览器 UA 与 Referer —— 默认的 ai-hot/0.1 会被国内站挡掉', async () => {
    let headers: Record<string, string> = {}
    const spy = ((_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await bilibiliAdapter.fetch({ ...ctx(), fetch: spy })
    expect(headers['user-agent']).toContain('Mozilla')
    expect(headers['referer']).toBe('https://www.bilibili.com/')
  })
})
