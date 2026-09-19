import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import { discoverClusters, DISCOVER_DEFAULT_LIMIT } from '../discover/index.js'
import { HttpError } from '../errors.js'
import { createJobs, getJob, isJobName, JOBS } from '../jobs/index.js'
import type { JobDeps, JobsHandle } from '../jobs/index.js'

/**
 * 阶段 5 的三个端点（契约 §4，冻结）：
 *
 *   GET  /api/jobs              各定时任务：{ name, cron, lastRunAt, lastResult, nextRunAt }
 *   POST /api/jobs/:name/run    手动触发一次
 *   GET  /api/discover          自动发现的热点，`?domain=AI 编程`
 *
 * 挂载方式（契约 §5.1）：
 *   app.use('/api', jobRoutes({ prisma, env, jobs }))
 *
 * `env` 可省（照 `aiRoutes` 的先例）；`jobs` 也可省 ——
 * 省了就在内部建一个 `autostart: false` 的调度器（**不会挂定时器**），
 * 这样控制者即使在 `index.ts` 之前先把 router 挂上也不会起两份 cron。
 * 真跑起来的那个实例由 `startJobs` 创建，控制者顺手传进来即可复用（含 in-flight 状态）。
 */

export interface JobRoutesDeps extends JobDeps {
  prisma: PrismaClient
  /** `startJobs()` 返回的实例；不传则内部建一个只跑不调度的 */
  jobs?: JobsHandle
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

export function jobRoutes(deps: JobRoutesDeps): Router {
  const router = Router()
  const jobs: JobsHandle = deps.jobs ?? createJobs({ ...deps, autostart: false })

  router.get('/jobs', async (_req, res) => {
    const list = await jobs.list()
    res.json({ count: list.length, jobs: list })
  })

  router.post('/jobs/:name/run', async (req, res) => {
    const name = req.params.name as string

    // 两道判断各司其职：`isJobName` 收窄类型（把 string 变成 JobName），
    // 登记表才是「真有这个任务」的事实来源
    if (!isJobName(name) || getJob(name) === undefined) {
      throw new HttpError(
        404,
        'UNKNOWN_JOB',
        `未知任务: ${name}；可用的是: ${JOBS.map((j) => j.name).join(', ')}`,
      )
    }

    const outcome = await jobs.runJob(name)

    // 跳过（上一轮还在跑）不是错误：返回 200 + `skipped: true`，
    // 前端据此提示「上一轮仍在运行」。契约没规定错误码，
    // 把它做成 4xx 会让「点一下没反应」变成「弹一个红色报错」。
    res.json(outcome)
  })

  router.get('/discover', async (req, res) => {
    const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined
    const limit = parseLimit(req.query.limit, DISCOVER_DEFAULT_LIMIT, 100)
    const threshold =
      req.query.threshold === undefined ? undefined : Number(req.query.threshold)

    const result = await discoverClusters(deps.prisma, {
      domain,
      limit,
      ...(threshold === undefined || !Number.isFinite(threshold) ? {} : { threshold }),
    })

    res.json({
      domain: result.domain,
      threshold: result.threshold,
      count: result.clusters.length,
      considered: result.considered,
      matched: result.matched,
      clusters: result.clusters,
    })
  })

  return router
}
