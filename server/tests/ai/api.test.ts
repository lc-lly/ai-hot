import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { PrismaClient } from '@prisma/client'
import { aiRoutes } from '../../src/routes/ai.js'
import { errorHandler } from '../../src/errors.js'
import { silentAiLogger } from '../../src/ai/types.js'
import { createPrisma } from '../../src/db.js'
import { loadEnv, type Env } from '../../src/env.js'

let prisma: PrismaClient

function testEnv(over: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'file:./test.db',
    AI_MOCK: '1',
    AI_DAILY_TOKEN_BUDGET: '200000',
    ...over,
  })
}

/** 契约 §5.1：模块自己的测试用一个最小的 express 把 router 挂上去 */
function makeApp(env: Env, fetchImpl?: typeof globalThis.fetch) {
  const app = express()
  app.use(express.json())
  app.use(
    '/api',
    aiRoutes({ prisma, env, logger: silentAiLogger, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
  )
  app.use(errorHandler)
  return app
}

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
})

afterAll(() => prisma.$disconnect())

beforeEach(async () => {
  await prisma.aiCall.deleteMany({})
  await prisma.aiCache.deleteMany({})
})

describe('GET /api/ai/stats（契约 §4 冻结形状）', () => {
  it('返回 today / byModel / budget 三段', async () => {
    const res = await request(makeApp(testEnv())).get('/api/ai/stats')
    expect(res.status).toBe(200)
    expect(res.body.today).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 })
    expect(Array.isArray(res.body.byModel)).toBe(true)
    expect(res.body.budget).toEqual({ limit: 200000, used: 0, degraded: false })
  })

  it('调用之后用量被计入', async () => {
    const app = makeApp(testEnv())
    await request(app).post('/api/ai/verify').send({ text: 'Cursor 发布了新版本', topic: 'Cursor' })
    const res = await request(app).get('/api/ai/stats')
    expect(res.body.today.calls).toBeGreaterThan(0)
    expect(res.body.today.tokensIn).toBeGreaterThan(0)
    expect(res.body.byModel[0].model).toBeTruthy()
    expect(res.body.byModel[0].calls).toBeGreaterThan(0)
  })

  it('超出预算时 degraded 为 true', async () => {
    await prisma.aiCall.create({
      data: {
        purpose: 'seed',
        model: 'deepseek-v4-pro',
        promptHash: 'seed-stats',
        promptTokens: 500_000,
        completionTokens: 0,
        latencyMs: 0,
        ok: true,
      },
    })
    const res = await request(makeApp(testEnv({ AI_DAILY_TOKEN_BUDGET: '200000' }))).get(
      '/api/ai/stats',
    )
    expect(res.body.budget.degraded).toBe(true)
    expect(res.body.budget.used).toBe(500_000)
  })
})

describe('POST /api/ai/verify（契约 §4，供 Agent Skill 的 verify 用）', () => {
  it('返回 ItemScore 的六个字段', async () => {
    const res = await request(makeApp(testEnv()))
      .post('/api/ai/verify')
      .send({
        text: 'Cursor 发布新版本，官方博客给出 benchmark 数据与发布日期。',
        topic: 'Cursor',
      })

    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(
      ['authenticity', 'confidence', 'flags', 'reasoning', 'relevance', 'tier'].sort(),
    )
    expect(typeof res.body.relevance).toBe('number')
    expect(typeof res.body.authenticity).toBe('number')
    expect(typeof res.body.confidence).toBe('number')
    expect(Array.isArray(res.body.flags)).toBe(true)
    expect(typeof res.body.reasoning).toBe('string')
    expect(['push', 'pending', 'filtered']).toContain(res.body.tier)
  })

  it('标题党内容拿到 clickbait 标签与低分', async () => {
    const res = await request(makeApp(testEnv()))
      .post('/api/ai/verify')
      .send({ text: '震惊！这个工具彻底杀疯了\n限时优惠，加微信领取', topic: 'AI 编程' })
    expect(res.status).toBe(200)
    expect(res.body.flags).toContain('clickbait')
    expect(res.body.flags).toContain('ad')
    expect(res.body.authenticity).toBeLessThan(0.8)
    expect(res.body.tier).not.toBe('push')
  })

  it('只给 url 也能判', async () => {
    const res = await request(makeApp(testEnv()))
      .post('/api/ai/verify')
      .send({ url: 'https://example.com/cursor-2-0' })
    expect(res.status).toBe(200)
    expect(res.body.authenticity).toBeGreaterThan(0)
  })

  it('url 与 text 都不给 → 400 BAD_REQUEST', async () => {
    const res = await request(makeApp(testEnv())).post('/api/ai/verify').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('空白字符串等同于没给', async () => {
    const res = await request(makeApp(testEnv())).post('/api/ai/verify').send({ text: '   ' })
    expect(res.status).toBe(400)
  })

  it('非法 JSON 之外的怪入参不炸（topic 传数字等）', async () => {
    const res = await request(makeApp(testEnv()))
      .post('/api/ai/verify')
      .send({ text: 'Cursor 发布了新版本', topic: 123 })
    expect(res.status).toBe(200)
  })
})

describe('AI 不可用时的行为（硬要求：空 API key 不能崩）', () => {
  it('没有 key 且 AI_MOCK=0 → 503 NO_API_KEY，而不是 500', async () => {
    let fetchCalls = 0
    const app = makeApp(testEnv({ AI_MOCK: '0', DEEPSEEK_API_KEY: '' }), (async () => {
      fetchCalls += 1
      throw new Error('不该联网')
    }) as unknown as typeof globalThis.fetch)

    const res = await request(app).post('/api/ai/verify').send({ text: '任意内容' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('NO_API_KEY')
    expect(fetchCalls).toBe(0)
  })

  it('没有 key 时 /api/ai/stats 仍然正常工作', async () => {
    const app = makeApp(testEnv({ AI_MOCK: '0', DEEPSEEK_API_KEY: '' }))
    const res = await request(app).get('/api/ai/stats')
    expect(res.status).toBe(200)
    expect(res.body.budget.limit).toBe(200000)
  })

  it('没有 DEEPSEEK_API_KEY 的 env 也能把 router 建起来（不抛）', () => {
    const env = testEnv({ AI_MOCK: '0', DEEPSEEK_API_KEY: '' })
    expect(() => makeApp(env)).not.toThrow()
  })
})
