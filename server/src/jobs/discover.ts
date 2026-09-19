import type { PrismaClient } from '@prisma/client'
import { discoverClusters, readDiscoverDomain, type DiscoveredCluster } from '../discover/index.js'
import type { JobContext } from './types.js'

/**
 * `discover` —— 每 6 小时（spec §8）：「自动搜集指定范围热点」的落地，
 * 也是需求方两条头等需求之一。
 *
 * 打分口径在 `src/discover/**`（纯函数 + 只读查询），这里只做**推送与去重**：
 * 算出过阈值的簇 → 去掉已经推过的 → 发通知 → 记住推过哪些。
 *
 * 「已经推过」的状态存哪：**没有为它加 schema**。
 * `Cluster.aiConfidence` 之类的字段语义是 AI 判定结果，借用它们会把
 * 「AI 置信度」和「推送记账」两件事混成一件。所以用 `Setting` 里一个
 * 私有的键（`discover.pushed`）存 `{ ids: [{ id, at }] }`，
 * 带 30 天过期与条数上限——键值表本来就是干这个的。
 */

/** 单轮最多推几条：发现页可以列 20 条，但推送不能一次炸 20 条通知。 */
export const DISCOVER_PUSH_LIMIT = 5

/** 单轮最多给发现页算多少个簇 */
export const DISCOVER_SCAN_LIMIT = 20

/** 推送记账的 `Setting` 键 */
export const DISCOVER_PUSHED_KEY = 'discover.pushed'

/** 记账保留时长（天） */
export const PUSHED_RETENTION_DAYS = 30

/** 记账条数上限，防止无限增长 */
export const PUSHED_MAX_ENTRIES = 500

interface PushedEntry {
  id: string
  at: string
}

function parsePushed(value: string | undefined): PushedEntry[] {
  if (value === undefined || value.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    const ids = (parsed as Record<string, unknown> | null)?.['ids']
    if (!Array.isArray(ids)) return []
    return ids
      .map((entry) => {
        if (entry === null || typeof entry !== 'object') return null
        const id = (entry as Record<string, unknown>)['id']
        const at = (entry as Record<string, unknown>)['at']
        return typeof id === 'string' && typeof at === 'string' ? { id, at } : null
      })
      .filter((e): e is PushedEntry => e !== null)
  } catch {
    return []
  }
}

/** 读取推送记账（id → 推送时刻 ISO）。超期的条目在读取时就被丢掉。 */
export async function loadPushed(
  prisma: PrismaClient,
  now: Date,
): Promise<Map<string, string>> {
  const cutoff = now.getTime() - PUSHED_RETENTION_DAYS * 24 * 3_600_000
  const row = await prisma.setting.findUnique({ where: { key: DISCOVER_PUSHED_KEY } })

  const map = new Map<string, string>()
  for (const entry of parsePushed(row?.value)) {
    // 半开区间：`at` 恰好等于 cutoff 时保留，避免边界抖动
    if (new Date(entry.at).getTime() >= cutoff) map.set(entry.id, entry.at)
  }
  return map
}

/** 写回推送记账。按时间升序截断到上限，**不刷新已有条目的时间戳**。 */
export async function savePushed(
  prisma: PrismaClient,
  pushed: ReadonlyMap<string, string>,
  now: Date,
): Promise<void> {
  const cutoff = now.getTime() - PUSHED_RETENTION_DAYS * 24 * 3_600_000

  const entries: PushedEntry[] = [...pushed.entries()]
    .map(([id, at]) => ({ id, at }))
    .filter((e) => {
      const t = new Date(e.at).getTime()
      return Number.isFinite(t) && t >= cutoff
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  const value = JSON.stringify({ ids: entries.slice(-PUSHED_MAX_ENTRIES) })
  await prisma.setting.upsert({
    where: { key: DISCOVER_PUSHED_KEY },
    create: { key: DISCOVER_PUSHED_KEY, value },
    update: { value },
  })
}

/**
 * 推送正文：标题 + 三个维度 + 一条代表链接。
 *
 * ## 行数是有预算的，且**空行也占一行**——所以这里不留空行
 *
 * 客户端（通知面板）用 `line-clamp-6` + `white-space: pre-line` 渲染这段文本。
 * 在那套渲染下，`\n` 的强制换行**计入**行数，空行占满整行。
 *
 * 原先的排版是「标题、空、指标、来源、综合分、空、链接」共 7 个行盒，
 * 于是 clamp 到 6 行时显示的是前六行：**链接永远不会出现，而面板底部
 * 停在一个空行上**。所谓 6 行其实只有 4 行有内容。空行在这里不是留白，
 * 是吃掉一行配额。
 *
 * 所以：排版恰好落在 5 行盒内，clamp 只当病态兜底，不承担正常截断。
 * 改这个函数时要重新数行数——面板那边的预算和这里是一件事。
 */
export function formatDiscoverBody(cluster: DiscoveredCluster): string {
  // 标题是唯一可能自带换行的字段（它来自条目标题，而 RSS 的标题里
  // 什么都可能有）。它多一个 `\n` 就多吃一行配额，且症状是「链接又不见了」。
  // 折成单行：标题里的连续空白本来也没有意义。
  const title = cluster.title.replace(/\s+/g, ' ').trim()
  const lines = [
    title,
    `热度 ${Math.round(cluster.heat * 100)}%｜新颖度 ${Math.round(cluster.novelty * 100)}%｜增速 ${Math.round(cluster.growth * 100)}%`,
    // `domain` 挂在这里而不是标题上：标题那行要让给集群标题，而客户端
    // 的 `NotificationDTO` 不含 `payload`（见 `routes/notifications.ts` 的
    // `toDTO`），领域名在客户端**没有别的来源**。删掉它，用户就分不清
    // 这条热点属于哪个监控词了
    `${cluster.sourceCount} 个来源 / ${cluster.itemCount} 条相关 · 领域「${cluster.domain}」`,
    `综合分 ${cluster.score.toFixed(3)}（阈值以上自动发现）`,
  ]
  const first = cluster.samples[0]
  if (first) lines.push(first.url)
  return lines.join('\n')
}

export interface DiscoverRunResult extends Record<string, unknown> {
  domain: string
  considered: number
  matched: number
  pushed: number
  alreadyPushed: number
  notifier: string
  top: Array<{ clusterId: string; title: string; score: number; sources: number }>
}

export async function runDiscoverJob(ctx: JobContext): Promise<DiscoverRunResult> {
  const domain = await readDiscoverDomain(ctx.prisma)
  const result = await discoverClusters(ctx.prisma, {
    domain,
    now: ctx.now,
    limit: DISCOVER_SCAN_LIMIT,
  })

  const pushed = await loadPushed(ctx.prisma, ctx.now)
  const fresh = result.clusters.filter((c) => !pushed.has(c.clusterId))
  const alreadyPushed = result.clusters.length - fresh.length
  const toPush = fresh.slice(0, DISCOVER_PUSH_LIMIT)

  let notified = 0
  for (const cluster of toPush) {
    await ctx.notify({
      level: 'push',
      /*
        标题里放**集群标题**而不是领域名。

        原先写的是 `发现热点 · ${domain}`，而一轮里同一个领域的簇会有好几条，
        于是通知列表里并排躺着四五条一模一样的「发现热点 · AI 编程」——
        真正讲什么埋在正文第一行，扫读时完全分不出来。邮件主题也是这句，
        等于每封邮件都只有同一句话。

        领域名没丢，挪到了正文里（见 `formatDiscoverBody`）。
      */
      title: `发现热点 · ${cluster.title}`,
      body: formatDiscoverBody(cluster),
      channels: ['inapp', 'webpush'],
      payload: {
        kind: 'discover',
        clusterId: cluster.clusterId,
        domain,
        score: cluster.score,
      },
    })
    pushed.set(cluster.clusterId, ctx.now.toISOString())
    notified += 1
  }

  // 没有新推送就不写库：每 6 小时一次无意义的写没必要
  if (notified > 0) await savePushed(ctx.prisma, pushed, ctx.now)

  ctx.logger({
    level: 'info',
    channel: 'system',
    message: `discover 完成（领域「${domain}」）：候选 ${result.considered} 个簇，过阈值 ${result.matched} 个，本轮推送 ${notified} 条`,
    meta: { domain, considered: result.considered, matched: result.matched, pushed: notified },
  })

  return {
    domain,
    considered: result.considered,
    matched: result.matched,
    pushed: notified,
    alreadyPushed,
    notifier: ctx.notifierSource,
    top: result.clusters.slice(0, DISCOVER_PUSH_LIMIT).map((c) => ({
      clusterId: c.clusterId,
      title: c.title,
      score: c.score,
      sources: c.sourceCount,
    })),
  }
}
