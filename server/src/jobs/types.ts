import type { PrismaClient } from '@prisma/client'
import type { Env } from '../env.js'
import type { LogChannel, LogLevel } from '../realtime/index.js'

/**
 * 定时任务层的共享类型。
 *
 * 设计要点：**所有跨模块的东西都是注入的**。
 * 阶段 5 要调用阶段 4/并行 agent 的 `src/triage/**` 与 `src/notify/**`，
 * 但那两个模块在本模块开发时还不存在。把「跑三层过滤」和「发通知」
 * 变成 `deps` 上的两个函数之后：
 *
 * - 本模块的测试可以注入假的，不需要真 AI、真 SMTP、真定时器；
 * - 并行 agent 落地后，由控制者在 `index.ts` 里接线，本模块一行不用改。
 *
 * 缺省实现见 `./seams.ts`：会尝试动态 import `../triage/index.js` /
 * `../notify/index.js`，拿不到就降级（记日志 + 空结果），
 * 绝不让整个服务因为某个可选模块没到位而起不来（spec §12）。
 */

/** spec §8 的五个任务，名字即对外契约（`/api/jobs/:name/run` 的 `:name`）。 */
export type JobName = 'collect' | 'triage' | 'discover' | 'digest' | 'cleanup'

export const JOB_NAMES: readonly JobName[] = ['collect', 'triage', 'discover', 'digest', 'cleanup']

export function isJobName(value: unknown): value is JobName {
  return typeof value === 'string' && (JOB_NAMES as readonly string[]).includes(value)
}

/** 任务日志。形状对齐契约 §2.1 的 WS `log` 消息（`id` / `ts` 由实时层补）。 */
export interface JobLogEvent {
  level: LogLevel
  channel: LogChannel
  message: string
  meta?: Record<string, unknown>
}

export type JobLogger = (event: JobLogEvent) => void

/** 三层过滤的入口，由 `src/triage/**` 提供。 */
export interface TriageRunOptions {
  prisma: PrismaClient
  now: Date
  /** 单轮最多处理多少条 */
  limit?: number
  retryFailed?: boolean
}

export type RunTriageFn = (options: TriageRunOptions) => Promise<unknown>

/** 通知投递入口，由 `src/notify/**` 提供。 */
export interface NotifyInput {
  /** 契约 §3.2：push | pending */
  level: 'push' | 'pending'
  title: string
  body: string
  /** 期望渠道；实现方按配置（SMTP / VAPID 是否配置）过滤掉不可用的 */
  channels?: string[]
  itemId?: string | null
  topicId?: string | null
  /** 其它进 `Notification.payload` 的内容 */
  payload?: Record<string, unknown>
}

export interface NotifyOutcome {
  /** 实际投递成功的渠道 */
  channels: string[]
  notificationId?: string
}

export type NotifyFn = (input: NotifyInput) => Promise<NotifyOutcome>

/** `node-cron` 的任务句柄（只用到 stop）。 */
export interface ScheduledHandle {
  stop(): void
}

/** 调度器注入点：测试传一个只登记的假实现，就不会起真的定时器。 */
export type ScheduleFn = (expression: string, run: () => void, name: JobName) => ScheduledHandle

export interface JobDeps {
  prisma: PrismaClient
  /** `env` 目前只用于日志与未来扩展，可省（`index.ts` 会顺手传进来） */
  env?: Env
  logger?: JobLogger
  /** 注入时钟，测试用；默认 `() => new Date()` */
  now?: () => Date
  /** 注入 fetch（ingest 用），默认 `globalThis.fetch` */
  fetch?: typeof globalThis.fetch
  /** 三层过滤入口；缺省走 `./seams.js` 的动态加载 */
  runTriage?: RunTriageFn
  /** 通知入口；缺省走 `./seams.js` 的站内实现 */
  notify?: NotifyFn
  /** 调度器；缺省用 `node-cron` */
  schedule?: ScheduleFn
  /** 是否自动挂定时器，默认 `true`。测试传 `false`，用 `runJob` 直接跑逻辑 */
  autostart?: boolean
  /** collect 抓取的并发度，默认 4 */
  concurrency?: number
  /** 关掉 collect 里的聚类步骤（测试 / 排障用） */
  skipCluster?: boolean
}

/** 一次任务运行时的完整环境：`JobDeps` 里所有可选的东西在这里都已落定。 */
export interface JobContext {
  prisma: PrismaClient
  env?: Env
  logger: JobLogger
  /** 本轮任务的时间基准（同一轮内所有步骤共用同一个时刻，便于复现） */
  now: Date
  fetch: typeof globalThis.fetch
  /** 三层过滤入口；`null` = `src/triage/**` 未就绪，本轮降级 */
  runTriage: RunTriageFn | null
  notify: NotifyFn
  /** 通知实现来自哪里，写进日志便于排障 */
  notifierSource: 'injected' | 'module' | 'inapp'
  concurrency: number
  /** 跳过 collect 里的聚类步骤 */
  skipCluster: boolean
}

/** 一次任务运行的对外结果。 */
export interface JobRunOutcome {
  name: JobName
  /** ISO */
  startedAt: string
  /** ISO */
  finishedAt: string
  durationMs: number
  ok: boolean
  /** 因上一轮尚未结束而跳过（没有写 `JobRun` 行） */
  skipped: boolean
  /** 跳过原因 */
  skipReason: string | null
  result: Record<string, unknown> | null
  error: string | null
  /** `JobRun` 行 id；跳过时为 null */
  runId: string | null
}

/** `GET /api/jobs` 的元素（契约 §4 的五个字段 + 几个只读补充）。 */
export interface JobStatus {
  name: JobName
  cron: string
  description: string
  /** ISO；从未跑过时为 null */
  lastRunAt: string | null
  lastResult: Record<string, unknown> | null
  lastOk: boolean | null
  lastError: string | null
  /** ISO */
  nextRunAt: string
  /** 此刻是否在跑 */
  running: boolean
}

export interface JobsHandle {
  /** 手动 / 定时执行一次。上一次未结束时返回 `skipped: true`，不排队 */
  runJob(name: JobName, options?: { now?: Date }): Promise<JobRunOutcome>
  isRunning(name: JobName): boolean
  /** 正在跑的任务名 */
  runningJobs(): JobName[]
  /** `GET /api/jobs` 的数据 */
  list(): Promise<JobStatus[]>
  /** 挂上 cron（`autostart: false` 时不会被调用） */
  start(): void
  /** 摘掉所有 cron 定时器 */
  stop(): void
}
