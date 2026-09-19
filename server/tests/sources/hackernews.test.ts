import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { hackernewsAdapter } from '../../src/sources/hackernews.js'
import type { FetchContext } from '../../src/sources/types.js'

const fixtures = new URL('../fixtures/', import.meta.url)
const topstories = JSON.parse(readFileSync(new URL('hackernews-topstories.json', fixtures), 'utf8'))
const items = JSON.parse(readFileSync(new URL('hackernews-item.json', fixtures), 'utf8'))

/** 假 fetch：只认 HN 的两个端点，其余一律 404 */
function fakeFetch(url: string): Promise<Response> {
  if (url.endsWith('/topstories.json')) return Promise.resolve(Response.json(topstories))
  const m = /\/item\/(\d+)\.json$/.exec(url)
  if (m) {
    const id = m[1] as string
    if (items[id]) return Promise.resolve(Response.json(items[id]))
    return Promise.resolve(Response.json(null))
  }
  return Promise.resolve(new Response('not found', { status: 404 }))
}

function ctx(config: Record<string, unknown> = {}): FetchContext {
  return {
    sourceId: 'src-hn',
    config,
    fetch: fakeFetch as unknown as typeof globalThis.fetch,
    now: new Date('2026-09-15T00:00:00Z'),
  }
}

describe('hackernewsAdapter.fetch', () => {
  it('只保留 story，丢掉 comment 与 job', async () => {
    const out = await hackernewsAdapter.fetch(ctx())
    expect(out.map((i) => i.externalId)).toEqual(['hn:90001', 'hn:90002'])
  })

  it('externalId 带 hn: 前缀', async () => {
    const out = await hackernewsAdapter.fetch(ctx())
    expect(out.every((i) => i.externalId.startsWith('hn:'))).toBe(true)
  })

  it('没有外部链接的 Ask HN 回退到讨论页 URL', async () => {
    const out = await hackernewsAdapter.fetch(ctx())
    const ask = out.find((i) => i.externalId === 'hn:90002')
    expect(ask?.url).toBe('https://news.ycombinator.com/item?id=90002')
  })

  it('有外部链接的条目用外部 URL', async () => {
    const out = await hackernewsAdapter.fetch(ctx())
    expect(out.find((i) => i.externalId === 'hn:90001')?.url).toBe(
      'https://example.com/deepseek-coding',
    )
  })

  it('把秒级 time 转成 Date', async () => {
    const out = await hackernewsAdapter.fetch(ctx())
    expect(out.find((i) => i.externalId === 'hn:90001')?.publishedAt?.toISOString()).toBe(
      '2026-09-15T00:00:00.000Z',
    )
  })

  it('Ask HN 的正文进 summary', async () => {
    const out = await hackernewsAdapter.fetch(ctx())
    expect(out.find((i) => i.externalId === 'hn:90002')?.summary).toContain('missing important releases')
  })

  it('config.limit 生效', async () => {
    const out = await hackernewsAdapter.fetch(ctx({ limit: 2 }))
    expect(out).toHaveLength(2)
  })

  it('topstories 请求失败时抛错', async () => {
    const failing: FetchContext = {
      ...ctx(),
      fetch: (() => Promise.resolve(new Response('boom', { status: 500 }))) as unknown as typeof globalThis.fetch,
    }
    await expect(hackernewsAdapter.fetch(failing)).rejects.toThrow(/500/)
  })

  it('单条 item 拉取失败时跳过该条，不影响其余', async () => {
    const flaky = (url: string): Promise<Response> => {
      if (url.endsWith('/topstories.json')) return Promise.resolve(Response.json(topstories))
      if (url.includes('/item/90003.json')) return Promise.resolve(new Response('x', { status: 500 }))
      const m = /\/item\/(\d+)\.json$/.exec(url)
      return Promise.resolve(Response.json(items[m?.[1] ?? ''] ?? null))
    }
    const out = await hackernewsAdapter.fetch({
      ...ctx(),
      fetch: flaky as unknown as typeof globalThis.fetch,
    })
    expect(out.map((i) => i.externalId)).toEqual(['hn:90001', 'hn:90002'])
  })
})

describe('hackernewsAdapter.health', () => {
  it('端点可用时 ok', async () => {
    const ok = (url: string): Promise<Response> =>
      url.endsWith('/maxitem.json')
        ? Promise.resolve(Response.json(99999))
        : fakeFetch(url)
    const res = await hackernewsAdapter.health({
      ...ctx(),
      fetch: ok as unknown as typeof globalThis.fetch,
    })
    expect(res.ok).toBe(true)
  })

  it('网络异常时 ok=false 且带上原因', async () => {
    const res = await hackernewsAdapter.health({
      ...ctx(),
      fetch: (() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof globalThis.fetch,
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('ENOTFOUND')
  })
})
