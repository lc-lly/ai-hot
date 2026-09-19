import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { baiduHotAdapter, parseHotBoard } from '../../src/sources/baidu-hot.js'
import { DEFAULT_AI_KEYWORDS } from '../../src/sources/keywords.js'
import { checkEngagement } from '../../src/pipeline/engagement.js'
import { metricsOf } from '../../src/score/metrics.js'
import type { FetchContext } from '../../src/sources/types.js'

const html = readFileSync(new URL('../fixtures/baidu-hot.html', import.meta.url), 'utf8')

const htmlFetch = (body: string, status = 200) =>
  (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof globalThis.fetch

const ctx = (config: Record<string, unknown> = {}): FetchContext => ({
  sourceId: 'src-baidu',
  config,
  fetch: htmlFetch(html),
  now: new Date('2026-09-15T00:00:00Z'),
})

describe('parseHotBoard', () => {
  it('不传关键词时全收（显式配空数组 = 不过滤）', () => {
    // fixture 里 5 条，其中「这条没有链接」两条 URL 字段都空 → 丢掉
    expect(parseHotBoard(html)).toHaveLength(4)
  })

  it('传默认 AI 词表时只看标题 —— 摘要里顺带提一句的挡在门外', () => {
    // 实测某一刻 51 条里只有约 3 条与 AI 相关。不过滤就等于往雷达盘灌
    // 48 条社会新闻——用户抱怨的「质量差」有一大半来自这里。
    //
    // 只看标题是**实测调出来的**：线上 7 条百度条目里 4 条只在摘要命中，
    // 全是误报（「封签代理商」「顺带提一句 AI Agent」这类）。见
    // `sources/keywords.ts` 的 `passesTitleFilter`。
    const items = parseHotBoard(html, DEFAULT_AI_KEYWORDS)
    expect(items.map((i) => i.title)).toEqual(['严禁AI魔改', '晚点聊：开源模型与推理成本'])
    expect(items.map((i) => i.title)).not.toContain('某地烧烤节开幕')
  })

  it('只看标题会漏掉「标题看不出、摘要才说明白」的那类（已知代价）', () => {
    // 《宇树科技大涨》摘要写的是「人形机器人赛道再度升温」，靠摘要才能
    // 认出它是 AI 相关。只看标题它就被挡掉了——这是标题策略**真实的**
    // 漏报，不是 fixture 的巧合，所以固化成断言而不是假装没有。
    //
    // 要救回这类条目得往词表里加标题级线索（如 `宇树`），而不是把摘要
    // 加回匹配范围——后者会连「封签代理商」一起放进来。
    const items = parseHotBoard(html, DEFAULT_AI_KEYWORDS)
    expect(items.map((i) => i.title)).not.toContain('宇树科技大涨')
    // 但若词表里有 `宇树`，它在标题上就能命中
    expect(parseHotBoard(html, ['宇树']).map((i) => i.title)).toContain('宇树科技大涨')
  })

  it('页面里找不到 s-data 注释时**抛错**，而不是返回空数组', () => {
    // 「百度改版了」和「今天没有热搜」是两回事。把前者静默成后者，
    // 表现是「这个源连续几天没内容」而没人知道为什么
    expect(() => parseHotBoard('<html><body>正常页面，但没有那段注释</body></html>')).toThrow(
      /改版/,
    )
  })

  it('s-data 不是合法 JSON 时也抛错', () => {
    expect(() => parseHotBoard('<html><!--s-data:{坏掉的 JSON}--></html>')).toThrow(/不是合法 JSON/)
  })

  it('externalId 用热搜词，不用 index', () => {
    // index 是名次，每分钟都在变。拿它做 ID 会让同一条热搜每轮都变成
    // 「新条目」重复入库——去重会彻底失效
    expect(parseHotBoard(html)[0]?.externalId).toBe('baidu:hot:宇树科技大涨')
  })

  it('同一条热搜名次变了，externalId 不变', () => {
    const moved = html.replace('"index":0', '"index":7')
    expect(parseHotBoard(moved)[0]?.externalId).toBe(parseHotBoard(html)[0]?.externalId)
  })

  it('hotScore 是字符串，解析成数字', () => {
    expect(parseHotBoard(html)[0]?.raw).toMatchObject({ hotScore: 7904587 })
  })

  it('hotScore 不进 metrics —— 它是百度自己的热度值，不是互动计数', () => {
    // 塞进 points 槽位会让卡片上出现一个挂着「点数」标签和箭头图标的数字，
    // 标签是错的。它只喂 score/heat.ts。
    const first = parseHotBoard(html)[0]
    expect(metricsOf('baidu-hot', first?.raw)).toEqual({})
    expect(checkEngagement('baidu-hot', first?.raw)).toBeNull()
  })

  it('author 恒为 null —— 热搜榜没有作者，回落到榜单名会很怪', () => {
    expect(parseHotBoard(html)[0]?.author).toBeNull()
  })

  it('publishedAt 来自卡片的 updateTime', () => {
    expect(parseHotBoard(html)[0]?.publishedAt?.toISOString()).toBe(
      new Date(1789636905 * 1000).toISOString(),
    )
  })

  it('desc 为空时 summary 是 null', () => {
    const items = parseHotBoard(html)
    const noDesc = items.find((i) => i.title === '晚点聊：开源模型与推理成本')
    expect(noDesc?.summary).toBeNull()
  })

  it('link 优先 rawUrl，回落 url', () => {
    expect(parseHotBoard(html)[0]?.url).toContain('baidu.com/s?wd=')
  })

  it('结构不符时返回空数组，不当成改版', () => {
    // 注释在、JSON 合法、但没有 cards —— 这是空榜单，不是适配器失效
    expect(parseHotBoard('<html><!--s-data:{"data":{}}--></html>')).toEqual([])
    expect(parseHotBoard('<html><!--s-data:{"data":{"cards":"nope"}}--></html>')).toEqual([])
  })
})

describe('baiduHotAdapter.fetch', () => {
  it('默认请求 realtime 榜', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await baiduHotAdapter.fetch({ ...ctx(), fetch: spy })
    expect(seen).toContain('tab=realtime')
  })

  it('config.tab 拼进查询串', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await baiduHotAdapter.fetch({ ...ctx({ tab: 'novel' }), fetch: spy })
    expect(seen).toContain('tab=novel')
  })

  it('HTTP 非 2xx 时抛错', async () => {
    const fetch = htmlFetch('nope', 503)
    await expect(baiduHotAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/503/)
  })

  it('带上浏览器 UA 与 Referer', async () => {
    let headers: Record<string, string> = {}
    const spy = ((_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await baiduHotAdapter.fetch({ ...ctx(), fetch: spy })
    expect(headers['user-agent']).toContain('Mozilla')
    expect(headers['referer']).toBe('https://top.baidu.com/')
  })
})
