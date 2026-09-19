import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bilibiliSearchAdapter } from '../../src/sources/bilibili-search.js'
import { checkEngagement } from '../../src/pipeline/engagement.js'
import { metricsOf } from '../../src/score/metrics.js'
import { heat } from '../../src/score/heat.js'
import type { FetchContext, RawItem } from '../../src/sources/types.js'

const payload: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/bilibili-search.json', import.meta.url), 'utf8'),
)

const jsonFetch = (body: unknown, status = 200) =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof globalThis.fetch

const ctx = (config: Record<string, unknown> = {}): FetchContext => ({
  sourceId: 'src-bili-search',
  config: { query: '大模型', ...config },
  fetch: jsonFetch(payload),
  now: new Date('2026-09-15T00:00:00Z'),
})

const byBvid = (items: readonly RawItem[], bvid: string) =>
  items.find((i) => i.externalId === `bilibili:${bvid}`)

describe('bilibiliSearchAdapter.fetch：标题里的高亮标签', () => {
  it('标题里的 <em class="keyword"> 被清掉，不会当成标题的一部分', async () => {
    // 实测接口真的这么返回：
    //   <em class="keyword">大模型</em>微调
    // 不清洗的话卡片上就会原样显示这串标签，而且关键词白名单与 L0 预筛
    // 也会拿带标签的文本去匹配。这个缺陷是**实测抓出来的**，不是假想。
    const items = await bilibiliSearchAdapter.fetch(ctx())
    for (const item of items) {
      expect(item.title).not.toContain('<em')
      expect(item.title).not.toContain('</em>')
      expect(item.title).not.toContain('class=')
    }
  })

  it('清洗后标题是干净的正文', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(byBvid(items, 'BV1aa411c7mX')?.title).toBe('大模型微调')
    expect(byBvid(items, 'BV1uNk1YxEJQ')?.title).toBe(
      '【全748集】目前B站最全最细的AI大模型零基础全套教程',
    )
  })

  it('简介里的高亮标签同样被清掉', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(byBvid(items, 'BV1uNk1YxEJQ')?.summary).toBe(
      '本课程从零讲解大模型原理与工程实践，含 RAG 与微调。',
    )
  })
})

describe('bilibiliSearchAdapter.fetch：字段映射', () => {
  it('play→view、review→reply、favorites→favorite，一套字段名对齐采集类', async () => {
    // 搜索接口的字段名与 popular 接口不一样。不适配的话 metricsOf 取不到数、
    // heat 落到回落值——两个症状都不报错。
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(byBvid(items, 'BV1uNk1YxEJQ')?.raw).toEqual({
      view: 3809633,
      like: 62426,
      reply: 17923,
      favorite: 210000,
      danmaku: 8800,
      share: null,
      bvid: 'BV1uNk1YxEJQ',
      query: '大模型',
    })
  })

  it('share 显式为 null —— 这个接口没有转发数，不是忘了取', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(byBvid(items, 'BV1uNk1YxEJQ')?.raw).toMatchObject({ share: null })
  })

  it('metricsOf 取到点赞与浏览，reposts 缺席（而不是 0）', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    const m = metricsOf('bilibili-search', byBvid(items, 'BV1uNk1YxEJQ')?.raw)
    expect(m).toEqual({ likes: 62426, views: 3809633, replies: 17923 })
    // 0 会被读成「有 0 个转发」，而事实是这个接口不提供转发数
    expect(m.reposts).toBeUndefined()
  })

  it('heat 用 view 除以搜索类自己的基准，不是回落值', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    const h = heat('bilibili-search', byBvid(items, 'BV1uNk1YxEJQ')?.raw)
    expect(h).toBeGreaterThan(0.9)
    expect(h).toBeLessThanOrEqual(1)
  })

  it('publishedAt 是秒级时间戳，0 视为缺失', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(byBvid(items, 'BV1uNk1YxEJQ')?.publishedAt?.toISOString()).toBe(
      new Date(1734681412 * 1000).toISOString(),
    )
    expect(byBvid(items, 'BV1bb411c7mY')?.publishedAt).toBeNull()
  })

  it('author 为空串时是 null，不是空字符串', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(byBvid(items, 'BV1bb411c7mY')?.author).toBeNull()
    expect(byBvid(items, 'BV1uNk1YxEJQ')?.author).toBe('大模型官方课程')
  })

  it('没有 bvid 的条目被丢掉', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(items).toHaveLength(3)
  })

  it('externalId 与采集类共用同一个前缀 —— 同一条视频跨源能对上', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(items.map((i) => i.externalId)).toContain('bilibili:BV1uNk1YxEJQ')
  })

  it('结构不符时返回空数组', async () => {
    const fetch = jsonFetch({ code: 0, data: { result: 'nope' } })
    expect(await bilibiliSearchAdapter.fetch({ ...ctx(), fetch })).toEqual([])
  })
})

describe('bilibiliSearchAdapter.fetch：互动阈值在这条路径上真的会挡人', () => {
  it('「播放几百、点赞个位数」的结果被闸门拒绝', async () => {
    // 这是阈值的**主要作用点**。热门榜上最低的一条也有 like 8799 / view 40135，
    // 那里 50/50 全过；真正会被挡掉的是搜索结果里的长尾。
    const items = await bilibiliSearchAdapter.fetch(ctx())
    const rejected = items.filter((i) => checkEngagement('bilibili-search', i.raw) !== null)
    expect(rejected.map((i) => i.externalId)).toEqual([
      'bilibili:BV1aa411c7mX', // play 232 / like 9
      'bilibili:BV1bb411c7mY', // play 358 / like 5
    ])
  })

  it('拒绝原因是可读的，能直接进日志', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    const reason = checkEngagement('bilibili-search', byBvid(items, 'BV1aa411c7mX')?.raw)
    expect(reason).toContain('点赞 9')
    expect(reason).toContain('浏览 232')
    // share 是 null → 「转发」这一项不该参与判定
    expect(reason).not.toContain('转发')
  })

  it('高播放的那条照常通过', async () => {
    const items = await bilibiliSearchAdapter.fetch(ctx())
    expect(checkEngagement('bilibili-search', byBvid(items, 'BV1uNk1YxEJQ')?.raw)).toBeNull()
  })
})

describe('bilibiliSearchAdapter.fetch：风控与查询词', () => {
  it('没有 query 时返回空数组，且**不打网络**', async () => {
    // collect 每 15 分钟会遍历一次启用的源。搜索类源拿不到 query 还照发请求，
    // 等于每 15 分钟往 B站 打一次空查询 —— 而 B站 是有风控的
    let called = false
    const spy = (() => {
      called = true
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }) as unknown as typeof globalThis.fetch

    const items = await bilibiliSearchAdapter.fetch({ ...ctx(), config: {}, fetch: spy })
    expect(items).toEqual([])
    expect(called).toBe(false)
  })

  it('HTTP 412 给出可读的风控提示，而不是 undici 的原始错误', async () => {
    // 实测本机连续请求第 2 次就 412，且带的是 text/html 的验证页。
    // 直接把响应体丢给 res.json() 会让用户看到
    // `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
    const fetch = (() =>
      Promise.resolve(
        new Response('<!DOCTYPE html><html>验证页</html>', {
          status: 412,
          headers: { 'content-type': 'text/html' },
        }),
      )) as unknown as typeof globalThis.fetch

    await expect(bilibiliSearchAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/风控/)
  })

  it('HTTP 200 但 code=-412 也要抛错 —— 风控不一定改状态码', async () => {
    const fetch = jsonFetch({ code: -412, message: '请求被拦截' })
    await expect(bilibiliSearchAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/-412/)
  })

  it('其他 HTTP 错误带上状态码', async () => {
    const fetch = jsonFetch({}, 503)
    await expect(bilibiliSearchAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/503/)
  })

  it('query 与 search_type 拼进查询串', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await bilibiliSearchAdapter.fetch({ ...ctx(), fetch: spy })
    expect(seen).toContain('search_type=video')
    expect(seen).toContain(`keyword=${encodeURIComponent('大模型')}`)
  })

  it('结果不满一页时不再翻页', async () => {
    let calls = 0
    const spy = (() => {
      calls += 1
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await bilibiliSearchAdapter.fetch({ ...ctx(), fetch: spy })
    expect(calls).toBe(1)
  })

  it('config.limit 超过一页时按页翻', async () => {
    // 第一页必须**装满** 20 条才会继续翻。用只有 3 条有效结果的 fixture
    // 测这条是测不出来的：它会因为「这一页不满」而正确地提前收工。
    const template = (payload as { data: { result: Record<string, unknown>[] } }).data.result[0]!
    const fullPage = Array.from({ length: 20 }, (_, i) => ({
      ...template,
      bvid: `BVpage1item${i}`,
      title: `第 ${i} 条大模型教程`,
    }))

    let calls = 0
    const spy = (() => {
      calls += 1
      return Promise.resolve(
        new Response(JSON.stringify({ code: 0, data: { result: fullPage } }), { status: 200 }),
      )
    }) as unknown as typeof globalThis.fetch

    await bilibiliSearchAdapter.fetch({ ...ctx({ limit: 25 }), fetch: spy })
    expect(calls).toBe(2)
  })
})
