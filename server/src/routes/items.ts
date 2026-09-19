import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import { toItemDTO } from '../score/dto.js'
import { IMPORTANCE_LEVELS } from '../score/importance.js'
import { AI_FLAGS } from '../score/types.js'
import { rollingWindowFilter } from '../window.js'

/**
 * `GET /api/items` —— 卡片流的唯一数据源。
 *
 * ## 响应信封（冻结）
 *
 * ```json
 * { "data": [ItemDTO], "pagination": { "page", "pageSize", "total", "totalPages" } }
 * ```
 *
 * `total` 是**筛选后的**总数，不是全库总数——统计卡的「总热点」恒为全库，
 * 由 `/api/stats` 提供。两者语义必须分开，否则「卡片说 62 条、分页说 3 条」会打架。
 *
 * ## 为什么排序必须有 id 兜底
 *
 * `HEAT_FALLBACK = 0.3` 意味着取不到互动量的源（rss 等）**大批同分**；
 * 实测 hackernews 还有一批撞在 `heatScore = 1` 上限的。SQLite 对同分行
 * 不保证稳定顺序 → 翻页时同一条会在第 1 页和第 2 页各出现一次。
 * 所以任何排序都追加 `id` 作次级键，让顺序完全确定。
 *
 * ## 为什么 `sort` 要走白名单
 *
 * 查询参数是任意字符串，直接拼进 Prisma 的 `orderBy` 会在未知字段上抛错。
 */

/** 排序别名 → 真实列。**别名是契约的一部分，前端按这个传。** */
const SORT_FIELDS: Readonly<Record<string, string>> = {
  fetchedAt: 'fetchedAt',
  publishedAt: 'publishedAt',
  heat: 'heatScore',
  importance: 'importanceRank',
  authenticity: 'authenticity',
}

export const DEFAULT_SORT = 'fetchedAt'
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

/** 「时间范围」→ 小时数。刻意用滚动窗口，不用「今天 00:00」，理由见 `../window.js`。 */
const TIME_RANGES: Readonly<Record<string, number>> = {
  '1h': 1,
  '24h': 24,
  '7d': 7 * 24,
  '30d': 30 * 24,
}

/** 「疑似虚假」的判定口径，与 `web/src/lib/format.ts` 的 `truthMark` 保持一致。 */
const SUSPICIOUS_FLAGS = ['rumor', 'clickbait', 'ad']

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function int(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function parseFlagsList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => AI_FLAGS.includes(s))
}

export function itemRoutes(deps: { prisma: PrismaClient }): Router {
  const router = Router()

  router.get('/items', async (req, res) => {
    const q = req.query

    const page = int(q.page, 1)
    const pageSize = Math.min(int(q.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)

    const sortAlias = str(q.sort) ?? DEFAULT_SORT
    const sortField = SORT_FIELDS[sortAlias] ?? SORT_FIELDS[DEFAULT_SORT]!
    const order = str(q.order) === 'asc' ? 'asc' : 'desc'

    const since = str(q.since)
    const timeRange = str(q.timeRange)
    const importance = str(q.importance)
    const authenticity = str(q.authenticity)
    const excludeFlags = str(q.excludeFlags)

    // ---- where 组装 ----
    const and: Record<string, unknown>[] = []

    const sourceId = str(q.sourceId)
    if (sourceId) and.push({ sourceId })

    const kind = str(q.kind)
    if (kind) and.push({ source: { kind } })

    const domain = str(q.domain)
    if (domain) and.push({ domain })

    // 白名单校验：非法档位当作没传，而不是构造出一个永远空的结果集
    if (importance && (IMPORTANCE_LEVELS as readonly string[]).includes(importance)) {
      and.push({ importance })
    }

    const topicId = str(q.topicId)
    if (topicId) and.push({ matches: { some: { topicId } } })

    if (timeRange && TIME_RANGES[timeRange] !== undefined) {
      and.push(rollingWindowFilter(TIME_RANGES[timeRange]!))
    } else if (since) {
      const d = new Date(since)
      if (!Number.isNaN(d.getTime())) and.push({ fetchedAt: { gte: d } })
    }

    const text = str(q.q)
    if (text) {
      and.push({
        OR: [
          { title: { contains: text } },
          { summary: { contains: text } },
          { author: { contains: text } },
        ],
      })
    }

    if (authenticity === 'real') {
      and.push({ authenticity: { gte: 0.5 } })
      for (const f of SUSPICIOUS_FLAGS) and.push({ NOT: { aiFlags: { contains: `"${f}"` } } })
    } else if (authenticity === 'suspicious') {
      // **未评估（authenticity 为 null）不算疑似虚假。**
      // 把「没评估」归进「假」和把「没评估」显示成「相关度 0%」是同一类错误：
      // 它会让我们自己的沉默被读成一项指控。
      const or: Record<string, unknown>[] = [{ authenticity: { lt: 0.5 } }]
      for (const f of SUSPICIOUS_FLAGS) or.push({ aiFlags: { contains: `"${f}"` } })
      and.push({ OR: or, NOT: { authenticity: null } })
    }

    if (excludeFlags) {
      for (const f of parseFlagsList(excludeFlags)) {
        and.push({ NOT: { aiFlags: { contains: `"${f}"` } } })
      }
    }

    const where = and.length > 0 ? { AND: and } : {}

    const include = {
      source: { select: { name: true, kind: true } },
      matches: { select: { topicId: true, relevance: true, confidence: true, isAbout: true, reasoning: true, topic: { select: { name: true } } } },
    } as const

    const [total, rows] = await Promise.all([
      deps.prisma.hotItem.count({ where }),
      deps.prisma.hotItem.findMany({
        where,
        // id 作次级键：同分行的顺序必须确定，否则翻页会重复/漏行
        orderBy: [{ [sortField]: order }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include,
      }),
    ])

    res.json({
      data: rows.map((r) => toItemDTO(r, { preferredTopicId: topicId })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    })
  })

  return router
}
