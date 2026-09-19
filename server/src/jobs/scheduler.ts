import cron from 'node-cron'
import { COLLECT_CONCURRENCY } from './collect.js'
import { nextRunAt } from './cron.js'
import { getJob, JOBS } from './registry.js'
import { loadTriageRunner, realtimeJobLogger, resolveNotifier } from './seams.js'
import {
  isJobName,
  type JobContext,
  type JobDeps,
  type JobLogger,
  type JobName,
  type JobRunOutcome,
  type JobsHandle,
  type JobStatus,
  type NotifyFn,
  type RunTriageFn,
  type ScheduledHandle,
  type ScheduleFn,
} from './types.js'

/**
 * 定时任务的调度器。
 *
 * 契约 §5.1 说「各模块只导出自己的 router 工厂」；调度器不是 router，
 * 所以由控制者在 `index.ts` 里调用 `startJobs(deps)`（与 `attachRealtime` 同一模式）。
 *
 * ## 重叠保护
 *
 * `triage` 每 5 分钟一轮，而一轮可能因为 AI 调用慢而超过 5 分钟。
 * 没有保护的话会**层层叠起来**：内存里 N 个并发的 triage，
 * 每个都在烧 token、每个都在写同一批 `Match` 行。
 *
 * 做法是每个任务名一个 in-flight 标记：**已在跑就直接跳过本次触发并记一条日志，
 * 不排队**。不排队是刻意的——排队等于把「堆积」从进程内挪到队列里，
 * 问题只是换了个地方爆发，而热点雷达晚一轮 5 分钟毫无影响。
 * 手动触发（`POST /api/jobs/:name/run`）走同一把锁。
 *
 * ## 测试怎么不起真定时器
 *
 * 调度器是注入的（`deps.schedule`），且 `autostart: false` 时压根不挂。
 * 测试用 `autostart: false` + 直接调 `runJob(name)`，跑的是**同一份任务逻辑**，
 * 只是不经过 wall clock。没有任何一个测试会 sleep。
 */

/** 单条 `JobRun.result` 落库前的长度上限，防止一次把 JSON 列写成几 MB。 */
const RESULT_JSON_LIMIT = 64 * 1024

function defaultSchedule(expression: string, run: () => void, name: JobName): ScheduledHandle {
  const task = cron.schedule(expression, () => run(), { name, scheduled: true })
  return { stop: () => task.stop() }
}

function safeParseResult(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function serializeResult(result: Record<string, unknown>): string {
  let json = JSON.stringify(result)
  if (json.length <= RESULT_JSON_LIMIT) return json
  json = JSON.stringify({
    truncated: true,
    reason: `result 超过 ${RESULT_JSON_LIMIT} 字节`,
    keys: Object.keys(result),
  })
  return json
}

export function createJobs(deps: JobDeps): JobsHandle {
  const clock = deps.now ?? ((): Date => new Date())
  const logger: JobLogger = deps.logger ?? realtimeJobLogger
  const schedule: ScheduleFn = deps.schedule ?? defaultSchedule
  const concurrency = deps.concurrency ?? COLLECT_CONCURRENCY

  /** 在跑的任务名 —— 重叠保护就靠它 */
  const inflight = new Set<JobName>()
  let handles: ScheduledHandle[] = []

  // 异步资源只在第一次真正要跑任务时解析：`startJobs` 本身必须能同步返回
  let notifierCache: { notify: NotifyFn; source: 'injected' | 'module' | 'inapp' } | null = null
  let triageCache: RunTriageFn | null | undefined

  async function buildContext(at: Date): Promise<JobContext> {
    if (notifierCache === null) {
      notifierCache = await resolveNotifier(deps.prisma, deps.notify)
    }
    if (triageCache === undefined) {
      triageCache = deps.runTriage ?? (await loadTriageRunner())
      if (triageCache === null) {
        logger({
          level: 'warn',
          channel: 'system',
          message: 'src/triage/** 未就绪：triage 任务将在每一轮降级为「跳过」',
        })
      }
    }

    return {
      prisma: deps.prisma,
      env: deps.env,
      logger,
      now: at,
      fetch: deps.fetch ?? globalThis.fetch,
      runTriage: triageCache,
      notify: notifierCache.notify,
      notifierSource: notifierCache.source,
      concurrency,
      skipCluster: deps.skipCluster ?? false,
    }
  }

  async function runJob(name: JobName, options: { now?: Date } = {}): Promise<JobRunOutcome> {
    const definition = getJob(name)
    if (definition === undefined) throw new Error(`unknown job: ${name}`)

    const startedAt = options.now ?? clock()

    if (inflight.has(name)) {
      const reason = '上一轮尚未结束（避免堆叠），本次触发已跳过'
      logger({
        level: 'warn',
        channel: 'system',
        message: `${name}: ${reason}`,
      })
      return {
        name,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        durationMs: 0,
        ok: true,
        skipped: true,
        skipReason: reason,
        result: null,
        error: null,
        runId: null,
      }
    }

    inflight.add(name)
    let runId: string | null = null

    try {
      // 先落一行「开始」：任务中途把进程搞崩时，这一行是唯一的线索
      const row = await deps.prisma.jobRun.create({
        data: { name, startedAt, ok: true, result: '{}', durationMs: 0 },
      })
      runId = row.id

      const ctx = await buildContext(startedAt)
      const result = await definition.run(ctx)

      const finishedAt = clock()
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())

      await deps.prisma.jobRun.update({
        where: { id: runId },
        data: {
          finishedAt,
          durationMs,
          ok: true,
          result: serializeResult(result),
        },
      })

      return {
        name,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        ok: true,
        skipped: false,
        skipReason: null,
        result,
        error: null,
        runId,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const finishedAt = clock()
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())

      if (runId !== null) {
        try {
          await deps.prisma.jobRun.update({
            where: { id: runId },
            data: { finishedAt, durationMs, ok: false, error: message },
          })
        } catch {
          /* 记不上就算了，别把原始错误盖掉 */
        }
      }

      logger({
        level: 'error',
        channel: 'system',
        message: `${name} 运行失败：${message}`,
        meta: { durationMs },
      })

      return {
        name,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        ok: false,
        skipped: false,
        skipReason: null,
        result: null,
        error: message,
        runId,
      }
    } finally {
      inflight.delete(name)
    }
  }

  async function list(): Promise<JobStatus[]> {
    const at = clock()
    const out: JobStatus[] = []

    for (const definition of JOBS) {
      // 只看**已完成**的那一行：正在跑的那行 finishedAt 为 null，
      // 把它当 lastRun 会让界面显示一个还没有结果的「上次运行」
      const last = await deps.prisma.jobRun.findFirst({
        where: { name: definition.name, finishedAt: { not: null } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      })

      out.push({
        name: definition.name,
        cron: definition.cron,
        description: definition.description,
        lastRunAt: last?.finishedAt?.toISOString() ?? null,
        lastResult: last ? safeParseResult(last.result) : null,
        lastOk: last ? last.ok : null,
        lastError: last?.error ?? null,
        nextRunAt: nextRunAt(definition.cron, at).toISOString(),
        running: inflight.has(definition.name),
      })
    }

    return out
  }

  function start(): void {
    if (handles.length > 0) return
    for (const definition of JOBS) {
      handles.push(
        schedule(
          definition.cron,
          () => {
            // 定时触发不 await：node-cron 不关心返回值，
            // 而 runJob 自己吞掉所有异常，不会产生 unhandled rejection
            void runJob(definition.name).catch((e: unknown) => {
              logger({
                level: 'error',
                channel: 'system',
                message: `${definition.name} 定时触发异常：${e instanceof Error ? e.message : String(e)}`,
              })
            })
          },
          definition.name,
        ),
      )
    }
    logger({
      level: 'info',
      channel: 'system',
      message: `定时任务已启动：${JOBS.map((d) => `${d.name}(${d.cron})`).join('，')}`,
    })
  }

  function stop(): void {
    for (const handle of handles) {
      try {
        handle.stop()
      } catch {
        /* 已经停了 */
      }
    }
    handles = []
  }

  return {
    runJob,
    isRunning: (name: JobName) => inflight.has(name),
    runningJobs: () => [...inflight],
    list,
    start,
    stop,
  }
}

/**
 * 控制者在 `index.ts` 里调用的入口。
 *
 * ```ts
 * const jobs = startJobs({ prisma, env })
 * app.use('/api', jobRoutes({ prisma, env, jobs }))
 * // 退出时： jobs.stop()
 * ```
 *
 * `autostart` 默认 `true`；测试传 `false`（或干脆不调 `start()`），
 * 这样不会挂真的定时器。
 */
export function startJobs(deps: JobDeps): JobsHandle {
  const handle = createJobs(deps)
  if (deps.autostart ?? true) handle.start()
  return handle
}

export { isJobName }
