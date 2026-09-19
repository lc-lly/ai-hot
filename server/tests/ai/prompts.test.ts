import { describe, expect, it } from 'vitest'
import type { ChatRequest, ChatResult, DeepSeekClient } from '../../src/ai/client.js'
import { extractJson } from '../../src/ai/client.js'
import {
  L2_SYSTEM_PROMPT,
  buildAuthenticityMessages,
  parseL2Response,
  runAuthenticity,
} from '../../src/ai/authenticity.js'
import {
  L1_BATCH_SIZE,
  L1_SYSTEM_PROMPT,
  buildRelevanceMessages,
  parseL1Response,
  runRelevance,
} from '../../src/ai/relevance.js'
import { mockAuthenticityPayload, mockRelevanceJson } from '../../src/ai/mock.js'
import { AI_FLAGS, normalizeFlags } from '../../src/ai/types.js'

// ------------------------------------------------------------ 测试替身

interface StubClient extends DeepSeekClient {
  calls: ChatRequest[]
}

function stubClient(respond?: (req: ChatRequest) => string): StubClient {
  const calls: ChatRequest[] = []
  return {
    calls,
    enabled: true,
    mock: true,
    models: () => ({ fast: 'f', smart: 's', available: [], source: 'config', note: null }),
    probe: async () => ({ fast: 'f', smart: 's', available: [], source: 'config', note: null }),
    async chat(req: ChatRequest): Promise<ChatResult> {
      calls.push(req)
      const content = respond ? respond(req) : (req.mock?.() ?? '{}')
      return {
        content,
        model: 'stub',
        promptTokens: 10,
        completionTokens: 20,
        cached: false,
        latencyMs: 1,
      }
    },
  }
}

// ------------------------------------------------------------ L2 提示词

describe('L2 提示词：产品核心的「识别假冒内容」', () => {
  it('system prompt 覆盖全部六个标签', () => {
    for (const flag of AI_FLAGS) {
      expect(L2_SYSTEM_PROMPT).toContain(flag)
    }
  })

  it('system prompt 明确要求逐项核对，并给出可操作的判据', () => {
    expect(L2_SYSTEM_PROMPT).toContain('标题党')
    expect(L2_SYSTEM_PROMPT).toContain('AI 生成的低质内容')
    expect(L2_SYSTEM_PROMPT).toContain('未证实传闻')
    expect(L2_SYSTEM_PROMPT).toContain('旧闻翻炒')
    expect(L2_SYSTEM_PROMPT).toContain('广告/软文')
    expect(L2_SYSTEM_PROMPT).toContain('无法核实')
  })

  it('system prompt 要求只依据文本、不替内容补事实', () => {
    expect(L2_SYSTEM_PROMPT).toContain('不要用你的世界知识去补全事实')
  })

  it('system prompt 要求输出 JSON 且禁止套话', () => {
    expect(L2_SYSTEM_PROMPT).toContain('"authenticity"')
    expect(L2_SYSTEM_PROMPT).toContain('"flags"')
    expect(L2_SYSTEM_PROMPT).toContain('"reasoning"')
    expect(L2_SYSTEM_PROMPT).toContain('禁止')
  })

  it('user message 带上标题/来源/作者/时间/链接/正文', () => {
    const messages = buildAuthenticityMessages({
      id: 'x1',
      title: '某模型发布了',
      summary: '正文内容',
      url: 'https://example.com/a',
      author: '张三',
      publishedAt: new Date('2026-09-15T00:00:00Z'),
      sourceName: '少数派',
    })
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    const body = messages[1]?.content ?? ''
    expect(body).toContain('某模型发布了')
    expect(body).toContain('张三')
    expect(body).toContain('少数派')
    expect(body).toContain('2026-09-15')
    expect(body).toContain('https://example.com/a')
    expect(body).toContain('正文内容')
  })

  it('没有正文时明确写「仅标题」，让模型知道信息不足', () => {
    const messages = buildAuthenticityMessages({ id: 'x', title: '只有标题' })
    expect(messages[1]?.content).toContain('仅标题')
  })

  it('超长正文被截断，控制 token', () => {
    const messages = buildAuthenticityMessages({
      id: 'x',
      title: 't',
      summary: 'a'.repeat(5000),
    })
    expect((messages[1]?.content ?? '').length).toBeLessThan(2000)
  })
})

describe('L2 回包解析', () => {
  it('正常 JSON', () => {
    const v = parseL2Response('{"authenticity":0.3,"flags":["clickbait"],"reasoning":"标题夸张"}')
    expect(v.authenticity).toBe(0.3)
    expect(v.flags).toEqual(['clickbait'])
    expect(v.reasoning).toBe('标题夸张')
  })

  it('容忍 markdown 围栏', () => {
    const v = parseL2Response('```json\n{"authenticity":0.9,"flags":[],"reasoning":"ok"}\n```')
    expect(v.authenticity).toBe(0.9)
  })

  it('丢弃不认识的标签', () => {
    const v = parseL2Response('{"authenticity":0.5,"flags":["clickbait","misleading","ad"],"reasoning":"x"}')
    expect(v.flags).toEqual(['clickbait', 'ad'])
  })

  it('分数越界被钳到 0..1', () => {
    expect(parseL2Response('{"authenticity":1.7,"flags":[],"reasoning":""}').authenticity).toBe(1)
    expect(parseL2Response('{"authenticity":-3,"flags":[],"reasoning":""}').authenticity).toBe(0)
  })

  it('缺字段时给出安全默认而不是抛错', () => {
    const v = parseL2Response('{}')
    expect(v.authenticity).toBe(0)
    expect(v.flags).toEqual([])
    expect(v.reasoning).toBe('')
  })

  it('完全不是 JSON 时抛错，交给调用方标 failed', () => {
    expect(() => parseL2Response('模型今天不想干活')).toThrow()
  })
})

describe('normalizeFlags', () => {
  it('接受 JSON 字符串（数据库里的形态）', () => {
    expect(normalizeFlags('["rumor","ad"]')).toEqual(['rumor', 'ad'])
  })

  it('坏 JSON 退化成空数组', () => {
    expect(normalizeFlags('{不是数组')).toEqual([])
  })

  it('去重', () => {
    expect(normalizeFlags(['ad', 'ad'])).toEqual(['ad'])
  })
})

// ------------------------------------------------------------ L1 提示词

describe('L1 提示词：关于 vs 提到', () => {
  it('system prompt 把「关于」与「提到」的区别放在最前面', () => {
    expect(L1_SYSTEM_PROMPT).toContain('最重要的判断')
    expect(L1_SYSTEM_PROMPT).toContain('关于')
    expect(L1_SYSTEM_PROMPT).toContain('提到')
    expect(L1_SYSTEM_PROMPT.indexOf('最重要的判断')).toBeLessThan(
      L1_SYSTEM_PROMPT.indexOf('relevance 打分'),
    )
  })

  it('列出必须判 false 的典型情况', () => {
    for (const marker of ['相关阅读', '汇总', '招聘', '歧义']) {
      expect(L1_SYSTEM_PROMPT).toContain(marker)
    }
  })

  it('要求原样回传 id，避免结果错位', () => {
    expect(L1_SYSTEM_PROMPT).toContain('"id"')
    expect(L1_SYSTEM_PROMPT).toContain('原样')
  })

  it('user message 带上关键词与全部条目', () => {
    const messages = buildRelevanceMessages('Cursor', [
      { id: 'a', title: 'Cursor 发布新版本', summary: '', url: 'https://e.com/a' },
      { id: 'b', title: '别的东西', summary: '提到了 cursor', url: 'https://e.com/b' },
    ])
    const body = messages[1]?.content ?? ''
    expect(body).toContain('Cursor')
    expect(body).toContain('"a"')
    expect(body).toContain('"b"')
    expect(body).toContain('共 2 条')
  })

  it('批次大小是 10（spec §4 的成本控制）', () => {
    expect(L1_BATCH_SIZE).toBe(10)
  })
})

describe('L1 回包解析', () => {
  it('按 id 建索引', () => {
    const map = parseL1Response(
      '{"results":[{"id":"a","is_about_topic":true,"relevance":0.9,"reason":"标题命中"},{"id":"b","is_about_topic":false,"relevance":0.2,"reason":"仅提及"}]}',
    )
    expect(map.get('a')?.isAboutTopic).toBe(true)
    expect(map.get('b')?.relevance).toBe(0.2)
  })

  it('缺少 is_about_topic 时按 0.5 阈值推断', () => {
    const map = parseL1Response('{"results":[{"id":"a","relevance":0.8,"reason":""}]}')
    expect(map.get('a')?.isAboutTopic).toBe(true)
  })

  it('忽略没有 id 的脏行', () => {
    const map = parseL1Response('{"results":[{"relevance":0.5},{"id":"ok","relevance":0.5}]}')
    expect(map.size).toBe(1)
  })
})

describe('extractJson', () => {
  it('裸 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('前后有解释性文字时抠出 JSON', () => {
    expect(extractJson('好的，结果如下：{"a":1} 完毕')).toEqual({ a: 1 })
  })
})

// ------------------------------------------------------------ 批量调用

describe('L1 批量：10 条一批', () => {
  const makeItems = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `i${i}`,
      title: `条目 ${i}`,
      summary: null,
      url: `https://e.com/${i}`,
    }))

  it('23 条 → 3 次调用', async () => {
    const client = stubClient()
    const res = await runRelevance({ client }, 'Cursor', makeItems(23))
    expect(res.calls).toBe(3)
    expect(client.calls).toHaveLength(3)
    expect(client.calls.map((c) => c.messages[1]?.content.match(/共 (\d+) 条/)?.[1])).toEqual([
      '10',
      '10',
      '3',
    ])
  })

  it('每条都被判到（mock 回包与输入条数一致）', async () => {
    const client = stubClient()
    const res = await runRelevance({ client }, 'Cursor', makeItems(23))
    expect(res.verdicts.size).toBe(23)
    // 标题里都没有 Cursor，按 mock 规则一律 0.3
    expect([...res.verdicts.values()].every((v) => v.relevance === 0.3)).toBe(true)
  })

  it('L1 走 fast 模型且不受预算限制（降级后仍保留的那层）', async () => {
    const client = stubClient()
    await runRelevance({ client }, 'Cursor', makeItems(1))
    expect(client.calls[0]?.model).toBe('fast')
    expect(client.calls[0]?.budgetExempt).toBe(true)
    expect(client.calls[0]?.purpose).toBe('l1_relevance')
  })

  it('单批失败不带走其它批', async () => {
    let n = 0
    const client = stubClient(() => {
      n += 1
      if (n === 1) throw new Error('模拟网络失败')
      return mockRelevanceJson(
        [{ id: 'i10', title: 'Cursor 更新', summary: null }],
        'Cursor',
      )
    })
    const res = await runRelevance({ client }, 'Cursor', makeItems(11))
    expect(res.calls).toBe(1) // 只有成功的那批计入
    expect(res.verdicts.size).toBe(1)
    expect(res.missing).toContain('i0')
  })

  it('零条时不调用', async () => {
    const client = stubClient()
    const res = await runRelevance({ client }, 'Cursor', [])
    expect(res.calls).toBe(0)
    expect(client.calls).toHaveLength(0)
  })
})

describe('L2 调用', () => {
  it('走 smart 模型、要求 JSON、可以进预算降级', async () => {
    const client = stubClient()
    await runAuthenticity({ client }, { id: 'x', title: '一条内容' })
    expect(client.calls[0]?.model).toBe('smart')
    expect(client.calls[0]?.json).toBe(true)
    expect(client.calls[0]?.budgetExempt).toBeUndefined()
    expect(client.calls[0]?.purpose).toBe('l2_authenticity')
  })

  it('mock 回包按特征词给出标签', async () => {
    const client = stubClient()
    const verdict = await runAuthenticity(
      { client },
      { id: 'x', title: '震惊！这家公司杀疯了', summary: '限时优惠，加微信领取' },
    )
    expect(verdict.flags).toContain('clickbait')
    expect(verdict.flags).toContain('ad')
    expect(verdict.authenticity).toBeLessThan(0.7)
    expect(verdict.reasoning).toContain('mock')
  })

  it('干净内容拿满分且无标签', async () => {
    const verdict = mockAuthenticityPayload({
      title: 'DeepSeek 发布新版模型，上下文扩到 128k',
      summary: '官方博客给出了 benchmark 数据与发布日期。',
    })
    expect(verdict.flags).toEqual([])
    expect(verdict.authenticity).toBe(1)
  })

  it('mock 完全确定：同样输入两次结果一致', () => {
    const input = { id: 'x', title: '据传某模型下周发布', summary: null }
    expect(JSON.stringify(mockAuthenticityPayload(input))).toBe(
      JSON.stringify(mockAuthenticityPayload(input)),
    )
  })
})
