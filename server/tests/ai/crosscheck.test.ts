import { describe, expect, it } from 'vitest'
import {
  RECENCY_WINDOW_HOURS,
  ageHoursOf,
  classifyTier,
  computeConfidence,
  flagPenaltyOf,
  recencyFactorOf,
  sourceFactorOf,
  weightFactorOf,
} from '../../src/ai/crosscheck.js'

describe('L3 分流阈值（契约 §3.5 冻结）', () => {
  it('0.8 及以上 → push', () => {
    expect(classifyTier(0.8)).toBe('push')
    expect(classifyTier(0.95)).toBe('push')
    expect(classifyTier(1)).toBe('push')
  })

  it('0.5 到 0.8 → pending', () => {
    expect(classifyTier(0.5)).toBe('pending')
    expect(classifyTier(0.799)).toBe('pending')
  })

  it('小于 0.5 → filtered（入库但不推送，spec §4.2 低置信不删除）', () => {
    expect(classifyTier(0.499)).toBe('filtered')
    expect(classifyTier(0)).toBe('filtered')
  })
})

describe('L3 三因子', () => {
  it('来源数：1 个 0.5，3 个及以上满分', () => {
    expect(sourceFactorOf(1)).toBe(0.5)
    expect(sourceFactorOf(3)).toBe(1)
    expect(sourceFactorOf(9)).toBe(1)
  })

  it('来源数异常输入不炸', () => {
    expect(sourceFactorOf(0)).toBe(0.5)
    expect(sourceFactorOf(-3)).toBe(0.5)
    expect(sourceFactorOf(Number.NaN)).toBe(0.5)
  })

  it('来源权重 1.5 及以上满分', () => {
    expect(weightFactorOf(0)).toBe(0)
    expect(weightFactorOf(1)).toBeCloseTo(0.667, 2)
    expect(weightFactorOf(1.5)).toBe(1)
    expect(weightFactorOf(99)).toBe(1)
    expect(weightFactorOf(Number.NaN)).toBe(0)
  })

  it('新鲜度 72 小时窗口线性衰减', () => {
    expect(recencyFactorOf(0)).toBe(1)
    expect(recencyFactorOf(RECENCY_WINDOW_HOURS)).toBe(0)
    expect(recencyFactorOf(36)).toBeCloseTo(0.5, 5)
    expect(recencyFactorOf(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('标签折扣只算四个惩罚标签', () => {
    expect(flagPenaltyOf([])).toBe(1)
    expect(flagPenaltyOf(['clickbait'])).toBeCloseTo(0.85, 5)
    expect(flagPenaltyOf(['clickbait', 'rumor'])).toBeCloseTo(0.7, 5)
    // stale / unverified 的影响已经体现在 L2 的低分里，不重复罚
    expect(flagPenaltyOf(['stale', 'unverified'])).toBe(1)
  })
})

describe('L3 ageHoursOf', () => {
  const now = new Date('2026-09-15T12:00:00Z')

  it('优先用发布时间', () => {
    const hours = ageHoursOf({ publishedAt: new Date('2026-09-15T06:00:00Z'), now })
    expect(hours).toBeCloseTo(6, 5)
  })

  it('没有发布时间退到抓取时间', () => {
    const hours = ageHoursOf({ fetchedAt: new Date('2026-09-14T12:00:00Z'), now })
    expect(hours).toBeCloseTo(24, 5)
  })

  it('两个时间都没有 → 无穷大（新鲜度归零）', () => {
    expect(ageHoursOf({ now })).toBe(Number.POSITIVE_INFINITY)
  })

  it('发布时间在未来按 0 处理，不产生负分', () => {
    const hours = ageHoursOf({ publishedAt: new Date('2026-09-16T12:00:00Z'), now })
    expect(hours).toBe(0)
  })
})

describe('L3 综合置信度', () => {
  it('多来源 + 高可信权重 + 新鲜 + 无标签 → push', () => {
    const res = computeConfidence({
      relevance: 1,
      authenticity: 1,
      sourceCount: 3,
      sourceWeight: 1.5,
      ageHours: 0,
      flags: [],
    })
    expect(res.confidence).toBe(1)
    expect(res.tier).toBe('push')
    expect(res.crossScore).toBe(1)
  })

  it('单来源 + 旧 + 标题党软文 → filtered', () => {
    const res = computeConfidence({
      relevance: 0.4,
      authenticity: 0.3,
      sourceCount: 1,
      sourceWeight: 0.8,
      ageHours: 100,
      flags: ['clickbait', 'ad'],
    })
    expect(res.confidence).toBeLessThan(0.5)
    expect(res.tier).toBe('filtered')
  })

  it('单来源但内容过硬且新鲜 → 仍可进 push', () => {
    const res = computeConfidence({
      relevance: 1,
      authenticity: 1,
      sourceCount: 1,
      sourceWeight: 1,
      ageHours: 0,
      flags: [],
    })
    expect(res.confidence).toBeGreaterThanOrEqual(0.8)
    expect(res.tier).toBe('push')
  })

  it('相同条件下来源越多置信度越高', () => {
    const base = {
      relevance: 0.8,
      authenticity: 0.8,
      sourceWeight: 1,
      ageHours: 12,
      flags: [] as const,
    }
    const one = computeConfidence({ ...base, sourceCount: 1 }).confidence
    const three = computeConfidence({ ...base, sourceCount: 3 }).confidence
    expect(three).toBeGreaterThan(one)
  })

  it('标签只降不升', () => {
    const base = {
      relevance: 0.9,
      authenticity: 0.9,
      sourceCount: 2,
      sourceWeight: 1.2,
      ageHours: 3,
    }
    const clean = computeConfidence({ ...base, flags: [] }).confidence
    const flagged = computeConfidence({ ...base, flags: ['rumor'] }).confidence
    expect(flagged).toBeLessThan(clean)
  })

  it('置信度永远落在 0..1，且最多三位小数', () => {
    for (const relevance of [-5, 0, 0.5, 1, 7, Number.NaN]) {
      const res = computeConfidence({
        relevance,
        authenticity: 2,
        sourceCount: 99,
        sourceWeight: 9,
        ageHours: -10,
        flags: ['clickbait'],
      })
      expect(res.confidence).toBeGreaterThanOrEqual(0)
      expect(res.confidence).toBeLessThanOrEqual(1)
      expect(res.confidence).toBe(Math.round(res.confidence * 1000) / 1000)
    }
  })
})
