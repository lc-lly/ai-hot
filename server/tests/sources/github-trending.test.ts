import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { githubTrendingAdapter, parseTrendingHtml } from '../../src/sources/github-trending.js'
import type { FetchContext } from '../../src/sources/types.js'

const html = readFileSync(new URL('../fixtures/github-trending.html', import.meta.url), 'utf8')

describe('parseTrendingHtml', () => {
  it('解析出全部仓库', () => {
    expect(parseTrendingHtml(html)).toHaveLength(3)
  })

  it('externalId 与 url 由仓库全名拼出', () => {
    const first = parseTrendingHtml(html)[0]
    expect(first?.externalId).toBe('gh:deepseek-ai/DeepSeek-Coder')
    expect(first?.url).toBe('https://github.com/deepseek-ai/DeepSeek-Coder')
  })

  it('标题是仓库全名，不夹带作者 span 的文字重复', () => {
    expect(parseTrendingHtml(html)[0]?.title).toBe('deepseek-ai/DeepSeek-Coder')
  })

  it('描述里的 HTML 实体被解码', () => {
    expect(parseTrendingHtml(html)[0]?.summary).toBe('A coding assistant model & toolkit.')
  })

  it('抓出主要语言', () => {
    expect(parseTrendingHtml(html)[0]?.lang).toBe('Python')
  })

  it('语言缺失时为 null', () => {
    expect(parseTrendingHtml(html)[2]?.lang).toBeNull()
  })

  it('描述缺失时为 null', () => {
    expect(parseTrendingHtml(html)[2]?.summary).toBeNull()
  })

  it('author 是仓库 owner', () => {
    expect(parseTrendingHtml(html)[1]?.author).toBe('acme')
  })

  it('publishedAt 为 null —— Trending 页面不提供发布时间', () => {
    expect(parseTrendingHtml(html)[0]?.publishedAt).toBeNull()
  })

  it('原始 star 文案保留在 raw 里', () => {
    expect(parseTrendingHtml(html)[0]?.raw).toMatchObject({ starsToday: '1,234 stars today' })
  })

  it('空 HTML 返回空数组而不是抛错', () => {
    expect(parseTrendingHtml('<html><body></body></html>')).toEqual([])
  })
})

describe('githubTrendingAdapter.fetch', () => {
  const okFetch = (() => Promise.resolve(new Response(html, { status: 200 }))) as unknown as typeof globalThis.fetch

  const ctx = (config: Record<string, unknown> = {}): FetchContext => ({
    sourceId: 'src-gh',
    config,
    fetch: okFetch,
    now: new Date('2026-09-15T00:00:00Z'),
  })

  it('默认请求 daily', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await githubTrendingAdapter.fetch({ ...ctx(), fetch: spy })
    expect(seen).toContain('since=daily')
  })

  it('config.language 拼进路径', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(new Response(html, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    await githubTrendingAdapter.fetch({ ...ctx({ language: 'typescript' }), fetch: spy })
    expect(seen).toContain('/trending/typescript')
  })

  it('HTTP 非 2xx 时抛错', async () => {
    const bad = (() => Promise.resolve(new Response('nope', { status: 429 }))) as unknown as typeof globalThis.fetch
    await expect(githubTrendingAdapter.fetch({ ...ctx(), fetch: bad })).rejects.toThrow(/429/)
  })
})
