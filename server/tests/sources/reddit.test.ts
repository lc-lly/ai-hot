import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseListing, redditAdapter } from '../../src/sources/reddit.js'
import type { FetchContext } from '../../src/sources/types.js'

const listing = JSON.parse(readFileSync(new URL('../fixtures/reddit-hot.json', import.meta.url), 'utf8'))

describe('parseListing', () => {
  it('过滤掉置顶帖', () => {
    const ids = parseListing(listing, 'LocalLLaMA').map((i) => i.externalId)
    expect(ids).not.toContain('reddit:t3_def456')
  })

  it('过滤掉 over_18 帖子', () => {
    const ids = parseListing(listing, 'LocalLLaMA').map((i) => i.externalId)
    expect(ids).not.toContain('reddit:t3_ghi789')
  })

  it('保留正常帖子', () => {
    const ids = parseListing(listing, 'LocalLLaMA').map((i) => i.externalId)
    expect(ids).toEqual(['reddit:t3_abc123'])
  })

  it('permalink 拼成绝对 URL', () => {
    const first = parseListing(listing, 'LocalLLaMA')[0]
    expect(first?.url).toBe(
      'https://www.reddit.com/r/LocalLLaMA/comments/abc123/deepseek_v5_benchmark_leak/',
    )
  })

  it('created_utc 秒转 Date', () => {
    const first = parseListing(listing, 'LocalLLaMA')[0]
    expect(first?.publishedAt?.toISOString()).toBe('2026-09-15T00:00:00.000Z')
  })

  it('selftext 进 summary', () => {
    expect(parseListing(listing, 'LocalLLaMA')[0]?.summary).toContain('Screenshots circulating')
  })

  it('selftext 为空时 summary 为 null', () => {
    const onlyEmpty = {
      data: { children: [{ kind: 't3', data: { ...listing.data.children[1].data, stickied: false, over_18: false } }] },
    }
    expect(parseListing(onlyEmpty, 'LocalLLaMA')[0]?.summary).toBeNull()
  })

  it('lang 为 en', () => {
    expect(parseListing(listing, 'LocalLLaMA')[0]?.lang).toBe('en')
  })

  it('结构不符时返回空数组而不抛错', () => {
    expect(parseListing({ nope: true }, 'LocalLLaMA')).toEqual([])
    expect(parseListing(null, 'LocalLLaMA')).toEqual([])
  })
})

describe('redditAdapter.fetch', () => {
  const okFetch = (() => Promise.resolve(Response.json(listing))) as unknown as typeof globalThis.fetch

  const ctx = (config: Record<string, unknown> = {}): FetchContext => ({
    sourceId: 'src-reddit',
    config,
    fetch: okFetch,
    now: new Date('2026-09-15T00:00:00Z'),
  })

  it('默认订阅 LocalLLaMA 与 MachineLearning', async () => {
    const seen: string[] = []
    const spy = ((url: string) => {
      seen.push(url)
      return Promise.resolve(Response.json(listing))
    }) as unknown as typeof globalThis.fetch
    await redditAdapter.fetch({ ...ctx(), fetch: spy })
    expect(seen.some((u) => u.includes('/r/LocalLLaMA/'))).toBe(true)
    expect(seen.some((u) => u.includes('/r/MachineLearning/'))).toBe(true)
  })

  it('config.subreddits 覆盖默认值', async () => {
    const seen: string[] = []
    const spy = ((url: string) => {
      seen.push(url)
      return Promise.resolve(Response.json(listing))
    }) as unknown as typeof globalThis.fetch
    await redditAdapter.fetch({ ...ctx({ subreddits: ['singularity'] }), fetch: spy })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('/r/singularity/')
  })

  it('limit 拼进查询串', async () => {
    let seen = ''
    const spy = ((url: string) => {
      seen = url
      return Promise.resolve(Response.json(listing))
    }) as unknown as typeof globalThis.fetch
    await redditAdapter.fetch({ ...ctx({ subreddits: ['x'], limit: 7 }), fetch: spy })
    expect(seen).toContain('limit=7')
  })

  it('单个 subreddit 失败不影响其余', async () => {
    const spy = ((url: string) => {
      if (url.includes('/r/bad/')) return Promise.resolve(new Response('x', { status: 403 }))
      return Promise.resolve(Response.json(listing))
    }) as unknown as typeof globalThis.fetch
    const out = await redditAdapter.fetch({ ...ctx({ subreddits: ['bad', 'good'] }), fetch: spy })
    expect(out.map((i) => i.externalId)).toEqual(['reddit:t3_abc123'])
  })

  it('全部 subreddit 都失败时抛错', async () => {
    const bad = (() => Promise.resolve(new Response('x', { status: 403 }))) as unknown as typeof globalThis.fetch
    await expect(redditAdapter.fetch({ ...ctx({ subreddits: ['bad'] }), fetch: bad })).rejects.toThrow(/403/)
  })
})
