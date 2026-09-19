import { describe, expect, it } from 'vitest'
import { formatDiscoverBody } from '../../src/jobs/discover.js'
import type { DiscoveredCluster } from '../../src/discover/index.js'

/**
 * `formatDiscoverBody` 的输出形状。
 *
 * 这个格式有**两个消费者**，且各自的失效方式完全不同：
 *
 * 1. 通知面板（`web/src/components/NotificationBell.tsx`）用
 *    `line-clamp-6` + `white-space: pre-line` 渲染它。在那套渲染下
 *    换行**计入**行数、**空行占满一整行**，所以行盒数超预算的症状不是
 *    「显示不全」而是「链接永远看不见」——面板底部停在一个空行上。
 * 2. 邮件正文原样使用它（`notify/index.ts` 的 `bodyOf`）。
 *
 * 改这个函数之前先看 `discover.ts` 里那段行数预算的注释。
 */

function cluster(over: Partial<DiscoveredCluster> = {}): DiscoveredCluster {
  return {
    clusterId: 'c1',
    title: 'Cloudflare将每天90亿次请求的JavaScript CDN迁移到其开发者平台',
    itemCount: 1,
    sourceCount: 1,
    firstSeenAt: '2026-09-17T00:00:00.000Z',
    lastSeenAt: '2026-09-17T06:00:00.000Z',
    heatScore: 0.5,
    domain: 'AI 编程',
    samples: [
      {
        id: 'i1',
        title: 't',
        url: 'https://infoq.cn/article/J5iJdjq6bIeRZHZF8fXO',
        sourceName: null,
      },
    ],
    novelty: 0.78,
    heat: 0.29,
    growth: 0.6,
    score: 0.566,
    ageHours: 6,
    ...over,
  }
}

describe('formatDiscoverBody', () => {
  it('行盒数落在面板的 6 行预算内', () => {
    expect(formatDiscoverBody(cluster()).split('\n')).toHaveLength(5)
  })

  it('一个空行都没有 —— 空行会吃掉一行配额，把链接挤出可视区', () => {
    // 这是这组测试里最要紧的一条。旧排版是「标题、空、指标、来源、综合分、空、链接」
    // 共 7 行盒，clamp 到 6 行后链接永远不显示、面板底部停在空行上。
    // 若有人为了「好看」把空行加回来，这条会挂
    expect(formatDiscoverBody(cluster())).not.toMatch(/\n\s*\n/)
  })

  it('首行是集群标题，末行是代表链接', () => {
    const lines = formatDiscoverBody(cluster()).split('\n')
    expect(lines[0]).toBe('Cloudflare将每天90亿次请求的JavaScript CDN迁移到其开发者平台')
    expect(lines.at(-1)).toBe('https://infoq.cn/article/J5iJdjq6bIeRZHZF8fXO')
  })

  it('标题里的换行被折平 —— 否则它多吃一行配额', () => {
    const lines = formatDiscoverBody(cluster({ title: '第一行\n第二行  带  多空格' })).split('\n')
    expect(lines[0]).toBe('第一行 第二行 带 多空格')
    expect(lines).toHaveLength(5)
  })

  it('领域名留在正文里 —— 客户端拿不到 payload，没有别的来源', () => {
    expect(formatDiscoverBody(cluster())).toContain('领域「AI 编程」')
  })

  it('没有 samples 时不编造链接行，行数少一行', () => {
    const lines = formatDiscoverBody(cluster({ samples: [] })).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines.at(-1)).toContain('综合分')
  })

  it('三个维度按百分比四舍五入，综合分保留三位', () => {
    // score 是 0..1 的加权值，直接 toFixed(3) 是给排查用的精度，不是展示精度
    expect(formatDiscoverBody(cluster())).toContain('热度 29%｜新颖度 78%｜增速 60%')
    expect(formatDiscoverBody(cluster())).toContain('综合分 0.566')
  })

  it('来源数与条数都来自簇本身', () => {
    expect(formatDiscoverBody(cluster({ sourceCount: 4, itemCount: 9 }))).toContain(
      '4 个来源 / 9 条相关',
    )
  })
})
