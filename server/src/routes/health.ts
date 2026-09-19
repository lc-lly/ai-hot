import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'

export function healthRoutes(deps: { startedAt: Date; prisma: PrismaClient }): Router {
  const router = Router()

  router.get('/health', async (_req, res) => {
    let db: 'ok' | 'error' = 'ok'
    let dbError: string | null = null
    try {
      await deps.prisma.$queryRaw`SELECT 1`
    } catch (e) {
      db = 'error'
      dbError = e instanceof Error ? e.message : String(e)
    }

    res.status(db === 'ok' ? 200 : 503).json({
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      dbError,
      now: new Date().toISOString(),
      uptimeMs: Date.now() - deps.startedAt.getTime(),
    })
  })

  return router
}
