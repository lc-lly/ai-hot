import type { PrismaClient } from '@prisma/client'
import { heat } from '../score/index.js'
import { clusterItems, type ClusterItem, type ExistingCluster } from './index.js'

/**
 * 聚类的落库层 —— 唯一碰数据库的地方，算法本身在 `./index.ts` 里保持纯函数。
 *
 * 每次只处理 `clusterId` 为空的条目，并把最近活跃的历史簇当作锚点载入，
 * 于是「同一事件的新报道」会**并进已有的簇**，而不是每轮造一个新簇。
 */

export interface RunClusterOptions {
  now?: Date
  /** 只处理这批条目；缺省处理全部未聚类条目 */
  itemIds?: readonly string[]
  /** 单轮最多处理多少条未聚类条目，默认 500 */
  limit?: number
  /** 历史簇的回看窗口（小时），默认 72 */
  lookbackHours?: number
  /** 单轮最多载入多少个历史簇作锚点，默认 300 */
  existingLimit?: number
  titleThreshold?: number
  sameDomainThreshold?: number
}

export interface ClusterChange {
  clusterId: string
  title: string
  itemCount: number
  sourceCount: number
  heatScore: number
  /** 本次新并入的条目数 */
  added: number
  created: boolean
}

export interface RunClusterResult {
  /** 载入的未聚类条目数 */
  considered: number
  /** 实际被写进某个簇的条目数 */
  assigned: number
  createdClusters: number
  updatedClusters: number
  changes: ClusterChange[]
  /** 单组失败不中断整轮，错误收在这里 */
  errors: string[]
}

const DEFAULT_LIMIT = 500
const DEFAULT_LOOKBACK_HOURS = 72
const DEFAULT_EXISTING_LIMIT = 300
/** 历史簇载入时每组最多带多少条条目作锚点（== 单簇上限） */
const EXISTING_ITEMS_PER_CLUSTER = 50

interface RowLike {
  id: string
  title: string
  url: string
  sourceId: string
  publishedAt: Date | null
  fetchedAt: Date | null
  raw: string | null
  source: { kind: string } | null
}

function toClusterItem(row: RowLike): ClusterItem {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    sourceId: row.sourceId,
    publishedAt: row.publishedAt,
    fetchedAt: row.fetchedAt,
    heat: heat(row.source?.kind ?? null, row.raw),
  }
}

export async function runCluster(
  prisma: PrismaClient,
  options: RunClusterOptions = {},
): Promise<RunClusterResult> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? DEFAULT_LIMIT
  const lookbackHours = options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS
  const existingLimit = options.existingLimit ?? DEFAULT_EXISTING_LIMIT

  const result: RunClusterResult = {
    considered: 0,
    assigned: 0,
    createdClusters: 0,
    updatedClusters: 0,
    changes: [],
    errors: [],
  }

  const rows = await prisma.hotItem.findMany({
    where: {
      clusterId: null,
      ...(options.itemIds ? { id: { in: [...options.itemIds] } } : {}),
    },
    orderBy: [{ fetchedAt: 'asc' }, { id: 'asc' }],
    take: limit,
    include: { source: { select: { kind: true } } },
  })

  result.considered = rows.length
  if (rows.length === 0) return result

  const since = new Date(now.getTime() - lookbackHours * 3_600_000)
  const seeds = await prisma.cluster.findMany({
    where: { lastSeenAt: { gte: since } },
    orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
    take: existingLimit,
    include: {
      items: {
        orderBy: [{ fetchedAt: 'asc' }, { id: 'asc' }],
        take: EXISTING_ITEMS_PER_CLUSTER,
        include: { source: { select: { kind: true } } },
      },
    },
  })

  const existing: ExistingCluster[] = seeds.map((cluster) => ({
    clusterId: cluster.id,
    firstSeenAt: cluster.firstSeenAt,
    items: cluster.items.map((item) => toClusterItem(item as RowLike)),
  }))

  const groups = clusterItems(rows.map((row) => toClusterItem(row as RowLike)), {
    existing,
    ...(options.titleThreshold === undefined ? {} : { titleThreshold: options.titleThreshold }),
    ...(options.sameDomainThreshold === undefined
      ? {}
      : { sameDomainThreshold: options.sameDomainThreshold }),
  })

  for (const group of groups) {
    if (group.newItemIds.length === 0) continue

    try {
      const change = await prisma.$transaction(async (tx) => {
        let clusterId = group.clusterId
        const created = clusterId === null

        if (clusterId === null) {
          const row = await tx.cluster.create({
            data: {
              title: group.title,
              firstSeenAt: group.firstSeenAt,
              lastSeenAt: group.lastSeenAt,
              itemCount: group.itemIds.length,
              sourceCount: group.sourceIds.length,
              heatScore: group.heatScore,
            },
          })
          clusterId = row.id
        } else {
          await tx.cluster.update({
            where: { id: clusterId },
            data: {
              title: group.title,
              firstSeenAt: group.firstSeenAt,
              lastSeenAt: group.lastSeenAt,
              itemCount: group.itemIds.length,
              sourceCount: group.sourceIds.length,
              heatScore: group.heatScore,
            },
          })
        }

        await tx.hotItem.updateMany({
          where: { id: { in: group.newItemIds } },
          data: { clusterId },
        })

        return {
          clusterId,
          title: group.title,
          itemCount: group.itemIds.length,
          sourceCount: group.sourceIds.length,
          heatScore: group.heatScore,
          added: group.newItemIds.length,
          created,
        } satisfies ClusterChange
      })

      result.assigned += change.added
      if (change.created) result.createdClusters += 1
      else result.updatedClusters += 1
      result.changes.push(change)
    } catch (e) {
      // 单组失败不中断整轮：下一轮这些条目仍是 clusterId=null，会被重新捡起来
      result.errors.push(
        `簇 ${group.clusterId ?? '(新)'} 落库失败: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  return result
}
