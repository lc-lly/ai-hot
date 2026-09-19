import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { logRoutes } from '../../src/routes/logs.js'
import { LogBus } from '../../src/realtime/logbus.js'

function appWith(bus: LogBus) {
  const app = express()
  app.use(express.json())
  app.use('/api', logRoutes({ logBus: bus }))
  return app
}

describe('GET /api/logs', () => {
  it('返回 count 与 logs，新的在前', async () => {
    const bus = new LogBus({ now: () => new Date('2026-09-15T12:00:00.000Z') })
    bus.log({ channel: 'fetch', message: '抓取开始' })
    bus.log({ channel: 'ai', message: 'token 用量 1200' })

    const res = await request(appWith(bus)).get('/api/logs')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    expect(res.body.logs.map((l: { message: string }) => l.message)).toEqual([
      'token 用量 1200',
      '抓取开始',
    ])
  })

  it('每条带 id/ts/level/channel/message，轮询兜底靠 ts 排序', async () => {
    const bus = new LogBus({ now: () => new Date('2026-09-15T12:00:00.000Z') })
    bus.log({ channel: 'notify', level: 'error', message: '邮件发送失败', meta: { to: 'a@b.c' } })

    const res = await request(appWith(bus)).get('/api/logs')
    expect(res.body.logs[0]).toEqual({
      id: expect.any(String),
      ts: '2026-09-15T12:00:00.000Z',
      level: 'error',
      channel: 'notify',
      message: '邮件发送失败',
      meta: { to: 'a@b.c' },
    })
  })

  it('limit 生效，默认 200，脏值退回默认', async () => {
    const bus = new LogBus()
    for (let i = 1; i <= 250; i += 1) bus.log({ channel: 'system', message: `m${i}` })

    const limited = await request(appWith(bus)).get('/api/logs?limit=3')
    expect(limited.body.logs.map((l: { message: string }) => l.message)).toEqual(['m250', 'm249', 'm248'])

    const def = await request(appWith(bus)).get('/api/logs')
    expect(def.body.count).toBe(200)
    expect(def.body.logs[0].message).toBe('m250')

    const junk = await request(appWith(bus)).get('/api/logs?limit=abc')
    expect(junk.body.count).toBe(200)

    const zero = await request(appWith(bus)).get('/api/logs?limit=0')
    expect(zero.body.count).toBe(1)

    const neg = await request(appWith(bus)).get('/api/logs?limit=-5')
    expect(neg.body.count).toBe(1)
  })

  it('缓冲为空时返回空数组而不是报错', async () => {
    const res = await request(appWith(new LogBus())).get('/api/logs')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ count: 0, logs: [] })
  })

  it('deps 可省略，回落到进程级单例', async () => {
    const app = express()
    app.use('/api', logRoutes())
    const res = await request(app).get('/api/logs')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.logs)).toBe(true)
  })
})
