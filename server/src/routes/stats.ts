import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import { computeStats } from '../stats.js'

/**
 * `GET /api/stats` —— 四张统计卡。
 *
 * 与 WS 的 `stats` 消息**共用 `computeStats`**，所以两条路径不可能给出不同的数。
 * 存在的理由是兜底：WS 断线时统计卡不能永久冻在旧数字上。
 */
export function statsRoutes(deps: { prisma: PrismaClient }): Router {
  const router = Router()

  router.get('/stats', async (_req, res) => {
    res.json(await computeStats(deps.prisma))
  })

  return router
}
