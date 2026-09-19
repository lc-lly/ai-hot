import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import { HttpError } from '../errors.js'

/**
 * 监控词 CRUD（契约未冻结，本文件即契约）。
 *
 * ```
 * GET    /api/topics        列表
 * POST   /api/topics        新建
 * PATCH  /api/topics/:id    局部更新（含 `enabled` 启停）
 * DELETE /api/topics/:id    删除（级联删掉它的 Match）
 * ```
 *
 * ## 为什么端点必须负责 JSON 解析
 *
 * schema 里 `include` / `exclude` / `sourceKinds` 存的是 **JSON 字符串**
 * （SQLite 没有数组类型）。如果端点把列值原样返回，前端拿到的是 `"[]"`，
 * 而 `.map()` / `.length` 都会静默给出错误结果（`"[]".length === 2`）。
 * 所以**出口一律解析成数组，入口一律序列化成字符串**，这个转换只在这里发生。
 */

export const NOTIFY_POLICIES = ['high_only', 'all_confirmed', 'digest'] as const
export type NotifyPolicy = (typeof NOTIFY_POLICIES)[number]

/** 来源种类，用于 `sourceKinds` 的合法性校验。与 `src/sources/index.ts` 的注册表一致。 */
const SOURCE_KINDS = [
  'hackernews',
  'github-trending',
  'reddit',
  'rss',
  'bilibili',
  'baidu-hot',
  'hn-algolia',
  'reddit-search',
  'github-search',
  'bilibili-search',
  'sogou-weixin',
  'bing-search',
] as const

export interface TopicDTO {
  id: string
  name: string
  include: string[]
  exclude: string[]
  sourceKinds: string[]
  minConfidence: number
  notifyPolicy: NotifyPolicy
  enabled: boolean
  /** ISO 8601 */
  createdAt: string
  /** 累计命中数（含已否决的）。列表页用来回答「这个词到底有没有在工作」 */
  matchCount: number
}

interface TopicRow {
  id: string
  name: string
  include: string
  exclude: string
  sourceKinds: string
  minConfidence: number
  notifyPolicy: string
  enabled: boolean
  createdAt: Date
  _count?: { matches: number }
}

function parseList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    // 脏数据当空数组，而不是让整个列表 500
    return []
  }
}

function toTopicDTO(row: TopicRow): TopicDTO {
  return {
    id: row.id,
    name: row.name,
    include: parseList(row.include),
    exclude: parseList(row.exclude),
    sourceKinds: parseList(row.sourceKinds),
    minConfidence: row.minConfidence,
    notifyPolicy:
      typeof row.notifyPolicy === 'string' &&
      (NOTIFY_POLICIES as readonly string[]).includes(row.notifyPolicy)
        ? (row.notifyPolicy as NotifyPolicy)
        : 'high_only',
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    matchCount: row._count?.matches ?? 0,
  }
}

/** 清洗用户给的字符串数组：去空白、去重、丢弃非字符串与空串。 */
function cleanList(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new HttpError(400, 'BAD_REQUEST', `${field} 必须是字符串数组`)
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') throw new HttpError(400, 'BAD_REQUEST', `${field} 里含非字符串元素`)
    const t = x.trim()
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}

function cleanName(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'name 必填且不能为空')
  }
  const name = v.trim()
  if (name.length > 60) throw new HttpError(400, 'BAD_REQUEST', 'name 最长 60 字')
  return name
}

/**
 * 新建/改词之后，把此前被跳过的条目重置为待处理。
 *
 * **这是防「永久漏报」的硬性要求，不是优化。**
 * 三层过滤为了省钱会把明显无关的条目置为 `aiState = 'skipped'` 并永不重看。
 * 用户事后添加了一个恰好命中那批条目的关键词时，如果不重置，
 * 这些条目**再也不会被评估**——用户看到的是一张永远空着的监控词卡片，
 * 而没有任何地方告诉他「其实有 30 条命中了，只是我们当初跳过了」。
 * spec §4.2 的原则正是「漏报比误报更难被发现」。
 *
 * 用 `updateMany` 一条 SQL 搞定；条目量级在万级以下，代价可忽略。
 */
async function reviveSkipped(prisma: PrismaClient): Promise<number> {
  const { count } = await prisma.hotItem.updateMany({
    where: { aiState: 'skipped' },
    data: { aiState: 'pending' },
  })
  return count
}

export function topicRoutes(deps: { prisma: PrismaClient }): Router {
  const router = Router()
  const { prisma } = deps

  router.get('/topics', async (_req, res) => {
    const rows = await prisma.topic.findMany({
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { matches: true } } },
    })
    res.json({ data: rows.map(toTopicDTO) })
  })

  router.post('/topics', async (req, res) => {
    const body = req.body as Record<string, unknown>
    const name = cleanName(body.name)

    const include = cleanList(body.include, 'include') ?? []
    const exclude = cleanList(body.exclude, 'exclude') ?? []
    // 空数组 = 不限来源，这是有意义的默认值，不是「缺省」
    const sourceKinds = cleanList(body.sourceKinds, 'sourceKinds') ?? []
    for (const k of sourceKinds) {
      if (!(SOURCE_KINDS as readonly string[]).includes(k)) {
        throw new HttpError(400, 'BAD_REQUEST', `未知的来源种类：${k}`)
      }
    }

    const minConfidence =
      body.minConfidence === undefined ? 0.5 : Number(body.minConfidence)
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new HttpError(400, 'BAD_REQUEST', 'minConfidence 必须是 0..1 的数')
    }

    const notifyPolicy = body.notifyPolicy === undefined ? 'high_only' : body.notifyPolicy
    if (!(NOTIFY_POLICIES as readonly string[]).includes(notifyPolicy as string)) {
      throw new HttpError(400, 'BAD_REQUEST', `notifyPolicy 只能是 ${NOTIFY_POLICIES.join(' / ')}`)
    }

    const dup = await prisma.topic.findUnique({ where: { name } })
    if (dup) throw new HttpError(409, 'CONFLICT', `监控词「${name}」已存在`)

    const row = await prisma.topic.create({
      data: {
        name,
        include: JSON.stringify(include),
        exclude: JSON.stringify(exclude),
        sourceKinds: JSON.stringify(sourceKinds),
        minConfidence,
        notifyPolicy: notifyPolicy as string,
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      },
      include: { _count: { select: { matches: true } } },
    })

    // 新词的 `include` 可能命中此前被跳过的条目，必须给它们一次机会
    await reviveSkipped(prisma)

    res.status(201).json({ data: toTopicDTO(row) })
  })

  router.patch('/topics/:id', async (req, res) => {
    const body = req.body as Record<string, unknown>
    const id = req.params.id

    const existing = await prisma.topic.findUnique({ where: { id } })
    if (!existing) throw new HttpError(404, 'NOT_FOUND', '监控词不存在')

    const data: Record<string, unknown> = {}

    if (body.name !== undefined) {
      const name = cleanName(body.name)
      if (name !== existing.name) {
        const dup = await prisma.topic.findUnique({ where: { name } })
        if (dup) throw new HttpError(409, 'CONFLICT', `监控词「${name}」已存在`)
        data.name = name
      }
    }

    for (const field of ['include', 'exclude', 'sourceKinds'] as const) {
      const parsed = cleanList(body[field], field)
      if (parsed !== undefined) data[field] = JSON.stringify(parsed)
    }

    if (body.minConfidence !== undefined) {
      const minConfidence = Number(body.minConfidence)
      if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        throw new HttpError(400, 'BAD_REQUEST', 'minConfidence 必须是 0..1 的数')
      }
      data.minConfidence = minConfidence
    }

    if (body.notifyPolicy !== undefined) {
      if (!(NOTIFY_POLICIES as readonly string[]).includes(body.notifyPolicy as string)) {
        throw new HttpError(400, 'BAD_REQUEST', `notifyPolicy 只能是 ${NOTIFY_POLICIES.join(' / ')}`)
      }
      data.notifyPolicy = body.notifyPolicy
    }

    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled)

    const row = await prisma.topic.update({
      where: { id },
      data,
      include: { _count: { select: { matches: true } } },
    })

    // 只有「扩大匹配面」的改动才需要重评：改了 include、或从停用变启用。
    // 单纯改名字或缩小范围不该让 AI 白跑一轮。
    const widenedInclude = data.include !== undefined && data.include !== JSON.stringify(parseList(existing.include))
    const reEnabled = data.enabled === true && existing.enabled === false
    const revived = widenedInclude || reEnabled ? await reviveSkipped(prisma) : 0

    res.json({ data: toTopicDTO(row), revived })
  })

  router.delete('/topics/:id', async (req, res) => {
    const id = req.params.id
    const existing = await prisma.topic.findUnique({ where: { id } })
    if (!existing) throw new HttpError(404, 'NOT_FOUND', '监控词不存在')

    // Match 有 onDelete: Cascade，删词会连带删掉它的命中记录。
    // 这是有意的：Match 是「这个词 × 这条内容」的关系，词没了关系就没有主语。
    // 条目本身（HotItem）不受影响。
    await prisma.topic.delete({ where: { id } })
    res.status(204).end()
  })

  return router
}
