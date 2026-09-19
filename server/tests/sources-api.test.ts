import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app.js'
import { createPrisma } from '../src/db.js'
import { loadEnv } from '../src/env.js'
import { registerBuiltinAdapters } from '../src/sources/index.js'

let prisma: PrismaClient

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
  registerBuiltinAdapters()
})

afterAll(() => prisma.$disconnect())

const app = () => createApp({ env: loadEnv({ NODE_ENV: 'test' }), prisma })

describe('GET /api/sources', () => {
  it('列出全部内置 adapter（六个采集类 + 六个搜索类）', async () => {
    const res = await request(app()).get('/api/sources')
    expect(res.status).toBe(200)
    // 搜索类（hn-algolia / reddit-search / github-search / bilibili-search /
    // sogou-weixin / bing-search）与采集类在同一张表里，因为它们都是 SourceAdapter。
    // 区分只体现在「要不要 config.query」。
    //
    // 这份清单是**精确罗列**，加适配器必须回来改这里——故意的：
    // 漏注册一个 adapter 时，症状是那个源静默不出现，而不是报错。
    expect(res.body.adapters.sort()).toEqual([
      'baidu-hot',
      'bilibili',
      'bilibili-search',
      'bing-search',
      'github-search',
      'github-trending',
      'hackernews',
      'hn-algolia',
      'reddit',
      'reddit-search',
      'rss',
      'sogou-weixin',
    ])
  })
})

describe('POST /api/sources', () => {
  it('未知 kind 返回 400 且错误里带可用 kind', async () => {
    const res = await request(app()).post('/api/sources').send({ kind: 'rsss', name: 'typo' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('UNKNOWN_SOURCE_KIND')
    expect(res.body.error.message).toContain('hackernews')
  })

  it('缺少 name 返回 400', async () => {
    const res = await request(app()).post('/api/sources').send({ kind: 'rss' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('合法请求返回 201 且 config 被解析成对象', async () => {
    const res = await request(app())
      .post('/api/sources')
      .send({ kind: 'rss', name: 'api-test-rss', config: { feeds: [] } })
    expect(res.status).toBe(201)
    expect(res.body.config).toEqual({ feeds: [] })
    await prisma.source.deleteMany({ where: { name: 'api-test-rss' } })
  })
})

describe('GET /api/items', () => {
  it('返回 { data, pagination } 信封', async () => {
    const res = await request(app()).get('/api/items?pageSize=5')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.pagination).toMatchObject({
      page: 1,
      pageSize: 5,
      total: expect.any(Number),
      totalPages: expect.any(Number),
    })
  })

  it('pageSize 上限被钳到 100，而不是把全库拉出来', async () => {
    const res = await request(app()).get('/api/items?pageSize=99999')
    expect(res.status).toBe(200)
    expect(res.body.pagination.pageSize).toBe(100)
  })
})
