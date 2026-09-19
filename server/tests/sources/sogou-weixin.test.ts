import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSearchPage, sogouWeixinAdapter } from '../../src/sources/sogou-weixin.js'
import { checkEngagement } from '../../src/pipeline/engagement.js'
import { metricsOf } from '../../src/score/metrics.js'
import type { FetchContext } from '../../src/sources/types.js'

const html = readFileSync(new URL('../fixtures/sogou-weixin.html', import.meta.url), 'utf8')
const blocked = readFileSync(
  new URL('../fixtures/sogou-weixin-blocked.html', import.meta.url),
  'utf8',
)

const htmlFetch = (body: string, status = 200) =>
  (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof globalThis.fetch

const ctx = (config: Record<string, unknown> = {}): FetchContext => ({
  sourceId: 'src-sogou',
  config: { query: '大模型', ...config },
  fetch: htmlFetch(html),
  now: new Date('2026-09-15T00:00:00Z'),
})

describe('parseSearchPage', () => {
  it('解析出全部有效结果', () => {
    // fixture 里 4 个 .txt-box，第四个标题是空白 → 丢掉
    expect(parseSearchPage(html, '大模型')).toHaveLength(3)
  })

  it('标题里的 <em> 高亮标记不会漏进文本', () => {
    expect(parseSearchPage(html, '大模型')[0]?.title).toBe('大模型落地这一年：从演示到生产')
  })

  it('summary 同样被清干净', () => {
    expect(parseSearchPage(html, '大模型')[0]?.summary).toBe(
      '过去一年里，真正把大模型跑进生产环境的团队，做的事情和 demo 阶段完全不同。',
    )
  })

  it('author 取的是公众号名 —— 它在 .all-time-y2 里，不是 .s2', () => {
    // 类名看起来像是「时间」，实际是公众号名；发布时间藏在隔壁 .s2 的脚本源码里。
    // 这两个搞反了不会有任何报错，只会让卡片上显示「作者：1789624932」
    expect(parseSearchPage(html, '大模型')[0]?.author).toBe('机器之心')
  })

  it('发布时间从 document.write(timeConvert(...)) 的脚本源码里抠出来', () => {
    // 页面上它是渲染出来的时间，在 HTML 源码里只是一段字符串，
    // 所以 $el.text() 拿不到，必须正则抠源码
    expect(parseSearchPage(html, '大模型')[0]?.publishedAt?.toISOString()).toBe(
      new Date(1789624932 * 1000).toISOString(),
    )
  })

  it('拿不到时间戳时 publishedAt 是 null，不编造', () => {
    const items = parseSearchPage(html, '大模型')
    const noTime = items.find((i) => i.title === '这条是直链，不经过搜狗跳转')
    expect(noTime?.publishedAt).toBeNull()
  })

  it('摘要为空时 summary 是 null，而不是空串', () => {
    const items = parseSearchPage(html, '大模型')
    const noSummary = items.find((i) => i.title === '这条是直链，不经过搜狗跳转')
    expect(noSummary?.summary).toBeNull()
  })

  it('站内跳转链接补上域名，直链原样保留', () => {
    const items = parseSearchPage(html, '大模型')
    expect(items[0]?.url).toMatch(/^https:\/\/weixin\.sogou\.com\/link\?/)
    const direct = items.find((i) => i.title === '这条是直链，不经过搜狗跳转')
    expect(direct?.url).toBe('https://mp.weixin.qq.com/s/AbCdEfGhIjK')
  })

  it('externalId 是短摘要，不含那串几百字符的 token', () => {
    // 链接带时效 token 且长达数百字符，塞进 DTO 的 id 里
    // 会让日志与 React key 都变得没法看
    const id = parseSearchPage(html, '大模型')[0]?.externalId
    expect(id).toMatch(/^sogou:[0-9a-f]{16}$/)
    expect(id).not.toContain('token')
  })

  it('同一批结果重复解析，externalId 稳定', () => {
    // 不稳定的话每次搜索都会「多出几条新内容」
    const first = parseSearchPage(html, '大模型').map((i) => i.externalId)
    const second = parseSearchPage(html, '大模型').map((i) => i.externalId)
    expect(first).toEqual(second)
  })

  it('lang 是 zh', () => {
    expect(parseSearchPage(html, '大模型')[0]?.lang).toBe('zh')
  })

  it('搜狗不提供任何互动计数 → 闸门放行，热度走 HEAT_FALLBACK', () => {
    // 这是设计好的行为，不是漏取。见 sources/sogou-weixin.ts 的 raw 注释
    const first = parseSearchPage(html, '大模型')[0]
    expect(metricsOf('sogou-weixin', first?.raw)).toEqual({})
    expect(checkEngagement('sogou-weixin', first?.raw)).toBeNull()
  })

  it('query 留在 raw 里，便于回溯这条是怎么搜出来的', () => {
    expect(parseSearchPage(html, '大模型')[0]?.raw).toMatchObject({ query: '大模型' })
  })

  it('被反爬拦截时**抛错**，而不是返回空数组', () => {
    // 静默返回空数组等于告诉用户「微信里没有这个话题」，而事实是被拦了
    expect(() => parseSearchPage(blocked, '大模型')).toThrow(/反爬拦截/)
  })

  it('错误信息里说明命中的是哪个特征词，而不是只说「被拦了」', () => {
    // 只说「被反爬拦截」的话，用户没法判断是自己请求太快了还是页面结构变了。
    // 这里不钉死是哪一个词——`BLOCK_MARKERS.find()` 按的是数组顺序，
    // 与特征词在页面里出现的先后无关，钉死会把测试绑在一个无关的实现细节上
    expect(() => parseSearchPage(blocked, '大模型')).toThrow(
      /被反爬拦截（页面出现「(请输入验证码|antispider|seccode|用户您好，您的访问过于频繁|您的访问出错了)」）/,
    )
  })

  it('正常但无结果的页面返回空数组，不是抛错', () => {
    // 「被拦了」和「确实没有结果」必须分开：前者要炸，后者只是空
    expect(parseSearchPage('<html><body><p>没有找到相关结果</p></body></html>', 'x')).toEqual([])
  })
})

describe('sogouWeixinAdapter.fetch', () => {
  it('没有 query 时返回空数组，且**不打网络**', async () => {
    // 定时采集会对每个源都调一次 fetch。搜索类源拿不到 query 就必须当场退出，
    // 否则每 15 分钟就往搜狗空搜一次 —— 那是白挨反爬
    let called = false
    const spy = (() => {
      called = true
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as unknown as typeof globalThis.fetch

    const items = await sogouWeixinAdapter.fetch({
      ...ctx(),
      config: {},
      fetch: spy,
    })
    expect(items).toEqual([])
    expect(called).toBe(false)
  })

  it('query 为空串同样跳过', async () => {
    let called = false
    const spy = (() => {
      called = true
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    const items = await sogouWeixinAdapter.fetch({ ...ctx({ query: '   ' }), fetch: spy })
    expect(items).toEqual([])
    expect(called).toBe(false)
  })

  it('query 拼进查询串', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await sogouWeixinAdapter.fetch({ ...ctx(), fetch: spy })
    expect(seen).toContain(`query=${encodeURIComponent('大模型')}`)
    expect(seen).toContain('type=2')
  })

  it('config.limit 截断结果', async () => {
    const items = await sogouWeixinAdapter.fetch(ctx({ limit: 2 }))
    expect(items).toHaveLength(2)
  })

  it('HTTP 非 2xx 时抛错', async () => {
    const fetch = htmlFetch('nope', 403)
    await expect(sogouWeixinAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/403/)
  })
})
