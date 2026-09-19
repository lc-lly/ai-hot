import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  AiUnavailableError,
  createDeepSeekClient,
  parseModelList,
  pickFallbackModel,
} from '../../src/ai/client.js'
import { createBudgetTracker } from '../../src/ai/budget.js'
import { createPrisma } from '../../src/db.js'
import { loadEnv, type Env } from '../../src/env.js'
import { silentAiLogger } from '../../src/ai/types.js'

let prisma: PrismaClient

beforeAll(async () => {
  prisma = createPrisma('file:./test.db')
})

afterAll(() => prisma.$disconnect())

beforeEach(async () => {
  await prisma.aiCall.deleteMany({})
  await prisma.aiCache.deleteMany({})
})

/** 每个测试都给一份独立的 env，避免相互污染 */
function testEnv(over: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'file:./test.db',
    AI_MOCK: '0',
    DEEPSEEK_API_KEY: 'sk-test-key',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_MODEL_FAST: 'deepseek-flash',
    DEEPSEEK_MODEL_SMART: 'deepseek-v4-pro',
    AI_DAILY_TOKEN_BUDGET: '200000',
    ...over,
  })
}

interface FetchLog {
  count: number
  urls: string[]
  methods: string[]
}

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; log: FetchLog } {
  const log: FetchLog = { count: 0, urls: [], methods: [] }
  const impl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    log.count += 1
    const url = String(input)
    log.urls.push(url)
    log.methods.push(init?.method ?? 'GET')
    return handler(url, init)
  }
  return { fetch: impl as typeof globalThis.fetch, log }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function client(
  env: Env,
  fetchImpl: typeof globalThis.fetch,
  budgetOver: { limit?: number } = {},
) {
  const budget = createBudgetTracker(prisma, {
    limit: budgetOver.limit ?? env.AI_DAILY_TOKEN_BUDGET,
    // 测试里每次都重新读库，别让 30s 的内存缓存掩盖刚写入的行
    memoMs: -1,
  })
  const c = createDeepSeekClient({
    env,
    prisma,
    budget,
    fetch: fetchImpl,
    logger: silentAiLogger,
  })
  return { c, budget }
}

// ------------------------------------------------------------ 纯函数

describe('parseModelList', () => {
  it('OpenAI 风格 {data:[{id}]}', () => {
    expect(parseModelList({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] })).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
  })

  it('兼容 {models:[...]}', () => {
    expect(parseModelList({ models: ['a', { name: 'b' }] })).toEqual(['a', 'b'])
  })

  it('脏载荷退化成空数组而不是抛错', () => {
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList({})).toEqual([])
    expect(parseModelList({ data: 'nope' })).toEqual([])
  })

  it('去重', () => {
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'a' }] })).toEqual(['a'])
  })
})

describe('pickFallbackModel', () => {
  it('fast 优先选 flash/chat 一类，避开 pro/reasoner', () => {
    expect(
      pickFallbackModel(['deepseek-v4-pro', 'deepseek-chat', 'deepseek-embed'], 'fast'),
    ).toBe('deepseek-chat')
  })

  it('smart 优先选 pro/reasoner 一类', () => {
    expect(pickFallbackModel(['deepseek-chat', 'deepseek-v4-pro'], 'smart')).toBe('deepseek-v4-pro')
  })

  it('列表为空返回 null', () => {
    expect(pickFallbackModel([], 'fast')).toBeNull()
  })
})

// ------------------------------------------------------------ 模型探测

describe('启动探测 /models（spec §4.3）', () => {
  it('配置的模型都在列表里 → source=probe', async () => {
    const { fetch: f } = fakeFetch(() =>
      jsonResponse({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }),
    )
    const { c } = client(testEnv(), f)
    const res = await c.probe()
    expect(res.source).toBe('probe')
    expect(res.fast).toBe('deepseek-flash')
    expect(res.smart).toBe('deepseek-v4-pro')
    expect(res.note).toBeNull()
  })

  it('配置的名字不在列表里 → 回退到可用模型，不失败', async () => {
    const { fetch: f } = fakeFetch(() =>
      jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-v4-pro' }] }),
    )
    const { c } = client(testEnv(), f)
    const res = await c.probe()
    expect(res.source).toBe('fallback')
    expect(res.fast).toBe('deepseek-chat')
    expect(res.smart).toBe('deepseek-v4-pro')
    expect(res.note).toContain('回退')
  })

  it('探测失败是非致命的：沿用 env 配置', async () => {
    const { fetch: f } = fakeFetch(() => {
      throw new Error('DNS 挂了')
    })
    const { c } = client(testEnv(), f)
    const res = await c.probe()
    expect(res.source).toBe('config')
    expect(res.fast).toBe('deepseek-flash')
    expect(res.smart).toBe('deepseek-v4-pro')
    expect(res.note).toContain('probe failed')
    expect(res.available).toEqual([])
  })

  it('非 2xx 也算探测失败，不抛', async () => {
    const { fetch: f } = fakeFetch(() => jsonResponse({ error: 'unauthorized' }, 401))
    const { c } = client(testEnv(), f)
    const res = await c.probe()
    expect(res.source).toBe('config')
    expect(res.note).toContain('HTTP 401')
  })

  it('探测结果被记住，不会每次调用都打一次 /models', async () => {
    const { fetch: f, log } = fakeFetch(() => jsonResponse({ data: [{ id: 'deepseek-flash' }] }))
    const { c } = client(testEnv(), f)
    await c.probe()
    await c.probe()
    await c.probe()
    expect(log.urls.filter((u) => u.endsWith('/models'))).toHaveLength(1)
  })

  it('没有 key 时不发任何请求，只警告', async () => {
    const { fetch: f, log } = fakeFetch(() => jsonResponse({}))
    const { c } = client(testEnv({ DEEPSEEK_API_KEY: '' }), f)
    const res = await c.probe()
    expect(log.count).toBe(0)
    expect(res.note).toBe('NO_API_KEY')
    expect(c.enabled).toBe(false)
  })
})

// ------------------------------------------------------------ chat

describe('chat —— 没有 key 时降级而不是崩', () => {
  it('抛 AiUnavailableError(NO_API_KEY)，且完全不联网', async () => {
    const { fetch: f, log } = fakeFetch(() => jsonResponse({}))
    const { c } = client(testEnv({ DEEPSEEK_API_KEY: '' }), f)
    await expect(
      c.chat({
        purpose: 'l2_authenticity',
        model: 'smart',
        messages: [{ role: 'user', content: '你好' }],
      }),
    ).rejects.toBeInstanceOf(AiUnavailableError)
    expect(log.count).toBe(0)
  })

  it('错误码是 NO_API_KEY，路由据此回 503', async () => {
    const { fetch: f } = fakeFetch(() => jsonResponse({}))
    const { c } = client(testEnv({ DEEPSEEK_API_KEY: '' }), f)
    try {
      await c.chat({ purpose: 'x', model: 'fast', messages: [{ role: 'user', content: 'hi' }] })
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(AiUnavailableError)
      expect((e as AiUnavailableError).code).toBe('NO_API_KEY')
    }
  })
})

describe('chat —— OpenAI 兼容协议', () => {
  it('打 POST {BASE}/chat/completions 并带 Bearer 头', async () => {
    const { fetch: f, log } = fakeFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'deepseek-v4-pro' }] })
      return jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      })
    })
    const { c } = client(testEnv(), f)
    const res = await c.chat({
      purpose: 'l2_authenticity',
      model: 'smart',
      messages: [{ role: 'user', content: '判定这条内容' }],
      json: true,
    })
    expect(res.content).toBe('{"ok":true}')
    expect(res.promptTokens).toBe(11)
    expect(res.completionTokens).toBe(22)
    expect(log.urls).toContain('https://api.deepseek.com/chat/completions')
    expect(log.methods.at(-1)).toBe('POST')
  })

  it('模型名取自 env，不硬编码', async () => {
    const { fetch: f } = fakeFetch((url, init) => {
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'my-fast' }, { id: 'my-smart' }] })
      const body = JSON.parse(String(init?.body)) as { model: string }
      expect(body.model).toBe('my-smart')
      return jsonResponse({ choices: [{ message: { content: '{}' } }], usage: {} })
    })
    const { c } = client(
      testEnv({ DEEPSEEK_MODEL_FAST: 'my-fast', DEEPSEEK_MODEL_SMART: 'my-smart' }),
      f,
    )
    await c.chat({ purpose: 'x', model: 'smart', messages: [{ role: 'user', content: 'q1' }] })
  })

  it('HTTP 错误被包装，并记入 AiCall(ok=false)', async () => {
    const { fetch: f } = fakeFetch((url) =>
      url.endsWith('/models') ? jsonResponse({ data: [] }) : jsonResponse({ error: 'boom' }, 500),
    )
    const { c } = client(testEnv(), f)
    await expect(
      c.chat({ purpose: 'l2_authenticity', model: 'smart', messages: [{ role: 'user', content: 'q2' }] }),
    ).rejects.toThrow(/DeepSeek 返回错误/)
    const rows = await prisma.aiCall.findMany({ where: { ok: false } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.purpose).toBe('l2_authenticity')
  })

  it('响应缺 content 时报错而不是静默返回空串', async () => {
    const { fetch: f } = fakeFetch((url) =>
      url.endsWith('/models') ? jsonResponse({ data: [] }) : jsonResponse({ choices: [] }),
    )
    const { c } = client(testEnv(), f)
    await expect(
      c.chat({ purpose: 'x', model: 'fast', messages: [{ role: 'user', content: 'q3' }] }),
    ).rejects.toThrow(/响应格式异常/)
  })
})

describe('chat —— 缓存（spec §4.4，TTL 7 天）', () => {
  it('同 prompt 第二次命中缓存，不再联网', async () => {
    let chatCalls = 0
    const { fetch: f } = fakeFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ data: [] })
      chatCalls += 1
      return jsonResponse({
        choices: [{ message: { content: '{"n":1}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 6 },
      })
    })
    const { c } = client(testEnv(), f)
    const req = {
      purpose: 'l2_authenticity' as const,
      model: 'smart' as const,
      messages: [{ role: 'user' as const, content: '缓存测试唯一内容 A' }],
    }
    const first = await c.chat(req)
    const second = await c.chat(req)

    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.content).toBe('{"n":1}')
    expect(chatCalls).toBe(1)

    const rows = await prisma.aiCall.findMany({ orderBy: { createdAt: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.cached).toBe(false)
    expect(rows[1]?.cached).toBe(true)
    expect(rows[1]?.promptTokens).toBe(0)

    const cached = await prisma.aiCache.findMany()
    expect(cached).toHaveLength(1)
    // TTL 7 天
    const ttlDays = (cached[0]!.expiresAt.getTime() - cached[0]!.createdAt.getTime()) / 86_400_000
    expect(ttlDays).toBeCloseTo(7, 3)
  })

  it('不同 prompt 不共享缓存', async () => {
    let chatCalls = 0
    const { fetch: f } = fakeFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ data: [] })
      chatCalls += 1
      return jsonResponse({ choices: [{ message: { content: '{}' } }], usage: {} })
    })
    const { c } = client(testEnv(), f)
    await c.chat({ purpose: 'x', model: 'smart', messages: [{ role: 'user', content: '缓存 B' }] })
    await c.chat({ purpose: 'x', model: 'smart', messages: [{ role: 'user', content: '缓存 C' }] })
    expect(chatCalls).toBe(2)
  })

  it('没有 key 时缓存仍然可用（旧结果不花钱）', async () => {
    const { fetch: f } = fakeFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ data: [] })
      return jsonResponse({ choices: [{ message: { content: '{"warm":1}' } }], usage: {} })
    })
    const req = {
      purpose: 'l2_authenticity' as const,
      model: 'smart' as const,
      messages: [{ role: 'user' as const, content: '缓存预热内容 D' }],
    }
    const warm = client(testEnv(), f)
    await warm.c.chat(req)

    const { fetch: f2, log } = fakeFetch(() => jsonResponse({}))
    const cold = client(testEnv({ DEEPSEEK_API_KEY: '' }), f2)
    const res = await cold.c.chat(req)
    expect(res.cached).toBe(true)
    expect(res.content).toBe('{"warm":1}')
    expect(log.count).toBe(0)
  })
})

describe('chat —— 每日 token 预算（spec §4.4）', () => {
  async function seedUsage(tokens: number) {
    await prisma.aiCall.create({
      data: {
        purpose: 'seed',
        model: 'deepseek-v4-pro',
        promptHash: 'seed',
        promptTokens: tokens,
        completionTokens: 0,
        latencyMs: 0,
        ok: true,
      },
    })
  }

  it('超预算时 L2 被拒（BUDGET_EXCEEDED）', async () => {
    await seedUsage(300_000)
    const { fetch: f } = fakeFetch(() => jsonResponse({ data: [] }))
    const { c } = client(testEnv({ AI_DAILY_TOKEN_BUDGET: '200000' }), f)
    await expect(
      c.chat({ purpose: 'l2_authenticity', model: 'smart', messages: [{ role: 'user', content: 'z1' }] }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
  })

  it('超预算时 L1 仍可跑（降级为只跑 L0 + L1）', async () => {
    await seedUsage(300_000)
    const { fetch: f } = fakeFetch((url) =>
      url.endsWith('/models')
        ? jsonResponse({ data: [] })
        : jsonResponse({ choices: [{ message: { content: '{"results":[]}' } }], usage: {} }),
    )
    const { c } = client(testEnv({ AI_DAILY_TOKEN_BUDGET: '200000' }), f)
    const res = await c.chat({
      purpose: 'l1_relevance',
      model: 'fast',
      budgetExempt: true,
      messages: [{ role: 'user', content: 'z2' }],
    })
    expect(res.content).toBe('{"results":[]}')
  })

  it('预算未超时正常放行', async () => {
    const { fetch: f } = fakeFetch((url) =>
      url.endsWith('/models')
        ? jsonResponse({ data: [] })
        : jsonResponse({ choices: [{ message: { content: '{}' } }], usage: {} }),
    )
    const { c } = client(testEnv({ AI_DAILY_TOKEN_BUDGET: '200000' }), f)
    const res = await c.chat({
      purpose: 'l2_authenticity',
      model: 'smart',
      messages: [{ role: 'user', content: 'z3' }],
    })
    expect(res.cached).toBe(false)
  })
})

describe('AI_MOCK=1（契约 §7）', () => {
  it('返回确定性结果，一次网络请求都不发', async () => {
    const { fetch: f, log } = fakeFetch(() => jsonResponse({}))
    const { c } = client(testEnv({ AI_MOCK: '1' }), f)
    const req = {
      purpose: 'l2_authenticity' as const,
      model: 'smart' as const,
      messages: [{ role: 'user' as const, content: 'mock 内容' }],
      mock: () => '{"authenticity":0.5,"flags":[],"reasoning":"mock"}',
    }
    const a = await c.chat(req)
    const b = await c.chat(req)
    expect(a.content).toBe('{"authenticity":0.5,"flags":[],"reasoning":"mock"}')
    expect(b.content).toBe(a.content)
    expect(a.model).toContain('mock')
    expect(log.count).toBe(0)
  })

  it('mock 模式下也记账（成本面板在离线测试里可验证）', async () => {
    const { fetch: f } = fakeFetch(() => jsonResponse({}))
    const { c } = client(testEnv({ AI_MOCK: '1' }), f)
    await c.chat({
      purpose: 'l2_authenticity',
      model: 'smart',
      messages: [{ role: 'user', content: '记账测试内容足够长' }],
      mock: () => '{"ok":true}',
    })
    const rows = await prisma.aiCall.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.promptTokens).toBeGreaterThan(0)
  })

  it('mock 模式不读缓存：缓存里即使有真实回包也不影响确定性', async () => {
    await prisma.aiCache.create({
      data: {
        promptHash: 'whatever',
        purpose: 'l2_authenticity',
        response: '{"from":"cache"}',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    const { fetch: f } = fakeFetch(() => jsonResponse({}))
    const { c } = client(testEnv({ AI_MOCK: '1' }), f)
    const res = await c.chat({
      purpose: 'l2_authenticity',
      model: 'smart',
      messages: [{ role: 'user', content: '缓存干扰测试' }],
      mock: () => '{"from":"mock"}',
    })
    expect(res.content).toBe('{"from":"mock"}')
    expect(res.cached).toBe(false)
  })
})
