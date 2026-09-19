import type { PrismaClient } from '@prisma/client'
import { DEFAULT_TOPIC, DOMAIN_SETTING_KEY } from '../ai/index.js'
import { heat } from '../score/index.js'
import { domainKeywords, domainText, matchesDomain } from './profile.js'
import {
  DISCOVER_THRESHOLD,
  GROWTH_WINDOW_HOURS,
  scoreCluster,
  type DiscoverScore,
} from './score.js'

/**
 * 自动热点发现 —— spec §8 的 `discover`，也是需求方两条头等需求之一
 * （「每隔一段时间自动搜集指定范围（如"AI 编程"）内的热点，并让用户看到」）。
 *
 * 本模块只做**读 + 打分**，不写库、不推送：
 * `GET /api/discover` 直接调它，`jobs/discover` 调它之后再走通知。
 * 这样「发现页看到什么」和「推送了什么」用的是同一套口径，不会漂移。
 */

/** 发现页默认返回条数 */
export const DISCOVER_DEFAULT_LIMIT = 20
/** 只考虑这个窗口内还活跃的簇，默认 7 天 */
export const DISCOVER_LOOKBACK_HOURS = 24 * 7
/** 单轮最多载入多少个候选簇 */
export const DISCOVER_CLUSTER_LIMIT = 300

export interface DiscoverSample {
  id: string
  title: string
  url: string
  sourceName: string | null
}

export interface DiscoveredCluster extends DiscoverScore {
  clusterId: string
  title: string
  itemCount: number
  sourceCount: number
  /** ISO */
  firstSeenAt: string
  /** ISO */
  lastSeenAt: string
  /** `Cluster.heatScore`（落库值，供展示对比） */
  heatScore: number
  domain: string
  /** 最多 3 条代表性条目，供发现页点开 */
  samples: DiscoverSample[]
}

export interface DiscoverResult {
  domain: string
  threshold: number
  /** 候选簇总数（领域过滤前） */
  considered: number
  /** 过阈值的簇数（未截断前） */
  matched: number
  clusters: DiscoveredCluster[]
}

export interface DiscoverOptions {
  /** 领域名，缺省从 `Setting` 读，再缺省为「AI 编程」 */
  domain?: string | null
  now?: Date
  threshold?: number
  limit?: number
  lookbackHours?: number
  clusterLimit?: number
}

/** `Setting` 里的领域键；未设置时回落到 spec §8 的默认值「AI 编程」。 */
export async function readDiscoverDomain(prisma: PrismaClient): Promise<string> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: DOMAIN_SETTING_KEY } })
    const value = row?.value?.trim()
    return value !== undefined && value !== '' ? value : DEFAULT_TOPIC
  } catch {
    return DEFAULT_TOPIC
  }
}

interface ItemRow {
  id: string
  title: string
  url: string
  summary: string | null
  sourceId: string
  publishedAt: Date | null
  fetchedAt: Date
  raw: string | null
  source: { name: string; kind: string } | null
}

function itemTime(item: ItemRow): Date {
  return item.publishedAt ?? item.fetchedAt
}

export async function discoverClusters(
  prisma: PrismaClient,
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const now = options.now ?? new Date()
  const threshold = options.threshold ?? DISCOVER_THRESHOLD
  const limit = options.limit ?? DISCOVER_DEFAULT_LIMIT
  const lookbackHours = options.lookbackHours ?? DISCOVER_LOOKBACK_HOURS
  const clusterLimit = options.clusterLimit ?? DISCOVER_CLUSTER_LIMIT

  const domain = (options.domain ?? (await readDiscoverDomain(prisma))).trim() || DEFAULT_TOPIC
  const keywords = domainKeywords(domain)

  const since = new Date(now.getTime() - lookbackHours * 3_600_000)
  const growthSince = new Date(now.getTime() - GROWTH_WINDOW_HOURS * 3_600_000)

  const rows = await prisma.cluster.findMany({
    where: { lastSeenAt: { gte: since } },
    orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
    take: clusterLimit,
    include: {
      items: {
        orderBy: [{ fetchedAt: 'desc' }, { id: 'asc' }],
        include: { source: { select: { name: true, kind: true } } },
      },
    },
  })

  const scored: DiscoveredCluster[] = []

  for (const cluster of rows) {
    const items = cluster.items as ItemRow[]
    if (items.length === 0) continue

    // 领域筛选：标题 + 摘要里任一中关键词即算进这个领域
    const text = domainText(
      items.map((i) => i.title),
      items.map((i) => i.summary),
    )
    if (!matchesDomain(text, keywords)) continue

    const sourceIds = new Set(items.map((i) => i.sourceId))
    let maxHeat = 0
    let recent = 0
    for (const item of items) {
      const h = heat(item.source?.kind ?? null, item.raw)
      if (h > maxHeat) maxHeat = h
      if (itemTime(item).getTime() >= growthSince.getTime()) recent += 1
    }

    const score = scoreCluster(
      {
        itemCount: items.length,
        sourceCount: sourceIds.size,
        maxHeat,
        firstSeenAt: cluster.firstSeenAt,
        recentItemCount: recent,
      },
      now,
    )

    if (score.score < threshold) continue

    scored.push({
      clusterId: cluster.id,
      title: cluster.title,
      itemCount: items.length,
      sourceCount: sourceIds.size,
      firstSeenAt: cluster.firstSeenAt.toISOString(),
      lastSeenAt: cluster.lastSeenAt.toISOString(),
      heatScore: cluster.heatScore,
      domain,
      samples: items.slice(0, 3).map((i) => ({
        id: i.id,
        title: i.title,
        url: i.url,
        sourceName: i.source?.name ?? null,
      })),
      ...score,
    })
  }

  // 得分降序；同分按 clusterId 升序 —— 结果与查询顺序无关，可复现
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.clusterId < b.clusterId ? -1 : 1))

  return {
    domain,
    threshold,
    considered: rows.length,
    matched: scored.length,
    clusters: scored.slice(0, limit),
  }
}

export { DEFAULT_DISCOVER_DOMAIN, DOMAIN_PROFILES, domainKeywords, matchesDomain } from './profile.js'
export {
  DISCOVER_THRESHOLD,
  DISCOVER_WEIGHTS,
  GROWTH_WINDOW_HOURS,
  NOVELTY_HALF_LIFE_HOURS,
  heatOf,
  growthOf,
  noveltyOf,
  scoreCluster,
} from './score.js'
export type { DiscoverInput, DiscoverScore } from './score.js'
