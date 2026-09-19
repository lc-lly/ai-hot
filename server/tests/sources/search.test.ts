import { describe, expect, it } from 'vitest'
import { githubSearchAdapter, parseRepos } from '../../src/sources/github-search.js'
import { hnAlgoliaAdapter, parseHits } from '../../src/sources/hn-algolia.js'
import { readQuery } from '../../src/sources/query.js'
import { redditSearchAdapter } from '../../src/sources/reddit-search.js'
import type { FetchContext } from '../../src/sources/types.js'

/**
 * 三个搜索类适配器的测试。
 *
 * 全部走 fixture + 假 fetch，**不碰网络**——外网连不通时测试照样要能跑，
 * 否则「今天 GitHub 抽风」会被误读成「代码写错了」。
 */

const NOW = new Date('2026-09-16T00:00:00Z')

function ctx(config: Record<string, unknown>, fetchImpl: typeof globalThis.fetch): FetchContext {
  return { sourceId: 'test', config, fetch: fetchImpl, now: NOW }
}

/** 最小可用的 Response 替身。只实现适配器真正用到的 `ok` / `status` / `json`。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** 记录请求过的 URL，供断言「有没有发请求」「带了什么参数」。 */
function recorder(body: unknown, status = 200) {
  const urls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input))
    return jsonResponse(body, status)
  }) as unknown as typeof globalThis.fetch
  return { impl, urls }
}

describe('readQuery', () => {
  it('query 缺失返回 null', () => {
    expect(readQuery(ctx({}, globalThis.fetch))).toBeNull()
  })

  it('全空白也算缺失', () => {
    expect(readQuery(ctx({ query: '   ' }, globalThis.fetch))).toBeNull()
  })

  it('q 是 query 的别名', () => {
    expect(readQuery(ctx({ q: ' langchain ' }, globalThis.fetch))).toBe('langchain')
  })
})

describe('hn-algolia', () => {
  it('没有 query 时一条请求都不发', async () => {
    const { impl, urls } = recorder({ hits: [] })
    const items = await hnAlgoliaAdapter.fetch(ctx({}, impl))
    expect(items).toEqual([])
    // 这是本适配器最重要的行为：它在 registry 里，collect 会遍历到它
    expect(urls).toHaveLength(0)
  })

  it('query 进了 URL，且带 story 标签与时间下限', async () => {
    const { impl, urls } = recorder({ hits: [] })
    await hnAlgoliaAdapter.fetch(ctx({ query: 'claude code' }, impl))
    const url = urls[0] ?? ''
    expect(url).toContain('query=claude%20code')
    expect(url).toContain('tags=story')
    expect(url).toContain('numericFilters=created_at_i>')
  })

  it('raw 的字段名与 hackernews 对齐，好让 heat 复用同一套解析', () => {
    const items = parseHits({
      hits: [{ objectID: '1', title: 'T', url: 'https://a.com', points: 120, num_comments: 30 }],
    })
    expect(items[0]?.raw).toEqual({ score: 120, descendants: 30, hnId: '1' })
  })

  it('Ask HN 这类没有外链的条目回落到讨论页', () => {
    const items = parseHits({ hits: [{ objectID: '42', title: 'Ask HN: 怎么办' }] })
    expect(items[0]?.url).toBe('https://news.ycombinator.com/item?id=42')
  })

  it('story_text 里的 HTML 被剥掉', () => {
    const items = parseHits({
      hits: [{ objectID: '1', title: 'T', story_text: '<p>hello</p> <b>world</b>' }],
    })
    expect(items[0]?.summary).toBe('hello world')
  })

  it('缺标题或 objectID 的命中被跳过', () => {
    const items = parseHits({ hits: [{ objectID: '1' }, { title: '没 id' }, {}] })
    expect(items).toEqual([])
  })

  it('结构完全不符时返回空数组而不是抛', () => {
    expect(parseHits(null)).toEqual([])
    expect(parseHits({ hits: 'nope' })).toEqual([])
  })
})

describe('reddit-search', () => {
  it('没有 query 时不发请求', async () => {
    const { impl, urls } = recorder({ data: { children: [] } })
    expect(await redditSearchAdapter.fetch(ctx({}, impl))).toEqual([])
    expect(urls).toHaveLength(0)
  })

  it('显式带上 restrict_sr=0', async () => {
    const { impl, urls } = recorder({ data: { children: [] } })
    await redditSearchAdapter.fetch(ctx({ query: 'llm' }, impl))
    // 不写出来，语义就依赖服务端「URL 里没有 /r/ 时默认全站搜」这个隐式规则
    expect(urls[0]).toContain('restrict_sr=0')
  })

  it('非法 sort 回落到 relevance', async () => {
    const { impl, urls } = recorder({ data: { children: [] } })
    await redditSearchAdapter.fetch(ctx({ query: 'llm', sort: 'DROP TABLE' }, impl))
    expect(urls[0]).toContain('sort=relevance')
  })
})

describe('github-search', () => {
  it('没有 query 时不发请求', async () => {
    const { impl, urls } = recorder({ items: [] })
    expect(await githubSearchAdapter.fetch(ctx({}, impl))).toEqual([])
    expect(urls).toHaveLength(0)
  })

  it('过滤掉 fork 与归档仓库', () => {
    const items = parseRepos(
      {
        items: [
          { id: 1, full_name: 'a/b', html_url: 'https://github.com/a/b' },
          { id: 2, full_name: 'c/d', html_url: 'https://x', fork: true },
          { id: 3, full_name: 'e/f', html_url: 'https://x', archived: true },
        ],
      },
      'q',
    )
    expect(items.map((i) => i.title)).toEqual(['a/b'])
  })

  it('publishedAt 取 pushed_at——建仓早但最近活跃的仓库不该被判成陈旧', () => {
    const items = parseRepos(
      {
        items: [
          {
            id: 1,
            full_name: 'a/b',
            html_url: 'https://github.com/a/b',
            created_at: '2019-01-01T00:00:00Z',
            pushed_at: '2026-09-15T00:00:00Z',
          },
        ],
      },
      'q',
    )
    expect(items[0]?.publishedAt?.toISOString()).toBe('2026-09-15T00:00:00.000Z')
  })

  it('star 总数进 raw.stars（不是 starsToday）', () => {
    const items = parseRepos(
      { items: [{ id: 1, full_name: 'a/b', html_url: 'https://x', stargazers_count: 12345 }] },
      'q',
    )
    expect(items[0]?.raw).toMatchObject({ stars: 12345 })
    expect((items[0]?.raw as Record<string, unknown>)['starsToday']).toBeUndefined()
  })

  it('被限流时抛出可读的错误，而不是假装没有结果', async () => {
    const { impl } = recorder({ message: 'rate limit' }, 403)
    await expect(githubSearchAdapter.fetch(ctx({ query: 'x' }, impl))).rejects.toThrow(/限流/)
  })
})
