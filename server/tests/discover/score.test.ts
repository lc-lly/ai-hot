import { describe, expect, it } from 'vitest'
import {
  DISCOVER_THRESHOLD,
  DISCOVER_WEIGHTS,
  growthOf,
  heatOf,
  noveltyOf,
  scoreCluster,
} from '../../src/discover/score.js'
import {
  containsKeyword,
  DEFAULT_DISCOVER_DOMAIN,
  domainKeywords,
  domainText,
  matchesDomain,
} from '../../src/discover/profile.js'

describe('noveltyOf', () => {
  it('刚出现为 1，半衰期 24 小时后为 0.5', () => {
    expect(noveltyOf(0)).toBe(1)
    expect(noveltyOf(24)).toBeCloseTo(0.5, 6)
    expect(noveltyOf(48)).toBeCloseTo(0.25, 6)
  })

  it('未来时间按 0 小时处理（源站时钟错乱不产生 >1 的值）', () => {
    expect(noveltyOf(-100)).toBe(1)
  })

  it('无穷大退化为 0', () => {
    expect(noveltyOf(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('heatOf', () => {
  it('峰值热度满、3 个来源、5 条时封顶 1', () => {
    expect(heatOf({ maxHeat: 1, sourceCount: 3, itemCount: 5 })).toBe(1)
  })

  it('单条无来源时主要看峰值热度', () => {
    // 0.6*1 + 0.25*(1/3) + 0.15*(1/5)
    expect(heatOf({ maxHeat: 1, sourceCount: 1, itemCount: 1 })).toBeCloseTo(0.713, 3)
  })

  it('来源数确实抬分', () => {
    const one = heatOf({ maxHeat: 0.5, sourceCount: 1, itemCount: 1 })
    const three = heatOf({ maxHeat: 0.5, sourceCount: 3, itemCount: 1 })
    expect(three).toBeGreaterThan(one)
  })

  it('负数被钳住而不是算出负分', () => {
    expect(heatOf({ maxHeat: -1, sourceCount: -5, itemCount: -3 })).toBe(0)
  })
})

describe('growthOf', () => {
  it('窗口内新增 3 条且全是新增 → 1', () => {
    expect(growthOf({ recentItemCount: 3, itemCount: 3 })).toBe(1)
  })

  it('窗口内没有新增 → 0', () => {
    expect(growthOf({ recentItemCount: 0, itemCount: 50 })).toBe(0)
  })

  it('「50 条里新增 3 条」低于「3 条全是新的」（增量占比起作用）', () => {
    const diluted = growthOf({ recentItemCount: 3, itemCount: 50 })
    const fresh = growthOf({ recentItemCount: 3, itemCount: 3 })
    expect(diluted).toBeLessThan(fresh)
    // 0.6*1 + 0.4*(3/50)
    expect(diluted).toBeCloseTo(0.624, 3)
  })
})

describe('scoreCluster', () => {
  const now = new Date('2026-09-15T12:00:00Z')

  it('三个维度加权合成，权重和为 1', () => {
    const total = DISCOVER_WEIGHTS.novelty + DISCOVER_WEIGHTS.heat + DISCOVER_WEIGHTS.growth
    expect(total).toBeCloseTo(1, 10)
  })

  it('刚发生 + 多来源 + 正在发酵 → 过阈值的最高分', () => {
    const score = scoreCluster(
      {
        itemCount: 5,
        sourceCount: 3,
        maxHeat: 1,
        firstSeenAt: now,
        recentItemCount: 3,
      },
      now,
    )
    // 不是 1：growth 只有 0.84 = 0.6*(3/3) + 0.4*(3/5)。「5 条里新增 3 条」
    // 按设计就该被增量占比稀释（见 growthOf 的用例），要拿满分得 itemCount 也是 3。
    // 三个维度里 novelty 与 heat 已经封顶，0.96 = 0.4*1 + 0.35*1 + 0.25*0.84。
    expect(score.novelty).toBe(1)
    expect(score.heat).toBe(1)
    expect(score.score).toBeCloseTo(0.96, 3)
    expect(score.score).toBeGreaterThan(DISCOVER_THRESHOLD)
    expect(score.ageHours).toBe(0)
  })

  it('一周前、单来源、无新增 → 低分，不进发现页', () => {
    const score = scoreCluster(
      {
        itemCount: 1,
        sourceCount: 1,
        maxHeat: 0.3,
        firstSeenAt: new Date(now.getTime() - 7 * 24 * 3_600_000),
        recentItemCount: 0,
      },
      now,
    )
    expect(score.score).toBeLessThan(DISCOVER_THRESHOLD)
    expect(score.novelty).toBeLessThan(0.01)
  })

  it('ageHours 随 firstSeenAt 变化，分数单调下降', () => {
    const make = (hoursAgo: number) =>
      scoreCluster(
        {
          itemCount: 2,
          sourceCount: 2,
          maxHeat: 0.5,
          firstSeenAt: new Date(now.getTime() - hoursAgo * 3_600_000),
          recentItemCount: 2,
        },
        now,
      )

    expect(make(0).score).toBeGreaterThan(make(6).score)
    expect(make(6).score).toBeGreaterThan(make(48).score)
    expect(make(2).ageHours).toBe(2)
  })
})

describe('domainKeywords', () => {
  it('默认领域有画像', () => {
    const keywords = domainKeywords(DEFAULT_DISCOVER_DOMAIN)
    expect(keywords).toContain('ai')
    expect(keywords).toContain('大模型')
    expect(keywords.length).toBeGreaterThan(10)
  })

  it('空值回落到默认领域画像', () => {
    expect(domainKeywords('')).toEqual(domainKeywords(DEFAULT_DISCOVER_DOMAIN))
    expect(domainKeywords(null)).toEqual(domainKeywords(DEFAULT_DISCOVER_DOMAIN))
  })

  it('大小写与空格不敏感（AI编程 / ai 编程 / AI 编程 等价）', () => {
    expect(domainKeywords('AI编程')).toEqual(domainKeywords('ai 编程'))
  })

  it('未知领域名按分隔符拆词', () => {
    expect(domainKeywords('Agent, RAG；向量数据库')).toEqual(['agent', 'rag', '向量数据库'])
  })
})

describe('containsKeyword', () => {
  it('拉丁词必须落在词边界上', () => {
    expect(containsKeyword('we said hello', 'ai')).toBe(false)
    expect(containsKeyword('a chain of tools', 'ai')).toBe(false)
    expect(containsKeyword('encode this', 'code')).toBe(false)
    expect(containsKeyword('openai released', 'openai')).toBe(true)
  })

  it('拉丁词与数字相邻时算命中（gpt/6、ai编程）', () => {
    expect(containsKeyword('gpt 6 released', 'gpt')).toBe(true)
    expect(containsKeyword('ai编程助手', 'ai')).toBe(true)
  })

  it('中文关键词直接子串匹配', () => {
    expect(containsKeyword('大模型发布', '大模型')).toBe(true)
    expect(containsKeyword('大模型发布', '显卡')).toBe(false)
  })

  it('空关键词不命中', () => {
    expect(containsKeyword('anything', '')).toBe(false)
  })
})

describe('matchesDomain', () => {
  const keywords = domainKeywords(DEFAULT_DISCOVER_DOMAIN)

  it('AI 编程领域内的标题命中', () => {
    expect(matchesDomain('OpenAI ships GPT-6 to all users', keywords)).toBe(true)
    expect(matchesDomain('Cursor 发布新版本', keywords)).toBe(true)
    expect(matchesDomain('某公司发布新的开源模型', keywords)).toBe(true)
  })

  it('领域外的标题不命中', () => {
    expect(matchesDomain('Pizza restaurant opens downtown', keywords)).toBe(false)
    expect(matchesDomain('Local weather forecast for tomorrow', keywords)).toBe(false)
  })

  it('全角 / 大小写 / 空格差异不影响判断', () => {
    expect(matchesDomain('ＡＩ　编程助手', keywords)).toBe(true)
    expect(matchesDomain('A I   C O D I N G', keywords)).toBe(false) // 拆散的关键词不算
  })

  it('空文本不命中', () => {
    expect(matchesDomain('', keywords)).toBe(false)
  })
})

describe('domainText', () => {
  it('拼接标题与摘要，跳过空值', () => {
    // 分隔符本身不承载语义：唯一消费者 matchesDomain 除了原文还会扫一遍
    // 「去掉全部空白」的 compact 版本（为了让 `vibe coding` 这类带空格的
    // 关键词不被正文的断行漏掉），所以 `\n` 还是空格，判定结果一样。
    expect(domainText(['a', null, 'b'], [null, 'c'])).toBe('a \n b \n c')
  })

  it('全空输入得到空串而不是一串分隔符', () => {
    expect(domainText([null, ''], [undefined])).toBe('')
    expect(matchesDomain(domainText([null], []), ['ai'])).toBe(false)
  })
})
