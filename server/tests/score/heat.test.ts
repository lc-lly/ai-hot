import { describe, expect, it } from 'vitest'
import { clamp01, digitsFrom, heat, parseRawObject, rawHeat, HEAT_FALLBACK } from '../../src/score/heat.js'

describe('heat —— 契约 §3.3 冻结口径', () => {
  it('hackernews: raw.score / 500', () => {
    expect(heat('hackernews', { score: 250 })).toBe(0.5)
    expect(heat('hackernews', { score: 500 })).toBe(1)
  })

  it('hackernews: 缺 score 时退回 descendants', () => {
    expect(heat('hackernews', { descendants: 100 })).toBe(0.2)
  })

  it('reddit: raw.score / 1000', () => {
    expect(heat('reddit', { score: 250 })).toBe(0.25)
    expect(heat('reddit', { score: 5000 })).toBe(1)
  })

  it('github-trending: starsToday 里的数字 / 500', () => {
    // github-trending adapter 存的是页面上 span 的原文
    expect(heat('github-trending', { starsToday: '1,234 stars today' })).toBe(1)
    expect(heat('github-trending', { starsToday: '250 stars today' })).toBe(0.5)
    expect(heat('github-trending', { starsToday: '1.2k stars today' })).toBe(1)
    expect(heat('github-trending', { starsToday: 100 })).toBe(0.2)
  })

  it('clamp 到 0..1', () => {
    expect(heat('hackernews', { score: 99999 })).toBe(1)
    expect(heat('reddit', { score: -20 })).toBe(0)
  })

  it('明确为 0 是「取到了值」，不是 fallback', () => {
    expect(heat('hackernews', { score: 0 })).toBe(0)
    expect(heat('reddit', { score: 0 })).toBe(0)
  })

  it('不认识的 kind 给固定 0.3', () => {
    expect(heat('rss', { score: 500 })).toBe(HEAT_FALLBACK)
    expect(heat('cn-hotboard', { score: 500 })).toBe(HEAT_FALLBACK)
    expect(heat(null, { score: 500 })).toBe(HEAT_FALLBACK)
    expect(heat(undefined, null)).toBe(HEAT_FALLBACK)
  })

  it('认识的 kind 但取不到值也给 0.3（0 在雷达盘上是圆心，会误导）', () => {
    expect(heat('hackernews', null)).toBe(HEAT_FALLBACK)
    expect(heat('hackernews', '')).toBe(HEAT_FALLBACK)
    expect(heat('hackernews', {})).toBe(HEAT_FALLBACK)
    expect(heat('reddit', { score: 'abc' })).toBe(HEAT_FALLBACK)
    expect(heat('github-trending', { starsToday: 'no digits here' })).toBe(HEAT_FALLBACK)
    expect(heat('github-trending', {})).toBe(HEAT_FALLBACK)
  })

  it('raw 可以直接是 DB 里的 JSON 字符串', () => {
    expect(heat('hackernews', '{"score":250}')).toBe(0.5)
    expect(heat('reddit', '{"score":100}')).toBe(0.1)
    expect(heat('hackernews', 'not json')).toBe(HEAT_FALLBACK)
    expect(heat('hackernews', '"just a string"')).toBe(HEAT_FALLBACK)
    expect(heat('hackernews', '[1,2,3]')).toBe(HEAT_FALLBACK)
  })
})

/**
 * `github-search` 的基准必须对着**真实**的 star 分布定，不能拍脑袋。
 *
 * 适配器固定 `sort=stars&order=desc`（见 `sources/github-search.ts`），
 * 所以它取到的永远是幂律分布的顶端那一截。实测六个查询共 180 条结果：
 *
 * | 分位 | star |
 * |---|---|
 * | p10 | 28,981 |
 * | 中位 | 66,522 |
 * | p90 | 166,197 |
 * | 最高 | 455,512 |
 *
 * **94% 超过 20,000。** 基准定在 20,000 的时候，整个搜索结果页的卡片
 * 全是 `heat = 1.0`：徽章行每一张都挂「紧急」（等于没有这个徽章），
 * 而排序因为在热度上完全打平，退化成了 `url.localeCompare` 的**字母序**
 * ——`abiosoft → alibaba → aquasecurity → authelia → bregman-arie`。
 * 这正是基准偏小时最典型的两个症状，而且都不报错。
 */
describe('github-search 的基准要跟真实 star 分布对齐', () => {
  const P10 = 28_981
  const MEDIAN = 66_522
  const P90 = 166_197
  const MAX = 455_512

  it('中位数量级的仓库不该被判成「紧急」', () => {
    // 搜索结果的绝大多数都在这个量级。它们全是 urgent 的话，
    // 卡片的首要视觉徽章就不再传达任何信息
    expect(heat('github-search', { stars: MEDIAN })).toBeLessThan(0.7)
  })

  it('真实分布要散得开，排序才不至于退化成字母序', () => {
    const heats = [P10, MEDIAN, P90, MAX].map((s) => heat('github-search', { stars: s }))
    expect(new Set(heats).size).toBe(heats.length)
    expect(Math.max(...heats) - Math.min(...heats)).toBeGreaterThan(0.3)
  })
})

describe('rawHeat / digitsFrom / parseRawObject', () => {
  it('rawHeat 取不到返回 null（区别于显式的 0）', () => {
    expect(rawHeat('hackernews', {})).toBeNull()
    expect(rawHeat('hackernews', { score: 0 })).toBe(0)
    expect(rawHeat('rss', { score: 100 })).toBeNull()
  })

  it('digitsFrom 处理千分位 / k 后缀 / 纯数字', () => {
    expect(digitsFrom('1,234 stars today')).toBe(1234)
    expect(digitsFrom('1.2k')).toBe(1200)
    expect(digitsFrom(42)).toBe(42)
    expect(digitsFrom('42')).toBe(42)
    expect(digitsFrom('')).toBeNull()
    expect(digitsFrom('stars')).toBeNull()
    expect(digitsFrom(null)).toBeNull()
  })

  it('parseRawObject 只接受对象', () => {
    expect(parseRawObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseRawObject({ a: 1 })).toEqual({ a: 1 })
    expect(parseRawObject('[]')).toBeNull()
    expect(parseRawObject('3')).toBeNull()
    expect(parseRawObject(undefined)).toBeNull()
  })

  it('clamp01', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.4)).toBe(0.4)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0)
  })
})
