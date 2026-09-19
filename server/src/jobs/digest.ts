import { discoverClusters, readDiscoverDomain } from '../discover/index.js'
import type { JobContext } from './types.js'

/**
 * `digest` —— 每天 9:00（spec §8）：生成领域 Top 10 摘要，**邮件 + 站内**。
 *
 * 「领域」与 `discover` 共用同一个 `Setting` 键（`discover.domain`），
 * 于是「用户在设置里改一次，发现页与日报同时跟着变」——
 * 两个入口各读一个配置是这类系统里最常见的割裂来源。
 *
 * 排行复用 `discover` 的打分：日报是「过去 24 小时的 Top 10」，
 * 发现页是「此刻过阈值的簇」。同一套分数，只是窗口与阈值不同。
 */

/** 日报条数（spec §8：Top 10） */
export const DIGEST_TOP_N = 10

/** 日报窗口：过去 24 小时 */
export const DIGEST_WINDOW_HOURS = 24

/** 正文里每条最多截断到多少字，避免超长标题把邮件撑爆 */
const TITLE_CLIP = 120

function clip(text: string): string {
  return text.length <= TITLE_CLIP ? text : `${text.slice(0, TITLE_CLIP)}…`
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export interface DigestRunResult extends Record<string, unknown> {
  domain: string
  considered: number
  items: number
  notified: boolean
  channels: string[]
}

export async function runDigestJob(ctx: JobContext): Promise<DigestRunResult> {
  const domain = await readDiscoverDomain(ctx.prisma)

  // threshold 0 = 不过阈值，只取排行；日报的价值在「今天发生了什么」，
  // 而不是「今天有没有爆点」——阈值卡掉全部条目时用户会以为系统坏了。
  const result = await discoverClusters(ctx.prisma, {
    domain,
    now: ctx.now,
    threshold: 0,
    limit: DIGEST_TOP_N,
    lookbackHours: DIGEST_WINDOW_HOURS,
  })

  if (result.clusters.length === 0) {
    ctx.logger({
      level: 'info',
      channel: 'system',
      message: `digest：领域「${domain}」过去 ${DIGEST_WINDOW_HOURS} 小时没有可用条目，本轮不发日报`,
      meta: { domain, considered: result.considered },
    })
    return { domain, considered: result.considered, items: 0, notified: false, channels: [] }
  }

  const lines = result.clusters.map((cluster, index) => {
    const heat = Math.round(cluster.heat * 100)
    return `${index + 1}. ${clip(cluster.title)}（${cluster.sourceCount} 源 / ${cluster.itemCount} 条 / 热度 ${heat}%）`
  })

  const body = [
    `【${domain}】过去 ${DIGEST_WINDOW_HOURS} 小时 Top ${result.clusters.length}`,
    '',
    ...lines,
  ].join('\n')

  const outcome = await ctx.notify({
    level: 'push',
    title: `领域日报 · ${domain} · ${formatDate(ctx.now)}`,
    body,
    // 邮件由 `src/notify/**` 按 SMTP_URL 是否配置决定是否真的投递；
    // 站内始终可用，所以日报不会因为没配 SMTP 就消失
    channels: ['inapp', 'email'],
    payload: {
      kind: 'digest',
      domain,
      clusterIds: result.clusters.map((c) => c.clusterId),
    },
  })

  ctx.logger({
    level: 'info',
    channel: 'notify',
    message: `digest 已生成：领域「${domain}」Top ${result.clusters.length}，投递渠道 [${outcome.channels.join(', ') || '无'}]`,
    meta: { domain, items: result.clusters.length, channels: outcome.channels },
  })

  return {
    domain,
    considered: result.considered,
    items: result.clusters.length,
    notified: true,
    channels: outcome.channels,
  }
}
