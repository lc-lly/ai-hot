import type { PrismaClient } from '@prisma/client'
import { contentHash, normalizeUrl } from './dedupe.js'
import {
  checkEngagement,
  DEFAULT_ENGAGEMENT_THRESHOLDS,
  readThresholds,
  type EngagementThresholds,
} from './engagement.js'
import { domain as domainOf } from '../score/domain.js'
import { heat as heatOf } from '../score/heat.js'
import { IMPORTANCE_RANK, importanceOf } from '../score/importance.js'
import type { RawItem, SourceAdapter } from '../sources/types.js'

export interface IngestResult {
  /** adapter 返回的原始条数 */
  fetched: number
  inserted: number
  skippedDuplicate: number
  /** URL 非法等原因被丢弃的条数 */
  invalid: number
  /**
   * 被互动阈值挡掉的条数（点赞/转发/浏览不达标）。
   *
   * 与 `invalid` 分开计数是有用的：`invalid` 涨说明源返回的数据坏了，
   * `filtered` 涨说明阈值在正常工作。混成一个数就分不清该修适配器还是调阈值。
   */
  filtered: number
}

interface SourceRef {
  id: string
  kind: string
  config: unknown
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    // 配置写坏了不该让整轮采集挂掉
    return {}
  }
}

export async function ingestSource(
  prisma: PrismaClient,
  adapter: SourceAdapter,
  source: SourceRef,
  deps: { fetch: typeof globalThis.fetch; now: Date },
): Promise<IngestResult> {
  // config 解析一次、两处用：喂给 adapter，以及读互动阈值覆盖。
  // 各解析一次的话，配置里 `engagement` 写坏时的降级行为会和 adapter 看到的
  // 不是同一份对象，排查起来很绕。
  const config = parseConfig(source.config)

  const items = await adapter.fetch({
    sourceId: source.id,
    config,
    fetch: deps.fetch,
    now: deps.now,
  })
  return persistItems(prisma, source.id, items, deps.now, {
    sourceKind: source.kind,
    engagement: readThresholds(config),
  })
}

export interface PersistOptions {
  /**
   * `Source.kind`。给了才能把 `heatScore` / `importance` 算对——
   * 这两个都依赖 kind（`heat` 按 kind 取不同基准，`metrics` 按 kind 取不同字段）。
   *
   * 省略时两者都退化为「取不到值」的档位（`heat = 0.3`、`importance = medium`），
   * 对测试与未知 kind 都是合理行为，不会抛。
   */
  sourceKind?: string | null
  /**
   * 互动阈值。省略则用 `DEFAULT_ENGAGEMENT_THRESHOLDS`（点赞>10 且 转发>5 且 浏览>500）。
   *
   * 语义（只约束确实提供了该指标的源、AND）见 `pipeline/engagement.ts`。
   */
  engagement?: EngagementThresholds
}

export async function persistItems(
  prisma: PrismaClient,
  sourceId: string,
  items: readonly RawItem[],
  now: Date = new Date(),
  opts: PersistOptions = {},
): Promise<IngestResult> {
  let invalid = 0

  // 先做本地校验与计算，把坏数据挡在数据库之外
  const prepared: Array<{ item: RawItem; normalizedUrl: string; hash: string }> = []
  for (const item of items) {
    try {
      prepared.push({ item, normalizedUrl: normalizeUrl(item.url), hash: contentHash(item.title, item.url) })
    } catch {
      invalid += 1
    }
  }

  if (prepared.length === 0) {
    return { fetched: items.length, inserted: 0, skippedDuplicate: 0, invalid, filtered: 0 }
  }

  // 一次查询查出所有已存在的项，避免 N+1
  const existing = await prisma.hotItem.findMany({
    where: {
      OR: [
        { contentHash: { in: prepared.map((p) => p.hash) } },
        { sourceId, externalId: { in: prepared.map((p) => p.item.externalId) } },
      ],
    },
    select: { contentHash: true, externalId: true },
  })
  const seenHashes = new Set(existing.map((e) => e.contentHash))
  const seenExternal = new Set(existing.map((e) => e.externalId))

  // 同批次内部的重复同样要挡掉
  const fresh: Array<{ item: RawItem; normalizedUrl: string; hash: string }> = []
  for (const row of prepared) {
    if (seenHashes.has(row.hash) || seenExternal.has(row.item.externalId)) continue
    seenHashes.add(row.hash)
    seenExternal.add(row.item.externalId)
    fresh.push(row)
  }

  // 互动阈值闸门。放在去重**之后**：去重是纯字符串比较、更便宜，
  // 而且能把「早就进过库的」先剔掉，剩下的才值得算一次指标。
  // 被挡掉的条目不会写库，所以下一轮还会抓到、还会被挡一次——
  // 这是幂等的，不产生额外状态。语义见 `pipeline/engagement.ts`。
  const kind = opts.sourceKind ?? null
  const thresholds = opts.engagement ?? DEFAULT_ENGAGEMENT_THRESHOLDS
  const accepted = fresh.filter(
    (row) => checkEngagement(kind, row.item.raw, thresholds) === null,
  )
  const filtered = fresh.length - accepted.length

  if (accepted.length > 0) {
    await prisma.hotItem.createMany({
      data: accepted.map((row) => {
        // 物化三个派生量。都是纯函数、raw 就在手上，零额外成本。
        // 落列之后，按热度/领域/等级排序与筛选才是普通 SQL——
        // 否则只能「先取 200 条再内存排」，那是先截断后排序，结果必然错。
        const heat = heatOf(kind, row.item.raw)
        const importance = importanceOf({ heat, flags: [] })
        return {
          sourceId,
          externalId: row.item.externalId,
          url: row.normalizedUrl,
          title: row.item.title,
          summary: row.item.summary,
          author: row.item.author,
          lang: row.item.lang,
          publishedAt: row.item.publishedAt,
          fetchedAt: now,
          contentHash: row.hash,
          raw: JSON.stringify(row.item.raw ?? null),
          heatScore: heat,
          domain: domainOf(row.item.title, row.item.summary),
          importance,
          importanceRank: IMPORTANCE_RANK[importance],
        }
      }),
    })
  }

  return {
    fetched: items.length,
    inserted: accepted.length,
    skippedDuplicate: prepared.length - fresh.length,
    invalid,
    filtered,
  }
}
