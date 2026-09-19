import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import type { Env } from '../env.js'
import { HttpError } from '../errors.js'
import { channelStatus } from '../notify/index.js'
import type { NotificationDTO } from '../realtime/index.js'

/**
 * 站内消息中心（契约 §3.2 的 `NotificationDTO` 是冻结形状）。
 *
 * ```
 * GET  /api/notifications              列表（默认最近 50 条）
 * GET  /api/notifications/channels     三个渠道此刻的可用性
 * POST /api/notifications/read-all     全部已读
 * POST /api/notifications/:id/read     单条已读
 * ```
 *
 * ## 为什么列表不做分页
 *
 * 通知是**有时效的一次性消息**，不是可以往回翻的档案。默认给最近 50 条，
 * 更早的用 `?limit=` 显式要。做一套 `{data, pagination}` 信封只为了让
 * 前端多一个「第 2 页」按钮——而没人会去看三个月前的推送。
 * （`/api/items` 是另一回事：热点流是要往回翻的。）
 *
 * 响应仍是 `{ data: [...] }` 而不是裸数组，与 `/api/topics` 一致，
 * 也确实是前端 `fetchNotifications` 能吃下的两种形状之一。
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function parseLimit(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(value))
}

interface NotificationRow {
  id: string
  level: string
  title: string
  body: string
  channels: string
  itemId: string | null
  topicId: string | null
  read: boolean
  sentAt: Date
}

function parseChannels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function toDTO(row: NotificationRow): NotificationDTO {
  return {
    id: row.id,
    createdAt: row.sentAt.toISOString(),
    title: row.title,
    body: row.body,
    // 契约 §3.2 只有两档。库里的 level 是自由字符串（schema 的默认值是
    // 字符串 'pending' 而不是枚举），脏值一律降级到 pending——
    // 降级到 push 会让前端把它渲染成「重要」。
    level: row.level === 'push' ? 'push' : 'pending',
    read: row.read,
    itemId: row.itemId,
    topicId: row.topicId,
    channels: parseChannels(row.channels),
  }
}

export function notificationRoutes(deps: { prisma: PrismaClient; env: Env }): Router {
  const router = Router()
  const { prisma, env } = deps

  router.get('/notifications', async (req, res) => {
    const limit = parseLimit(req.query.limit)
    const onlyUnread = req.query.unread === '1' || req.query.unread === 'true'

    const rows = await prisma.notification.findMany({
      where: onlyUnread ? { read: false } : undefined,
      orderBy: { sentAt: 'desc' },
      take: limit,
    })

    res.json({ data: rows.map(toDTO) })
  })

  /**
   * 三个渠道的可用性。
   *
   * 存在的理由：用户配了 `SMTP_URL` 却没收到邮件时，他需要知道
   * **是配置没生效、还是根本没有通知被触发**。前者在这个端点上能看出来。
   */
  router.get('/notifications/channels', async (_req, res) => {
    res.json({ data: await channelStatus({ prisma, env }) })
  })

  router.post('/notifications/read-all', async (_req, res) => {
    // 只更新未读的：`read: true` 的行不动，省掉一次无意义的写入。
    // `updatedAt` 之类的列不存在于 Notification，所以这里没有副作用。
    const { count } = await prisma.notification.updateMany({
      where: { read: false },
      data: { read: true },
    })
    res.json({ data: { updated: count } })
  })

  router.post('/notifications/:id/read', async (req, res) => {
    const id = req.params.id
    const existing = await prisma.notification.findUnique({ where: { id } })
    if (!existing) throw new HttpError(404, 'NOT_FOUND', '通知不存在')

    // 已经读过就直接返回，不重复写。前端「全部已读」后逐条点开时
    // 会走到这里，写一次无变化的 UPDATE 是纯粹的浪费。
    if (existing.read) {
      res.json({ data: toDTO(existing) })
      return
    }

    const row = await prisma.notification.update({ where: { id }, data: { read: true } })
    res.json({ data: toDTO(row) })
  })

  return router
}
