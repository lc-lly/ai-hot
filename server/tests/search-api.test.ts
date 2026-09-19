import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createPrisma } from '../src/db.js'
import { errorHandler } from '../src/errors.js'
import { __clearSearchCache, searchRoutes } from '../src/routes/search.js'
import { registerBuiltinAdapters } from '../src/sources/index.js'

/**
 * `GET /api/search` 的契约测试。全部走假 fetch，**不联网**。
 *
 * 三个外部 API 里两个有限流、一个会返回 403，所以「部分失败」是这个端点
 * 的常态而不是异常——测试的重点也在这里。
 */

const HN_URL = 'https://a.com/langchain-post'
const OTHER_URL = 'https://a.com/other-post'

/** 同一条链接被提交了两次：老帖在前、热帖在后（Algolia 按相关度返回，不按热度）。 */
const HN = {
  hits: [
    { objectID: 'old', title: 'LangChain 老帖（没人理）', url: HN_URL, points: 3, num_comments: 0 },
    { objectID: 'hot', title: 'LangChain 热帖', url: HN_URL, points: 400, num_comments: 88 },
    { objectID: 'other', title: '另一篇', url: OTHER_URL, points: 20, num_comments: 1 },
  ],
}

const REDDIT = {
  data: {
    children: [
      {
        data: {
          id: 'x1',
          name: 't3_x1',
          title: 'LangChain 讨论',
          permalink: '/r/LLM/comments/x1/',
          author: 'someone',
          created_utc: 1_760_000_000,
          score: 500,
          num_comments: 12,
        },
      },
    ],
  },
}

/** 只有 hn-algolia 与 reddit-search 拿到固定响应；github 按 opts 走。 */
function fakeFetch(opts: { githubStatus?: number } = {}) {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('hn.algolia.com')) {
      return { ok: true, status: 200, json: async () => HN } as unknown as Response
    }
    if (url.includes('reddit.com')) {
      return { ok: true, status: 200, json: async () => REDDIT } as unknown as Response
    }
    const status = opts.githubStatus ?? 200
    return {
      ok: status < 300,
      status,
      json: async () => ({ items: [], message: 'rate limited' }),
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch
  return { impl, calls }
}

let prisma: PrismaClient

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
  registerBuiltinAdapters()
})

// 缓存是模块级 Map，跨用例会串——每个用例都从冷启动开始
beforeEach(() => __clearSearchCache())
afterAll(() => prisma.$disconnect())

function app(fetchImpl: typeof globalThis.fetch, sourceTimeoutMs?: number) {
  const a = express()
  a.use(express.json())
  a.use('/api', searchRoutes({ prisma, fetch: fetchImpl, sourceTimeoutMs }))
  a.use(errorHandler)
  return a
}

describe('GET /api/search', () => {
  it('缺少 q 返回 400', async () => {
    const { impl } = fakeFetch()
    const res = await request(app(impl)).get('/api/search')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('未知 kinds 返回 400 而不是静默忽略', async () => {
    const { impl } = fakeFetch()
    const res = await request(app(impl)).get('/api/search?q=x&kinds=not-a-kind')
    expect(res.status).toBe(400)
  })

  it('返回 { data, pagination } 信封，data 是「未评估」的 ItemDTO', async () => {
    const { impl } = fakeFetch()
    const res = await request(app(impl)).get('/api/search?q=langchain')

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.pagination.total).toBe(res.body.data.length)

    const first = res.body.data[0]
    // 搜索结果是**临时的**：id 带前缀，且从来没被 AI 评过
    expect(String(first.id)).toMatch(/^search:/)
    // 三态：没评估必须是 null，不是 0——0 会被读成「AI 认定是假的」
    expect(first.authenticity).toBeNull()
    expect(first.match).toBeNull()
    expect(first.aiState).toBe('pending')
  })

  it('同一条 URL 只留一条，且留下的是热度最高的那条', async () => {
    const { impl } = fakeFetch()
    const res = await request(app(impl)).get('/api/search?q=langchain')

    const dups = res.body.data.filter((i: { url: string }) => i.url === HN_URL)
    expect(dups).toHaveLength(1)
    // 命中顺序是源返回的顺序，先到的是那条 3 分的老帖。
    // 「先到先留」会把它留下来，于是用户看到的是一条没人理的链接。
    expect(dups[0].title).toBe('LangChain 热帖')
  })

  it('按热度降序', async () => {
    const { impl } = fakeFetch()
    const res = await request(app(impl)).get('/api/search?q=langchain')
    const heats = res.body.data.map((i: { heat: number }) => i.heat)
    expect(heats).toEqual([...heats].sort((a: number, b: number) => b - a))
  })

  it('一个源失败时其余源照常返回，且失败被如实报告', async () => {
    const { impl } = fakeFetch({ githubStatus: 403 })
    const res = await request(app(impl)).get('/api/search?q=langchain')

    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)

    const github = res.body.sources.find((s: { kind: string }) => s.kind === 'github-search')
    // 静默少掉三分之一的结果，用户会以为「全网只有这几条」
    expect(github.ok).toBe(false)
    expect(github.error).toContain('限流')

    const hn = res.body.sources.find((s: { kind: string }) => s.kind === 'hn-algolia')
    expect(hn.ok).toBe(true)
  })

  it('全部源都失败时返回空列表 + 失败报告，而不是 500', async () => {
    const impl = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof globalThis.fetch

    const res = await request(app(impl)).get('/api/search?q=langchain')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    // 六个搜索类源全挂：HN Algolia / Reddit / GitHub / B站 / 搜狗 / Bing
    expect(res.body.sources).toHaveLength(6)
    expect(res.body.sources.every((s: { ok: boolean }) => !s.ok)).toBe(true)
  })

  it('kinds 可以只要一个源', async () => {
    const { impl } = fakeFetch()
    const res = await request(app(impl)).get('/api/search?q=langchain&kinds=hn-algolia')
    expect(res.body.sources.map((s: { kind: string }) => s.kind)).toEqual(['hn-algolia'])
    expect(res.body.data.every((i: { source: { kind: string } }) => i.source.kind === 'hn-algolia')).toBe(true)
  })

  it('60 秒内重复查询命中缓存，不再打外部接口', async () => {
    const { impl, calls } = fakeFetch()
    await request(app(impl)).get('/api/search?q=cache-me')
    const afterFirst = calls.length
    expect(afterFirst).toBeGreaterThan(0)

    const second = await request(app(impl)).get('/api/search?q=cache-me')
    expect(second.body.cached).toBe(true)
    // 不缓存的话，用户改一下筛选再返回就会重新打三个外部接口，
    // 未认证的 GitHub 搜索 10 次/分钟很快被打满
    expect(calls.length).toBe(afterFirst)
  })
})

/**
 * 这两个用例针对的是**真机上实测出来的**问题，不是假想：
 *
 * 本机 `reddit.com` 的 www / old / api 三个域名全部在 TCP 连接阶段超时，
 * 每次搜索让整个响应从 1.4 秒拖到 10.6 秒（HN 与 GitHub 其实 1.4 秒就回来了，
 * 是 `Promise.all` 在等那个永远不回来的源），而用户在徽章上看到的失败原因是
 * undici 的四个字——「fetch failed」。
 */
describe('GET /api/search：源失败的可读性与耗时', () => {
  it('连接层失败要说清是哪一种，而不是 undici 的 fetch failed', async () => {
    const impl = (async () => {
      const err = new Error('fetch failed')
      // undici 把**所有**连接层失败都措辞成 "fetch failed"，真正的原因在这里
      ;(err as { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }
      throw err
    }) as unknown as typeof globalThis.fetch

    const res = await request(app(impl)).get('/api/search?q=x&kinds=reddit-search')
    const report = res.body.sources[0]

    expect(report.ok).toBe(false)
    // 「fetch failed」既没说是超时还是被墙，也没说该不该重试——等于没报
    expect(report.error).not.toBe('fetch failed')
    expect(report.error).toContain('连接超时')
    // 原始错误码要留着：它是唯一能让用户自己去查的东西
    expect(report.error).toContain('UND_ERR_CONNECT_TIMEOUT')
  })

  it('DNS 解析失败与连接超时给的是不同的说法', async () => {
    const impl = (async () => {
      const err = new Error('fetch failed')
      ;(err as { cause?: unknown }).cause = { code: 'ENOTFOUND' }
      throw err
    }) as unknown as typeof globalThis.fetch

    const res = await request(app(impl)).get('/api/search?q=x&kinds=reddit-search')
    expect(res.body.sources[0].error).toContain('域名解析失败')
  })

  it('一个挂死的源不能把整个响应拖到它自己的超时', async () => {
    const impl = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('hn.algolia.com')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => HN } as unknown as Response)
      }
      if (url.includes('github.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ items: [], message: 'ok' }),
        } as unknown as Response)
      }
      // reddit：永不响应，但**必须**响应 abort——真实的 fetch 就是这样。
      // 模拟「挂了但不理会 signal」是没意义的，那样连 `Promise.all` 都救不了。
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }) as unknown as typeof globalThis.fetch

    const startedAt = Date.now()
    const res = await request(app(impl, 150)).get('/api/search?q=langchain')
    const elapsed = Date.now() - startedAt

    // 其余源的结果照常返回，不该被一个死源连坐
    expect(res.body.data.length).toBeGreaterThan(0)

    const reddit = res.body.sources.find((s: { kind: string }) => s.kind === 'reddit-search')
    expect(reddit.ok).toBe(false)
    expect(reddit.error).toContain('超时')

    // 真机上源自己的 TCP 超时是 10.6 秒。这里给 150ms 的闸门，
    // 整个请求必须远早于「等源自己放弃」就返回
    expect(elapsed).toBeLessThan(2000)
  })
})
