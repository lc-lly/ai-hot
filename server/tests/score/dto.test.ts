import { describe, expect, it } from 'vitest'
import { parseFlags, toAiState, toItemDTO, type ItemRowInput } from '../../src/score/dto.js'
import { HEAT_FALLBACK } from '../../src/score/heat.js'

const row = (over: Partial<ItemRowInput> = {}): ItemRowInput => ({
  id: 'item-1',
  title: 'Show HN: my GPT thing',
  url: 'https://example.com/a',
  summary: 'a summary',
  author: 'alice',
  lang: 'en',
  publishedAt: new Date('2026-09-14T10:00:00.000Z'),
  fetchedAt: new Date('2026-09-15T10:00:00.000Z'),
  aiState: 'done',
  authenticity: 0.82,
  aiFlags: '["clickbait"]',
  aiReasoning: '标题党',
  raw: '{"score":250}',
  source: { name: 'hn', kind: 'hackernews' },
  ...over,
})

describe('toItemDTO', () => {
  it('完整行的每个字段都对得上契约 §3.1', () => {
    const dto = toItemDTO(row())
    expect(dto).toEqual({
      id: 'item-1',
      title: 'Show HN: my GPT thing',
      url: 'https://example.com/a',
      summary: 'a summary',
      author: 'alice',
      lang: 'en',
      publishedAt: '2026-09-14T10:00:00.000Z',
      fetchedAt: '2026-09-15T10:00:00.000Z',
      aiState: 'done',
      source: { name: 'hn', kind: 'hackernews' },
      heat: 0.5,
      domain: '大模型',
      authenticity: 0.82,
      flags: ['clickbait'],
      reasoning: '标题党',
      // heat 0.5 → high，再被 clickbait 打 0.6 → 0.3 → medium（BANDS: >=0.3）
      importance: 'medium',
      // 按来源提取原始互动计数。**缺失的指标不出现**，不是 0
      metrics: { points: 250 },
      clusterId: null,
      // 没有 include matches 时是 null = 未评估，不是「相关度为 0」
      match: null,
    })
  })

  it('阶段 2 还没跑时：authenticity/flags/reasoning 为 null / [] / null', () => {
    const dto = toItemDTO(
      row({
        aiState: 'pending',
        authenticity: null,
        aiFlags: '[]',
        aiReasoning: null,
        raw: null,
        source: { name: 'rss', kind: 'rss' },
      }),
    )
    expect(dto.authenticity).toBeNull()
    expect(dto.flags).toEqual([])
    expect(dto.reasoning).toBeNull()
    // 不认识的 kind → heat fallback，不是 0
    expect(dto.heat).toBe(HEAT_FALLBACK)
  })

  it('容错 null 字段与缺失的 source', () => {
    const dto = toItemDTO(
      row({ summary: null, author: null, lang: null, publishedAt: null, source: null, raw: null }),
    )
    expect(dto.summary).toBeNull()
    expect(dto.author).toBeNull()
    expect(dto.lang).toBeNull()
    expect(dto.publishedAt).toBeNull()
    expect(dto.source).toBeNull()
    expect(dto.heat).toBe(HEAT_FALLBACK)
  })

  it('日期可以直接是 ISO 字符串', () => {
    const dto = toItemDTO(
      row({ publishedAt: '2026-09-14T10:00:00.000Z', fetchedAt: '2026-09-15T10:00:00.000Z' }),
    )
    expect(dto.publishedAt).toBe('2026-09-14T10:00:00.000Z')
    expect(dto.fetchedAt).toBe('2026-09-15T10:00:00.000Z')
  })

  it('domain 用 title + summary 现算', () => {
    expect(toItemDTO(row({ title: '随便', summary: '关于 GPU 的' })).domain).toBe('硬件')
    expect(toItemDTO(row({ title: '随便', summary: null })).domain).toBe('其他')
  })
})

describe('parseFlags', () => {
  it('吃下 DB 默认值、正常数组、已解析的数组、脏数据', () => {
    expect(parseFlags('[]')).toEqual([])
    expect(parseFlags('["clickbait","ai_generated"]')).toEqual(['clickbait', 'ai_generated'])
    expect(parseFlags(['rumor'])).toEqual(['rumor'])
    expect(parseFlags(null)).toEqual([])
    expect(parseFlags(undefined)).toEqual([])
    expect(parseFlags('')).toEqual([])
    expect(parseFlags('{oops')).toEqual([])
    expect(parseFlags('{"a":1}')).toEqual([])
    expect(parseFlags('[1,"ok",null]')).toEqual(['ok'])
    expect(parseFlags(42)).toEqual([])
  })
})

describe('toAiState', () => {
  it('只认四态，其余一律 pending', () => {
    expect(toAiState('done')).toBe('done')
    expect(toAiState('skipped')).toBe('skipped')
    expect(toAiState('failed')).toBe('failed')
    expect(toAiState('pending')).toBe('pending')
    expect(toAiState('weird')).toBe('pending')
    expect(toAiState(null)).toBe('pending')
  })
})
