import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bingSearchAdapter } from '../../src/sources/bing-search.js'
import type { FetchContext } from '../../src/sources/types.js'

const xml = readFileSync(new URL('../fixtures/bing-search.xml', import.meta.url), 'utf8')

/** Bing 端点改版时返回的是首页 HTML —— 实测过一次，所以专门有这条用例 */
const HOME_HTML = '<!DOCTYPE html><html><head><title>Bing</title></head><body></body></html>'

const textFetch = (body: string, status = 200) =>
  (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof globalThis.fetch

const ctx = (config: Record<string, unknown> = {}): FetchContext => ({
  sourceId: 'src-bing',
  config: { query: '大模型', ...config },
  fetch: textFetch(xml),
  now: new Date('2026-09-15T00:00:00Z'),
})

describe('bingSearchAdapter.fetch', () => {
  it('解析出全部带链接的条目', async () => {
    // fixture 里 3 条，第三条没有 <link> → parseFeed 跳过
    const items = await bingSearchAdapter.fetch(ctx())
    expect(items).toHaveLength(2)
  })

  it('externalId 前缀是 bing:，且不把源名写两遍', async () => {
    // parseFeed 一律写 `rss:<feed名>:<guid>`，而这里 feed 名就是 'bing'。
    // 只换前缀会得到 `bing:bing:xxx`。externalId 只需在同一个源内唯一，
    // 源名本身由 sourceId 表达
    const first = (await bingSearchAdapter.fetch(ctx()))[0]
    expect(first?.externalId.startsWith('bing:')).toBe(true)
    expect(first?.externalId.startsWith('bing:bing:')).toBe(false)
    expect(first?.externalId).not.toContain('rss:')
  })

  it('author 是 null，不是「Bing」', async () => {
    // parseFeed 取不到作者会回落到 feed 名，卡片上就会出现
    // 「作者：Bing 网页搜索」这种把搜索引擎当作者显示的怪东西
    const items = await bingSearchAdapter.fetch(ctx())
    expect(items.map((i) => i.author)).toEqual([null, null])
  })

  it('标题里的 &amp; 被解码', async () => {
    const items = await bingSearchAdapter.fetch(ctx())
    expect(items[1]?.title).toBe('开源模型排行榜更新 & 评测方法说明')
  })

  it('摘要里的 &mdash; 命名实体被解码', async () => {
    // 实体没解码的话卡片上会显示「榜单口径变化 &mdash;&mdash; 从人工评测…」
    const items = await bingSearchAdapter.fetch(ctx())
    expect(items[1]?.summary).toBe('榜单口径变化 —— 从人工评测转向自动基准。')
  })

  it('publishedAt 从 pubDate 解析', async () => {
    const items = await bingSearchAdapter.fetch(ctx())
    expect(items[0]?.publishedAt?.toISOString()).toBe('2026-09-15T08:00:00.000Z')
  })

  it('lang 是 null —— 必应 RSS 不带语言标记，也不该瞎猜', async () => {
    const items = await bingSearchAdapter.fetch(ctx())
    expect(items[0]?.lang).toBeNull()
  })

  it('query 留在 raw 里，便于回溯这条是怎么搜出来的', async () => {
    const items = await bingSearchAdapter.fetch(ctx())
    expect(items[0]?.raw).toMatchObject({ query: '大模型' })
  })

  it('返回 HTML 而不是 XML 时**抛错**，不伪装成「搜不到」', async () => {
    // 这个端点真的失效过一次（news/search?format=RSS 变成 302 到首页）。
    // 静默返回空数组会伪装成「必应上搜不到这个关键词」，而事实是端点又变了
    const fetch = textFetch(HOME_HTML)
    await expect(bingSearchAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/没有返回 RSS/)
  })

  it('HTTP 非 2xx 时抛错并带上状态码', async () => {
    const fetch = textFetch('nope', 429)
    await expect(bingSearchAdapter.fetch({ ...ctx(), fetch })).rejects.toThrow(/429/)
  })

  it('没有 query 时返回空数组，且不打网络', async () => {
    let called = false
    const spy = (() => {
      called = true
      return Promise.resolve(new Response(xml, { status: 200 }))
    }) as unknown as typeof globalThis.fetch

    const items = await bingSearchAdapter.fetch({ ...ctx(), config: {}, fetch: spy })
    expect(items).toEqual([])
    expect(called).toBe(false)
  })

  it('config.query 与 config.q 都能用', async () => {
    // readQuery 认两个字段名：前端与监控词走 query，手写配置常写 q
    const items = await bingSearchAdapter.fetch({ ...ctx({ query: undefined, q: '大模型' }) })
    expect(items).toHaveLength(2)
  })

  it('使用 format=rss 的网页搜索端点', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(xml, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await bingSearchAdapter.fetch({ ...ctx(), fetch: spy })
    expect(seen).toContain('bing.com/search')
    expect(seen).toContain('format=rss')
  })

  it('config.limit 拼进 count 并截断结果', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(xml, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    const items = await bingSearchAdapter.fetch({ ...ctx({ limit: 1 }), fetch: spy })
    expect(seen).toContain('count=1')
    expect(items).toHaveLength(1)
  })

  it('带上浏览器 UA 与 Referer', async () => {
    let headers: Record<string, string> = {}
    const spy = ((_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(new Response(xml, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await bingSearchAdapter.fetch({ ...ctx(), fetch: spy })
    expect(headers['user-agent']).toContain('Mozilla')
    expect(headers['referer']).toBe('https://www.bing.com/')
  })
})
