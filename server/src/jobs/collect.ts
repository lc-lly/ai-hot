import { runCluster, type RunClusterResult } from '../cluster/run.js'
import { ingestSource } from '../pipeline/ingest.js'
import { broadcast } from '../realtime/index.js'
import { getAdapter } from '../sources/registry.js'
import { mapLimit } from '../util/concurrency.js'
import type { JobContext } from './types.js'

/**
 * `collect` —— 每 15 分钟（spec §8）：跑所有启用的 Source，ingest → 去重 → 聚类。
 *
 * 「独立失败」是硬要求（spec §3.1）：单个源炸掉只影响它自己，
 * 其它源照常采集，整轮照常聚类。所以每个源都套在自己的 try 里，
 * `mapLimit` 不可能因为某个源而 reject。
 */

/** 单轮的抓取并发度：源站多为免费接口，并发太高容易被限速。 */
export const COLLECT_CONCURRENCY = 4

interface SourceOutcome {
  id: string
  name: string
  kind: string
  ok: boolean
  fetched: number
  inserted: number
  skippedDuplicate: number
  invalid: number
  /** 被互动阈值挡掉的条数，见 `pipeline/engagement.ts` */
  filtered: number
  error: string | null
}

export async function runCollectJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const sources = await ctx.prisma.source.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
  })

  const outcomes = await mapLimit(sources, Math.max(1, ctx.concurrency), async (source) => {
    try {
      const adapter = getAdapter(source.kind)
      const result = await ingestSource(ctx.prisma, adapter, source, {
        fetch: ctx.fetch,
        now: ctx.now,
      })

      await ctx.prisma.source.update({
        where: { id: source.id },
        data: { lastRunAt: ctx.now, lastOk: true, lastError: null },
      })

      ctx.logger({
        level: 'info',
        channel: 'fetch',
        // `filtered` 只在非零时出现。绝大多数源拿不到互动数、恒为 0，
        // 每条日志尾部都挂一个「过滤 0 条」只会稀释真正有信息量的那几个数
        message:
          `${source.name}（${source.kind}）: 抓到 ${result.fetched} 条，新增 ${result.inserted}，` +
          `重复 ${result.skippedDuplicate}` +
          (result.filtered > 0 ? `，互动不达标 ${result.filtered}` : ''),
        meta: { sourceId: source.id, ...result },
      })
      broadcast('source', {
        id: source.id,
        name: source.name,
        kind: source.kind,
        lastOk: true,
        lastRunAt: ctx.now.toISOString(),
        lastError: null,
      })

      return {
        id: source.id,
        name: source.name,
        kind: source.kind,
        ok: true,
        ...result,
        error: null,
      } satisfies SourceOutcome
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)

      // 健康状态写失败也不能让整轮挂在这里
      try {
        await ctx.prisma.source.update({
          where: { id: source.id },
          data: { lastRunAt: ctx.now, lastOk: false, lastError: message },
        })
      } catch {
        /* 忽略：这个源本来就在失败路径上 */
      }

      ctx.logger({
        level: 'error',
        channel: 'fetch',
        message: `${source.name}（${source.kind}）采集失败：${message}`,
        meta: { sourceId: source.id },
      })
      broadcast('source', {
        id: source.id,
        name: source.name,
        kind: source.kind,
        lastOk: false,
        lastRunAt: ctx.now.toISOString(),
        lastError: message,
      })

      return {
        id: source.id,
        name: source.name,
        kind: source.kind,
        ok: false,
        fetched: 0,
        inserted: 0,
        skippedDuplicate: 0,
        invalid: 0,
        filtered: 0,
        error: message,
      } satisfies SourceOutcome
    }
  })

  let cluster: RunClusterResult | null = null
  let clusterError: string | null = null

  if (!ctx.skipCluster) {
    try {
      cluster = await runCluster(ctx.prisma, { now: ctx.now })
    } catch (e) {
      // 聚类失败不该让「已经入库的条目」白抓一场：记下来，下一轮再聚
      clusterError = e instanceof Error ? e.message : String(e)
      ctx.logger({
        level: 'error',
        channel: 'system',
        message: `聚类失败（条目已入库，下一轮会重试）：${clusterError}`,
      })
    }
  }

  if (cluster) {
    ctx.logger({
      level: 'info',
      channel: 'system',
      message: `聚类完成：新簇 ${cluster.createdClusters}，并入已有簇 ${cluster.updatedClusters}，覆盖条目 ${cluster.assigned}`,
      meta: {
        considered: cluster.considered,
        created: cluster.createdClusters,
        updated: cluster.updatedClusters,
        assigned: cluster.assigned,
        errors: cluster.errors.length,
      },
    })
  }

  const totals = outcomes.reduce(
    (acc, o) => ({
      fetched: acc.fetched + o.fetched,
      inserted: acc.inserted + o.inserted,
      skippedDuplicate: acc.skippedDuplicate + o.skippedDuplicate,
      invalid: acc.invalid + o.invalid,
      failed: acc.failed + (o.ok ? 0 : 1),
    }),
    { fetched: 0, inserted: 0, skippedDuplicate: 0, invalid: 0, failed: 0 },
  )

  return {
    sources: sources.length,
    ...totals,
    cluster: cluster
      ? {
          considered: cluster.considered,
          created: cluster.createdClusters,
          updated: cluster.updatedClusters,
          assigned: cluster.assigned,
          errors: cluster.errors,
        }
      : null,
    clusterError,
    // 单源明细进 JobRun.result，`/api/jobs` 上能看到「哪个源挂了」
    failures: outcomes.filter((o) => !o.ok).map((o) => ({ name: o.name, error: o.error })),
  }
}
