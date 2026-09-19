/**
 * 阶段 5 定时任务层的公开面。
 *
 * 控制者只需要两样东西：
 * ```ts
 * import { startJobs } from './jobs/index.js'
 * const jobs = startJobs({ prisma, env })   // 挂上五个 cron
 * // 退出时 jobs.stop()
 * ```
 * 路由工厂在 `../routes/jobs.js`（契约 §5.1 的 `jobRoutes(deps): Router`）。
 */
export { createJobs, startJobs } from './scheduler.js'
export { JOBS, getJob, jobMeta, type JobDefinition } from './registry.js'
export { isValidCron, nextRunAt, parseCron, type CronFields } from './cron.js'
export {
  createInappNotifier,
  loadNotifier,
  loadTriageRunner,
  realtimeJobLogger,
  resolveNotifier,
  silentJobLogger,
} from './seams.js'
export { runCleanupJob, RAW_RETENTION_DAYS } from './cleanup.js'
export { runCollectJob, COLLECT_CONCURRENCY } from './collect.js'
export { runTriageJob, TRIAGE_LIMIT, summarizeTriage } from './triage.js'
export {
  DISCOVER_PUSHED_KEY,
  DISCOVER_PUSH_LIMIT,
  DISCOVER_SCAN_LIMIT,
  formatDiscoverBody,
  loadPushed,
  runDiscoverJob,
  savePushed,
} from './discover.js'
export { DIGEST_TOP_N, DIGEST_WINDOW_HOURS, runDigestJob } from './digest.js'
export {
  isJobName,
  JOB_NAMES,
  type JobContext,
  type JobDeps,
  type JobLogger,
  type JobLogEvent,
  type JobName,
  type JobRunOutcome,
  type JobsHandle,
  type JobStatus,
  type NotifyFn,
  type NotifyInput,
  type NotifyOutcome,
  type RunTriageFn,
  type ScheduledHandle,
  type ScheduleFn,
  type TriageRunOptions,
} from './types.js'
