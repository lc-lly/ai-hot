import { describe, expect, it } from 'vitest'
import {
  PrefilterState,
  dedupeKeyOf,
  expandKeyword,
  prefilterItem,
} from '../../src/ai/prefilter.js'

const noCriteria = { keywords: [], exclude: [] }

const item = (over: Partial<{ url: string; title: string; summary: string | null }> = {}) => ({
  url: 'https://example.com/a',
  title: '一条足够长的标题内容',
  summary: null as string | null,
  ...over,
})

describe('L0 expandKeyword 中英同义词', () => {
  it('把中文关键词展开成同义词组', () => {
    const terms = expandKeyword('大模型')
    expect(terms).toContain('大模型')
    expect(terms).toContain('llm')
    expect(terms).toContain('large language model')
  })

  it('英文关键词也能反向命中中文同义词', () => {
    expect(expandKeyword('open source')).toContain('开源')
  })

  it('未收录的词退化为自身', () => {
    expect(expandKeyword('Cursor')).toEqual(['cursor'])
  })

  it('空关键词展开为空数组', () => {
    expect(expandKeyword('   ')).toEqual([])
  })
})

describe('L0 关键词命中', () => {
  it('中文关键词命中', () => {
    const res = prefilterItem(item({ title: '大模型又更新了，上下文窗口翻倍' }), {
      keywords: ['大模型'],
      exclude: [],
    })
    expect(res.decision.action).toBe('accept')
  })

  it('英文关键词命中文同义词（LLM → 大模型）', () => {
    const res = prefilterItem(item({ title: 'LLM inference got cheaper' }), {
      keywords: ['大模型'],
      exclude: [],
    })
    expect(res.decision.action).toBe('accept')
  })

  it('保持原关键词写法回传给调用方', () => {
    const res = prefilterItem(item({ title: 'LLM inference got cheaper' }), {
      keywords: ['大模型'],
      exclude: [],
    })
    if (res.decision.action !== 'accept') throw new Error('应当放行')
    expect(res.decision.matchedKeywords).toEqual(['大模型'])
  })

  it('ASCII 词有词边界：oscursor 不算命中 cursor', () => {
    const res = prefilterItem(item({ title: 'the oscursor project released' }), {
      keywords: ['cursor'],
      exclude: [],
    })
    expect(res.decision.action).toBe('reject')
  })

  it('ASCII 词以非字母数字分隔时算命中', () => {
    const res = prefilterItem(item({ title: 'Cursor-based editing is here' }), {
      keywords: ['cursor'],
      exclude: [],
    })
    expect(res.decision.action).toBe('accept')
  })

  it('未配置关键词时不筛掉任何条目（空配置 ≠ 全挡）', () => {
    const res = prefilterItem(item(), noCriteria)
    expect(res.decision.action).toBe('accept')
    if (res.decision.action !== 'accept') throw new Error('应当放行')
    expect(res.decision.keywordScore).toBe(0)
  })

  it('命中多个关键词时 keywordScore 是命中比例', () => {
    const res = prefilterItem(item({ title: '大模型与开源：本周进展综述' }), {
      keywords: ['大模型', '开源', '不存在的词'],
      exclude: [],
    })
    if (res.decision.action !== 'accept') throw new Error('应当放行')
    expect(res.decision.matchedKeywords).toEqual(['大模型', '开源'])
    expect(res.decision.keywordScore).toBeCloseTo(2 / 3, 5)
  })
})

describe('L0 排除词', () => {
  it('命中排除词直接拒绝', () => {
    const res = prefilterItem(item({ title: '大模型岗位招聘中' }), {
      keywords: ['大模型'],
      exclude: ['招聘'],
    })
    expect(res.decision.action).toBe('reject')
    if (res.decision.action !== 'reject') throw new Error('应当拒绝')
    expect(res.decision.reason).toBe('excluded')
    expect(res.decision.detail).toContain('招聘')
  })

  it('排除词优先于关键词命中', () => {
    const res = prefilterItem(item({ title: '大模型课程报名，限时优惠' }), {
      keywords: ['大模型'],
      exclude: ['优惠'],
    })
    expect(res.decision.action).toBe('reject')
  })
})

describe('L0 去重', () => {
  it('同一 contentHash 第二次出现被拒', () => {
    const seen = new Set<string>()
    const first = prefilterItem({ ...item(), contentHash: 'hash-1' }, noCriteria, { seen })
    expect(first.decision.action).toBe('accept')
    seen.add(first.dedupeKey)

    const second = prefilterItem(
      { url: 'https://other.com/b', title: '完全不同来源的同一篇', contentHash: 'hash-1' },
      noCriteria,
      { seen },
    )
    expect(second.decision.action).toBe('reject')
    if (second.decision.action !== 'reject') throw new Error('应当拒绝')
    expect(second.decision.reason).toBe('duplicate')
  })

  it('没有 contentHash 时退化成 URL 去重', () => {
    expect(dedupeKeyOf({ url: ' https://Example.com/A ', title: 't' })).toBe('u:https://example.com/a')
  })
})

describe('L0 无效内容', () => {
  it('标题为空 → too_short', () => {
    const res = prefilterItem({ url: 'https://e.com/a', title: '   ' }, noCriteria)
    expect(res.decision.action).toBe('reject')
    if (res.decision.action !== 'reject') throw new Error('应当拒绝')
    expect(res.decision.reason).toBe('too_short')
  })

  it('标题+摘要过短 → too_short', () => {
    const res = prefilterItem({ url: 'https://e.com/a', title: '短' }, noCriteria)
    expect(res.decision.action).toBe('reject')
  })
})

describe('L0 PrefilterState', () => {
  it('同一轮内自动去重，不需要调用方手动维护集合', () => {
    const state = new PrefilterState()
    const a = state.consider({ ...item({ title: '标题足够长的一条内容' }), contentHash: 'h1' }, noCriteria)
    const b = state.consider(
      { ...item({ url: 'https://x.com/y', title: '标题足够长的另一条' }), contentHash: 'h1' },
      noCriteria,
    )
    expect(a.action).toBe('accept')
    expect(b.action).toBe('reject')
    expect(state.size).toBe(1)
  })

  it('add() 可以把库里的既有哈希塞进去重集合', () => {
    const state = new PrefilterState()
    state.add('h:known')
    const res = state.consider(
      { ...item({ title: '标题足够长的一条内容' }), contentHash: 'known' },
      noCriteria,
    )
    expect(res.action).toBe('reject')
  })

  it('reset() 清空去重集合', () => {
    const state = new PrefilterState()
    state.add('h:known')
    state.reset()
    expect(state.size).toBe(0)
  })
})
