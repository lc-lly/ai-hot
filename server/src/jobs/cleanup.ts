import type { Prisma } from '@prisma/client'
import type { JobContext } from './types.js'

/**
 * `cleanup` —— 每天（spec §8）：清理 30 天前的**原文**。
 *
 * ## 为什么是清 `raw` 而不是删条目
 *
 * spec §4.2 的原则是「低置信不删除，只降级」——**漏报比误报更难被发现，
 * 必须留有可找回的痕迹**。真删了 `HotItem` 行会连带删掉：
 * - `Match`（关键词命中的历史与 AI 判定结果，用户还能标记「AI 看错了」）；
 * - `Cluster` 的来源构成（L3 交叉验证的证据）；
 * - 日报 / 发现页里已经推送过的链接指向。
 *
 * 审计轨迹一旦被删就找不回来了，而 `raw`（adapter 抓到的原始 JSON）
 * 是唯一**体积大且可重新抓取**的部分——它才是这条规则真正想清理的东西。
 * 所以这里只把 `raw` 置空，条目、标题、URL、AI 判定全部保留。
 */

/** 原文保留天数（spec §8：30 天） */
export const RAW_RETENTION_DAYS = 30

export interface CleanupRunResult extends Record<string, unknown> {
  cutoff: string
  cleared: number
  matched: number
  deleted: number
  retentionDays: number
}

export async function runCleanupJob(ctx: JobContext): Promise<CleanupRunResult> {
  const cutoff = new Date(ctx.now.getTime() - RAW_RETENTION_DAYS * 24 * 3_600_000)

  // 只挑「够旧」且「还有 raw」的行。已经清过的不会被反复命中。
  const where: Prisma.HotItemWhereInput = {
    fetchedAt: { lt: cutoff },
    raw: { not: null },
  }

  const matched = await ctx.prisma.hotItem.count({ where })
  const updated = await ctx.prisma.hotItem.updateMany({ where, data: { raw: null } })

  ctx.logger({
    level: 'info',
    channel: 'system',
    message: `cleanup：清空 ${updated.count} 条早于 ${cutoff.toISOString()} 的原文（raw），条目本身一条未删（spec §4.2）`,
    meta: { cutoff: cutoff.toISOString(), cleared: updated.count, deleted: 0 },
  })

  return {
    cutoff: cutoff.toISOString(),
    cleared: updated.count,
    matched,
    // 显式写出来，让 `/api/jobs` 上的结果自证「没有删条目」
    deleted: 0,
    retentionDays: RAW_RETENTION_DAYS,
  }
}
