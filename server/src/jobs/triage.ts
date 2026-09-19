import type { JobContext } from './types.js'

/**
 * `triage` —— **每小时**（cron `10 * * * *`，见 `registry.ts`）：对未处理条目跑三层过滤，
 * 产出 `Match`，按策略推送。
 *
 * **这个任务只负责编排，不负责实现。**
 * 三层过滤（L0/L1/L2/L3）与 `Match` 的落库属于 `src/triage/**`，
 * `Match` 到通知的分发属于 `src/notify/**`。这里做三件事：
 *
 * 1. 按频率把入口调起来；
 * 2. 把结果收敛成一份**不含逐条明细**的摘要写进 `JobRun.result`
 *    （50 条明细塞进一列 JSON 会让 `/api/jobs` 变得又大又难读）；
 * 3. `src/triage/**` 尚未就绪时**降级而不是报错**——服务照常起，
 *    条目继续在 `HotItem.aiState = pending` 上等，模块一落地下一轮就接上。
 */

/**
 * 单轮最多处理多少条。
 *
 * 这是**唯一会真的调用 DeepSeek 的定时任务**，所以这个数字就是每小时的
 * 费用天花板，宁可保守。
 *
 * 实测稳态采集速率 10–37 条/小时（`HotItem.fetchedAt` 分桶，2026-09-15），
 * 低于 50，所以队列能持续排空、不会无限堆积；同时最坏情况下一轮最多
 * 50 条 × (1 次 L1 + 1 次 L2)，不会失控。
 *
 * 「5 分钟一轮」改成「1 小时一轮」后**没有**提高这个值：那会让每轮积压
 * 12 倍，正是要避免的开销。代价是历史积压排得慢——想快点清就点前端
 * 的「立即扫描」，它直接调 `POST /api/jobs/triage/run`，不走这个上限的等待。
 */
export const TRIAGE_LIMIT = 50

const SUMMARY_KEYS = [
  'considered',
  'done',
  'skipped',
  'failed',
  'pending',
  'matched',
  'pushed',
  'notified',
  'l1Calls',
  'l2Calls',
] as const

/** 把 `src/triage/**` 的返回值收敛成 `JobRun.result` 用的瘦身摘要。 */
export function summarizeTriage(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') {
    return { result: raw === undefined ? null : String(raw) }
  }

  const bag = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of SUMMARY_KEYS) {
    const value = bag[key]
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  if (typeof bag['degraded'] === 'boolean') out['degraded'] = bag['degraded']
  if (typeof bag['degradeReason'] === 'string') out['degradeReason'] = bag['degradeReason']

  // 逐条明细只留计数，避免 JSON 列膨胀
  const results = bag['results']
  if (Array.isArray(results)) out['details'] = results.length

  return out
}

export async function runTriageJob(ctx: JobContext): Promise<Record<string, unknown>> {
  if (ctx.runTriage === null) {
    ctx.logger({
      level: 'warn',
      channel: 'ai',
      message:
        'triage 模块（src/triage/**）尚未就绪，本轮跳过；条目保持 aiState=pending，模块就绪后自动接上',
    })
    return { skipped: true, reason: 'triage_module_unavailable' }
  }

  const raw = await ctx.runTriage({
    prisma: ctx.prisma,
    now: ctx.now,
    limit: TRIAGE_LIMIT,
  })

  const summary = summarizeTriage(raw)
  ctx.logger({
    level: 'info',
    channel: 'ai',
    message: `triage 完成：处理 ${String(summary['considered'] ?? '?')} 条，done ${String(
      summary['done'] ?? '?',
    )} / pending ${String(summary['pending'] ?? '?')} / failed ${String(summary['failed'] ?? '?')}`,
    meta: summary,
  })

  return summary
}
