import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { createPrisma } from '../src/db.js'
import { loadEnv } from '../src/env.js'

const prisma = createPrisma('file:./test.db')
afterAll(() => prisma.$disconnect())

function app() {
  return createApp({
    env: loadEnv({ NODE_ENV: 'test' }),
    prisma,
    startedAt: new Date('2026-09-15T00:00:00Z'),
  })
}

describe('GET /api/health', () => {
  it('返回 ok 与 uptime', async () => {
    const res = await request(app()).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.uptimeMs).toBe('number')
  })

  it('未知路由返回 404 JSON 而不是 HTML', async () => {
    const res = await request(app()).get('/api/nope')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('报告数据库连通', async () => {
    const res = await request(app()).get('/api/health')
    expect(res.body.db).toBe('ok')
  })
})
