import { runCleanupJob } from './cleanup.js'
import { runCollectJob } from './collect.js'
import { runDigestJob } from './digest.js'
import { runDiscoverJob } from './discover.js'
import { parseCron } from './cron.js'
import { runTriageJob } from './triage.js'
import { JOB_NAMES, type JobContext, type JobName } from './types.js'
import type { JobStatus } from './types.js'

/**
 * 五个定时任务的登记表 —— spec §8 的一比一落地。
 *
 * 频率是**契约**（spec §8 的表格），不是随手挑的：
 * `collect` 15 分钟一轮、`triage` 5 分钟一轮（采集频率的 3 倍，
 * 保证新条目在下一次采集之前就被过滤完）、`discover` 6 小时、
 * `digest` 每天 9:00（博主上班时间，日报要在人坐下之前到）。
 *
 * `cleanup` spec 只写了「每天」。放 4:00 —— 一天里流量最低的时刻，
 * 且在所有 `discover`（每 6 小时：0/6/12/18 点）之前，
 * 不会和别的任务抢 SQLite 的写锁。
 */

export interface JobDefinition {
  name: JobName
  /** 五段式 cron（本地时区） */
  cron: string
  description: string
  run(ctx: JobContext): Promise<Record<string, unknown>>
}

export const JOBS: readonly JobDefinition[] = [
  {
    name: 'collect',
    cron: '*/15 * * * *',
    description: '运行所有启用的 Source：ingest → 去重 → 聚类',
    run: runCollectJob,
  },
  {
    name: 'triage',
    /*
     * 每小时一次（用户要求：这是**唯一烧钱**的任务，5 分钟一轮太贵）。
     *
     * 取 :10 而不是整点，是为了错开 `collect`（:00/:15/:30/:45）：
     * 整点启动会和采集撞在同一个 SQLite 写锁上，而且那时 collect 刚抓的
     * 批次可能还没落库，triage 会白跑一轮「没有新条目」。
     * :10 启动时上一轮 collect 已经落库，正好接着评。
     *
     * ⚠️ 这个循环一旦 `src/triage/**` 落地就会**真的调用 DeepSeek**。
     */
    cron: '10 * * * *',
    description: '对未处理条目跑三层过滤，产出 Match，按策略推送',
    run: runTriageJob,
  },
  {
    name: 'discover',
    cron: '0 */6 * * *',
    description: '对配置领域内的簇做新颖度 / 热度 / 增速打分，超阈值进发现页并推送',
    run: runDiscoverJob,
  },
  {
    name: 'digest',
    cron: '0 9 * * *',
    description: '生成领域 Top 10 摘要，邮件 + 站内',
    run: runDigestJob,
  },
  {
    name: 'cleanup',
    cron: '0 4 * * *',
    description: '清理 30 天前的原文（清 raw 字段，不删条目）',
    run: runCleanupJob,
  },
]

// 启动即校验 cron 表达式：写错了要在进程起来的那一刻就炸，
// 而不是等到第一轮调度（甚至 `GET /api/jobs` 算 nextRunAt）才发现。
for (const def of JOBS) parseCron(def.cron)

/** 登记表自检：名字集合必须与 `JOB_NAMES` 完全一致。 */
if (JOBS.length !== JOB_NAMES.length || JOBS.some((d, i) => d.name !== JOB_NAMES[i])) {
  throw new Error(
    `jobs 登记表与 JOB_NAMES 不一致: ${JOBS.map((d) => d.name).join(',')} vs ${JOB_NAMES.join(',')}`,
  )
}

export function getJob(name: string): JobDefinition | undefined {
  return JOBS.find((d) => d.name === name)
}

/** 供 `GET /api/jobs` 用的静态部分。 */
export function jobMeta(): Array<Pick<JobStatus, 'name' | 'cron' | 'description'>> {
  return JOBS.map((d) => ({ name: d.name, cron: d.cron, description: d.description }))
}
