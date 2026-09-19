import express, { type Express } from 'express'
import type { PrismaClient } from '@prisma/client'
import type { Env } from './env.js'
import { errorHandler, notFoundHandler } from './errors.js'
import type { JobsHandle } from './jobs/index.js'
import { aiRoutes } from './routes/ai.js'
import { healthRoutes } from './routes/health.js'
import { itemRoutes } from './routes/items.js'
import { jobRoutes } from './routes/jobs.js'
import { logRoutes } from './routes/logs.js'
import { notificationRoutes } from './routes/notifications.js'
import { searchRoutes } from './routes/search.js'
import { settingRoutes } from './routes/settings.js'
import { sourceRoutes } from './routes/sources.js'
import { statsRoutes } from './routes/stats.js'
import { topicRoutes } from './routes/topics.js'

export interface AppDeps {
  env: Env
  prisma: PrismaClient
  startedAt?: Date
  /**
   * `startJobs()` 返回的实例。**必须由 `index.ts` 传进来**，否则
   * `jobRoutes` 会在内部自建一个只跑不调度的调度器——`/api/jobs/:name/run`
   * 的手动触发就跑在一个与 cron 无关的实例上，`running` 状态也不会共享。
   */
  jobs?: JobsHandle
}

export function createApp(deps: AppDeps): Express {
  const startedAt = deps.startedAt ?? new Date()
  const app = express()

  app.use(express.json({ limit: '1mb' }))
  app.use('/api', healthRoutes({ startedAt, prisma: deps.prisma }))
  app.use('/api', sourceRoutes({ prisma: deps.prisma }))
  app.use('/api', itemRoutes({ prisma: deps.prisma }))
  app.use('/api', statsRoutes({ prisma: deps.prisma }))
  app.use('/api', topicRoutes({ prisma: deps.prisma }))
  app.use('/api', logRoutes())
  app.use('/api', notificationRoutes({ prisma: deps.prisma, env: deps.env }))
  app.use('/api', settingRoutes({ prisma: deps.prisma }))
  app.use('/api', searchRoutes({ prisma: deps.prisma }))
  app.use('/api', aiRoutes({ prisma: deps.prisma, env: deps.env }))
  app.use('/api', jobRoutes({ prisma: deps.prisma, env: deps.env, jobs: deps.jobs }))

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
