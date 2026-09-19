import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGAGEMENT_THRESHOLDS,
  checkEngagement,
  readThresholds,
} from '../../src/pipeline/engagement.js'

/**
 * 互动阈值闸门的语义测试。
 *
 * 这个文件存在的理由：闸门的口径**看起来**像一句 `if (likes > 10 && ...)`，
 * 但真实口径有三条反直觉的规则，每一条都有对应的用例——
 *
 * 1. 缺指标的源一律放行（否则库里只剩 B站 一个源）
 * 2. 三项之间是 AND（用户明确要求「全满足」）
 * 3. `>` 是严格大于（用户原话是「大于 10」，`like === 10` 必须拒）
 *
 * 规则 1 和 2 冲突时以 1 为准：`reposts` 取不到就当场退出这一项的判定，
 * 而不是把「取不到」当成「不达标」。
 */

describe('checkEngagement：缺指标的源一律放行', () => {
  it('raw 什么都没有的源直接通过（rss / 百度 / 搜狗 / Bing 走这条）', () => {
    expect(checkEngagement('rss', { whatever: 1 })).toBeNull()
    expect(checkEngagement('bing-search', { query: '大模型' })).toBeNull()
    expect(checkEngagement('sogou-weixin', { query: 'x', account: '机器之心' })).toBeNull()
  })

  it('raw 为 null / undefined / 坏 JSON 都不算不达标', () => {
    expect(checkEngagement('bilibili', null)).toBeNull()
    expect(checkEngagement('bilibili', undefined)).toBeNull()
    expect(checkEngagement('bilibili', '{不是 JSON')).toBeNull()
    // raw 是**字符串**形式的 JSON 也要能认（Prisma 里 raw 存的就是字符串）
    expect(checkEngagement('bilibili', '{"like":1,"share":0,"view":2}')).toContain('点赞')
  })

  it('百度热搜不算不达标 —— 它的 hotScore 不是互动计数', () => {
    // hotScore 量级 300 万~800 万，但它是百度自己的热度值。
    // metricsOf('baidu-hot') 故意留空，所以这里必须放行，
    // 否则等于拿「热度值」冒充「点赞数」来判定。
    expect(checkEngagement('baidu-hot', { hotScore: 3 })).toBeNull()
  })

  it('只提供 points / stars 的源不受这三项约束', () => {
    // HN 的点数、GitHub 的 star 与「点赞/转发/浏览」不是同一把尺子。
    // 拿 10 去卡 star 会把整个 GitHub 源清空。
    expect(checkEngagement('hackernews', { score: 1, descendants: 0 })).toBeNull()
    expect(checkEngagement('github-trending', { starsToday: '3 stars today' })).toBeNull()
  })
})

describe('checkEngagement：AND 与严格大于', () => {
  const bili = (like: number, share: number, view: number) => ({ like, share, view })

  it('三项全过才通过', () => {
    expect(checkEngagement('bilibili', bili(11, 6, 501))).toBeNull()
  })

  it('任一项不达标即被拒', () => {
    expect(checkEngagement('bilibili', bili(9, 6, 501))).toContain('点赞')
    expect(checkEngagement('bilibili', bili(11, 5, 501))).toContain('转发')
    expect(checkEngagement('bilibili', bili(11, 6, 500))).toContain('浏览')
  })

  it('三项全不达标时，原因里三项都要写出来', () => {
    const reason = checkEngagement('bilibili', bili(1, 0, 2))
    expect(reason).toContain('点赞')
    expect(reason).toContain('转发')
    expect(reason).toContain('浏览')
  })

  it('边界是严格大于：等于阈值一律不通过', () => {
    // 用户原话是「点赞数大于 10」，`like === 10` 不在其中。
    // 写成 `>=` 是最容易顺手犯的错，所以三个边界各钉一条。
    expect(checkEngagement('bilibili', bili(10, 6, 501))).toContain('点赞')
    expect(checkEngagement('bilibili', bili(11, 5, 501))).toContain('转发')
    expect(checkEngagement('bilibili', bili(11, 6, 500))).toContain('浏览')

    // 各多 1 就该过 —— 和上面三条配对，证明失败的原因确实是「等于」而不是别的
    expect(checkEngagement('bilibili', bili(11, 6, 501))).toBeNull()
  })

  it('真实数据：热门榜最低的一条也全过（这道闸门对热门榜几乎不过滤）', () => {
    // 实测 popular 榜 50 条里最低的一条：view 40135 / like 8799 / share 191
    expect(checkEngagement('bilibili', bili(8799, 191, 40135))).toBeNull()
  })

  it('真正会被挡掉的是「播放几百、点赞个位数」的搜索结果', () => {
    expect(checkEngagement('bilibili-search', bili(3, 0, 420))).not.toBeNull()
  })
})

describe('checkEngagement：字段名按 kind 走，不是通用嗅探', () => {
  it('B站用 like/share/view，不是 like_count/shares/view_count', () => {
    // metricsOf 的 default 分支嗅探的是 like_count / shares / view_count，
    // 一个都对不上 B站。少写一个 case 的后果是闸门整个失效——
    // 它只在源提供了指标时才判负，一个都取不到就一律放行。
    expect(checkEngagement('bilibili', { like: 1, share: 0, view: 2 })).not.toBeNull()
    expect(checkEngagement('bilibili-search', { like: 1, share: 0, view: 2 })).not.toBeNull()
  })

  it('bilibili-search 没有 share 时只判点赞与浏览', () => {
    // 搜索结果接口不返回 share，适配器显式置 null。
    // 这时「转发」这一项**不存在**，不该被当成 0 而判负。
    const noShare = { like: 50, share: null, view: 900 }
    expect(checkEngagement('bilibili-search', noShare)).toBeNull()

    // 但拿得到的两项里有一项不达标，仍然要拒
    expect(checkEngagement('bilibili-search', { like: 50, share: null, view: 100 })).toContain(
      '浏览',
    )
  })
})

describe('readThresholds：逐源覆盖', () => {
  it('不配就用默认值', () => {
    expect(readThresholds({})).toEqual(DEFAULT_ENGAGEMENT_THRESHOLDS)
  })

  it('可以只覆盖其中一项，其余保持默认', () => {
    expect(readThresholds({ engagement: { likes: 100 } })).toEqual({
      likes: 100,
      reposts: DEFAULT_ENGAGEMENT_THRESHOLDS.reposts,
      views: DEFAULT_ENGAGEMENT_THRESHOLDS.views,
    })
  })

  it('配成 0 是「不限制」，不是「没配」', () => {
    // 0 和 undefined 必须区分开：前者是明确的意图，后者是懒得配
    expect(readThresholds({ engagement: { likes: 0, reposts: 0, views: 0 } })).toEqual({
      likes: 0,
      reposts: 0,
      views: 0,
    })
  })

  it('配坏了回落到默认值，不抛错', () => {
    // 阈值配错不该让整轮采集挂掉
    expect(readThresholds({ engagement: 'yes' })).toEqual(DEFAULT_ENGAGEMENT_THRESHOLDS)
    expect(readThresholds({ engagement: null })).toEqual(DEFAULT_ENGAGEMENT_THRESHOLDS)
    expect(readThresholds({ engagement: [1, 2, 3] })).toEqual(DEFAULT_ENGAGEMENT_THRESHOLDS)
    expect(readThresholds({ engagement: { likes: 'abc' } }).likes).toBe(
      DEFAULT_ENGAGEMENT_THRESHOLDS.likes,
    )
  })

  it('覆盖后的阈值真的作用到判定上', () => {
    const strict = readThresholds({ engagement: { likes: 100000 } })
    expect(checkEngagement('bilibili', { like: 8799, share: 191, view: 40135 }, strict)).toContain(
      '点赞',
    )
  })
})
