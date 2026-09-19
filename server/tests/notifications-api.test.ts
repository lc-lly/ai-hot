import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app.js'
import { createPrisma } from '../src/db.js'
import { loadEnv } from '../src/env.js'
import { createNotifier } from '../src/notify/index.js'
import { registerBuiltinAdapters } from '../src/sources/index.js'

/**
 * `/api/notifications` 与 `/api/settings` 的契约测试。
 *
 * 这两个端点是前端 `net/api.ts` 直接照着的形状写的，改字段先改前端。
 */

let prisma: PrismaClient

/** 干净的 env：三个可选渠道的凭据全部缺席，只应该剩下 inapp。 */
const bareEnv = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
  registerBuiltinAdapters()
})

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { title: { startsWith: 'notif-test' } } })
})

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { title: { startsWith: 'notif-test' } } })
  await prisma.setting.deleteMany({ where: { key: { startsWith: 'notify.email' } } })
  await prisma.$disconnect()
})

const app = () => createApp({ env: bareEnv, prisma })

describe('GET /api/notifications', () => {
  it('返回 { data: [...] } 且形状符合 NotificationDTO', async () => {
    await prisma.notification.create({
      data: { level: 'push', title: 'notif-test 一条', body: '正文', channels: '["inapp"]' },
    })

    const res = await request(app()).get('/api/notifications')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)

    const row = res.body.data.find((n: { title: string }) => n.title === 'notif-test 一条')
    expect(row).toMatchObject({ level: 'push', read: false, channels: ['inapp'] })
    // createdAt 是 NotificationDTO 的字段名，不是数据库里的 sentAt
    expect(typeof row.createdAt).toBe('string')
  })

  it('脏 level 降级为 pending 而不是原样透传', async () => {
    await prisma.notification.create({
      data: { level: 'urgent', title: 'notif-test 脏值', body: '' },
    })
    const res = await request(app()).get('/api/notifications')
    const row = res.body.data.find((n: { title: string }) => n.title === 'notif-test 脏值')
    expect(row.level).toBe('pending')
  })

  it('unread=1 只返回未读', async () => {
    await prisma.notification.create({
      data: { title: 'notif-test 已读', body: '', read: true },
    })
    const res = await request(app()).get('/api/notifications?unread=1')
    const titles = res.body.data.map((n: { title: string }) => n.title)
    expect(titles).not.toContain('notif-test 已读')
  })
})

describe('已读', () => {
  it('单条已读', async () => {
    const row = await prisma.notification.create({
      data: { title: 'notif-test 单条', body: '' },
    })
    const res = await request(app()).post(`/api/notifications/${row.id}/read`)
    expect(res.status).toBe(200)
    expect(res.body.data.read).toBe(true)
  })

  it('不存在的 id 返回 404', async () => {
    const res = await request(app()).post('/api/notifications/nope/read')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('全部已读只影响未读的', async () => {
    await prisma.notification.createMany({
      data: [
        { title: 'notif-test a', body: '' },
        { title: 'notif-test b', body: '' },
      ],
    })
    const res = await request(app()).post('/api/notifications/read-all')
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toBeGreaterThanOrEqual(2)
    expect(await prisma.notification.count({ where: { read: false } })).toBe(0)
  })
})

describe('GET /api/notifications/channels', () => {
  it('没有 SMTP / VAPID 时只有 inapp 可用，且说明原因', async () => {
    const res = await request(app()).get('/api/notifications/channels')
    expect(res.status).toBe(200)

    const byName: Record<string, { enabled: boolean; reason: string | null }> =
      Object.fromEntries(res.body.data.map((c: { name: string }) => [c.name, c]))
    expect(byName['inapp']?.enabled).toBe(true)
    expect(byName['email']?.enabled).toBe(false)
    // 「为什么没收到邮件」必须能在这里查到答案，而不是只有一个 false
    expect(byName['email']?.reason).toContain('SMTP_URL')
    expect(byName['webpush']?.enabled).toBe(false)
  })
})

describe('createNotifier', () => {
  it('请求了不可用的渠道时，只报告实际投递的', async () => {
    const notify = createNotifier({ prisma, env: bareEnv })
    const outcome = await notify({
      level: 'push',
      title: 'notif-test 渠道',
      body: '正文',
      channels: ['inapp', 'email', 'webpush'],
    })

    // 回显请求过的渠道是错的：通知行上会写着两个从没发生过的投递
    expect(outcome.channels).toEqual(['inapp'])
  })

  it('落一行 Notification，channels 是实际投递的那组', async () => {
    const notify = createNotifier({ prisma, env: bareEnv })
    const outcome = await notify({
      level: 'pending',
      title: 'notif-test 落库',
      body: '正文',
    })

    const row = await prisma.notification.findUnique({ where: { id: outcome.notificationId ?? '' } })
    expect(row?.title).toBe('notif-test 落库')
    expect(JSON.parse(row?.channels ?? '[]')).toEqual(['inapp'])
  })
})

describe('/api/settings', () => {
  it('未知键 400，并列出可用键', async () => {
    const res = await request(app()).put('/api/settings/not.a.key').send({ value: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('notify.email')
  })

  it('写入后读回', async () => {
    const put = await request(app()).put('/api/settings/notify.email').send({ value: ' me@a.com ' })
    expect(put.status).toBe(200)
    // 前后空白被修掉：带着空格的邮箱会被 SMTP 服务端拒绝，而报错信息完全指不到这里
    expect(put.body.data.value).toBe('me@a.com')

    const get = await request(app()).get('/api/settings/notify.email')
    expect(get.body.data.value).toBe('me@a.com')

    await prisma.setting.deleteMany({ where: { key: 'notify.email' } })
  })

  it('从未写过的键返回 value=null 而不是 404', async () => {
    const res = await request(app()).get('/api/settings/discover.domain')
    expect(res.status).toBe(200)
    expect(res.body.data.value).toBeNull()
  })

  it('value 必须是字符串', async () => {
    const res = await request(app()).put('/api/settings/notify.email').send({ value: 42 })
    expect(res.status).toBe(400)
  })
})
