import type { AiDeps, AiLogger } from './types.js'
import { promptHashOf, readCache, writeCache } from './cache.js'
import { estimateTokens, type BudgetTracker } from './budget.js'

/**
 * DeepSeek 客户端。
 *
 * 三点刻意的设计：
 *   - **OpenAI 兼容协议**：`POST {BASE}/chat/completions` + `Authorization: Bearer`，
 *     用 Node 20 全局 fetch，不引任何 SDK（契约 §7：不新增依赖）。
 *   - **模型名一律来自 env**，不硬编码（spec §4.3）。启动时探 `/models`，
 *     配的名字不在可用列表里就回退——探失败是非致命的，仍然用配置名去试。
 *   - **没有 key 也不抛到进程级**：抛 `AiUnavailableError`，由调用方
 *     把条目留在 `pending`，服务照常跑（spec §12：缺可选依赖不影响启动）。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ModelKind = 'fast' | 'smart'

export interface ChatRequest {
  /** 记账用：l1_relevance | l2_authenticity | verify | probe */
  purpose: string
  model: ModelKind
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** 要求模型返回 JSON 对象（DeepSeek 兼容 `response_format`） */
  json?: boolean
  /** `AI_MOCK=1` 时的确定性回包 */
  mock?: () => string
  /** 预算降级后仍允许调用（L1 是降级后保留的那层，spec §4.4） */
  budgetExempt?: boolean
  timeoutMs?: number
}

export interface ChatResult {
  content: string
  model: string
  promptTokens: number
  completionTokens: number
  cached: boolean
  latencyMs: number
}

export type AiUnavailableCode = 'NO_API_KEY' | 'BUDGET_EXCEEDED'

/** AI 层「暂时不可用」——不是崩溃，调用方应当降级而不是报错 */
export class AiUnavailableError extends Error {
  constructor(
    readonly code: AiUnavailableCode,
    message: string,
  ) {
    super(message)
    this.name = 'AiUnavailableError'
  }
}

/** 模型解析结果（spec §4.3 的探测 + 回退） */
export interface ModelResolution {
  fast: string
  smart: string
  /** `/models` 返回的 id 列表；探测失败时为空数组 */
  available: string[]
  /** config = 用 env 配的；probe = 探到了且配的名字可用；fallback = 回退到别名的 */
  source: 'config' | 'probe' | 'fallback'
  /** 回退说明 / 探测失败的警告文本，供日志与成本面板展示 */
  note: string | null
}

export interface DeepSeekClient {
  /** 有 key 或处于 mock 模式时才为 true */
  readonly enabled: boolean
  readonly mock: boolean
  models(): ModelResolution
  probe(): Promise<ModelResolution>
  chat(req: ChatRequest): Promise<ChatResult>
}

const DEFAULT_TIMEOUT_MS = 30_000

// ------------------------------------------------------------ 模型回退

const FAST_HINTS = /flash|fast|lite|chat|small|mini|turbo|v3/i
const SMART_HINTS = /pro|reason|max|ultra|v4|r1|thinking/i

function scoreModel(id: string, kind: ModelKind): number {
  let score = 0
  if (kind === 'fast') {
    if (FAST_HINTS.test(id)) score += 2
    if (SMART_HINTS.test(id)) score -= 1
  } else {
    if (SMART_HINTS.test(id)) score += 2
    if (FAST_HINTS.test(id)) score -= 1
  }
  // 明确排除不适合做正文生成的模态模型
  if (/embed|tts|asr|whisper|image|vision-encoder/i.test(id)) score -= 5
  return score
}

export function pickFallbackModel(available: readonly string[], kind: ModelKind): string | null {
  if (available.length === 0) return null
  let best: { id: string; score: number } | null = null
  for (const id of available) {
    const score = scoreModel(id, kind)
    if (!best || score > best.score) best = { id, score }
  }
  // 全部得负分说明这份列表里没有像样的候选；仍然给一个总比空着强
  return best?.id ?? available[0] ?? null
}

/** 兼容 `{data:[{id}]}`（OpenAI 风格，DeepSeek 用这个）与 `{models:[...]}` */
export function parseModelList(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const record = payload as { data?: unknown; models?: unknown }
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []

  const ids: string[] = []
  for (const row of rows) {
    if (typeof row === 'string') ids.push(row)
    else if (typeof row === 'object' && row !== null) {
      const id = (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name
      if (typeof id === 'string' && id.trim()) ids.push(id.trim())
    }
  }
  return [...new Set(ids)]
}

// ------------------------------------------------------------ 客户端

export interface DeepSeekClientDeps extends AiDeps {
  budget: BudgetTracker
}

export function createDeepSeekClient(deps: DeepSeekClientDeps): DeepSeekClient {
  const { env, prisma } = deps
  const log: AiLogger = deps.logger ?? (() => {})
  const doFetch = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? (() => new Date())

  const configured: ModelResolution = {
    fast: env.DEEPSEEK_MODEL_FAST,
    smart: env.DEEPSEEK_MODEL_SMART,
    available: [],
    source: 'config',
    note: null,
  }
  let resolution: ModelResolution = configured
  let probePromise: Promise<ModelResolution> | null = null

  const mock = env.AI_MOCK
  const enabled = mock || Boolean(env.DEEPSEEK_API_KEY)

  async function probe(): Promise<ModelResolution> {
    if (probePromise) return probePromise

    probePromise = (async (): Promise<ModelResolution> => {
      if (mock) {
        return { ...configured, source: 'config', note: 'AI_MOCK=1，跳过 /models 探测' }
      }
      if (!env.DEEPSEEK_API_KEY) {
        // 没有 key 也能启动：这是「用户还没填 key」的正常状态，不是错误
        log({
          level: 'warn',
          channel: 'ai',
          message: 'DEEPSEEK_API_KEY 未配置，AI 层降级：条目保持 pending，服务正常运行',
        })
        return { ...configured, source: 'config', note: 'NO_API_KEY' }
      }

      const url = `${env.DEEPSEEK_BASE_URL.replace(/\/+$/, '')}/models`
      try {
        const res = await doFetch(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const available = parseModelList(await res.json())
        if (available.length === 0) throw new Error('/models 返回空列表')

        const fast = available.includes(configured.fast)
          ? configured.fast
          : (pickFallbackModel(available, 'fast') ?? configured.fast)
        const smart = available.includes(configured.smart)
          ? configured.smart
          : (pickFallbackModel(available, 'smart') ?? configured.smart)

        const fellBack = fast !== configured.fast || smart !== configured.smart
        const note = fellBack
          ? `模型回退: fast ${configured.fast}→${fast}, smart ${configured.smart}→${smart}`
          : null
        if (note) log({ level: 'warn', channel: 'ai', message: note, meta: { available } })
        else
          log({
            level: 'info',
            channel: 'ai',
            message: `模型探测通过: fast=${fast} smart=${smart}`,
            meta: { available },
          })

        return {
          fast,
          smart,
          available,
          source: fellBack ? 'fallback' : 'probe',
          note,
        }
      } catch (e) {
        // 探测失败不能挡住启动：仍然拿 env 里的名字去打，报错时再降级
        const message = e instanceof Error ? e.message : String(e)
        log({
          level: 'warn',
          channel: 'ai',
          message: `GET /models 探测失败（非致命，继续用 env 配置的模型名）: ${message}`,
        })
        return { ...configured, source: 'config', note: `probe failed: ${message}` }
      }
    })()

    resolution = await probePromise
    return resolution
  }

  // 启动即探一次（非阻塞、非致命）。没有 key 或 mock 时 probe() 内部会直接返回，
  // 所以这里不会产生任何网络请求。
  void probe().catch(() => {})

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const started = Date.now()
    const temperature = req.temperature ?? 0
    const model = req.model === 'smart' ? resolution.smart : resolution.fast
    const promptHash = promptHashOf({
      purpose: req.purpose,
      model,
      messages: req.messages,
      temperature,
    })
    const clock = now()
    const promptTokens = estimateTokens(req.messages.map((m) => m.content).join('\n'))

    const record = async (row: {
      completionTokens: number
      ok: boolean
      error?: string | null
      cached?: boolean
      model?: string
      promptTokens?: number
    }) =>
      deps.budget.record({
        purpose: req.purpose,
        model: row.model ?? model,
        promptHash,
        promptTokens: row.promptTokens ?? promptTokens,
        completionTokens: row.completionTokens,
        latencyMs: Date.now() - started,
        ok: row.ok,
        error: row.error ?? null,
        cached: row.cached ?? false,
      })

    // 1) mock：确定性回包，不读缓存也不写缓存——缓存里可能有真实回包，会污染确定性
    if (mock) {
      const content = req.mock ? req.mock() : '{}'
      const completionTokens = estimateTokens(content)
      await record({ completionTokens, ok: true })
      return {
        content,
        model: `${model}(mock)`,
        promptTokens,
        completionTokens,
        cached: false,
        latencyMs: Date.now() - started,
      }
    }

    // 2) 缓存命中：免费，所以放在预算检查之前——超预算时也还能吃到旧结果
    const cached = await readCache(prisma, promptHash, clock)
    if (cached) {
      await record({ completionTokens: 0, ok: true, cached: true, promptTokens: 0 })
      return {
        content: cached.response,
        model,
        promptTokens: 0,
        completionTokens: 0,
        cached: true,
        latencyMs: Date.now() - started,
      }
    }

    // 3) 没有 key —— 降级，不崩
    if (!env.DEEPSEEK_API_KEY) {
      throw new AiUnavailableError(
        'NO_API_KEY',
        'DEEPSEEK_API_KEY 未配置，AI 能力不可用（条目保持 pending，服务不受影响）',
      )
    }

    // 4) 预算：超出后只保留 budgetExempt 的那层（L1）
    if (!req.budgetExempt && (await deps.budget.isDegraded(clock))) {
      throw new AiUnavailableError(
        'BUDGET_EXCEEDED',
        `今日 token 预算 ${env.AI_DAILY_TOKEN_BUDGET} 已用尽，AI 层降级为只跑 L0 + L1`,
      )
    }

    // 5) 真调用
    const url = `${env.DEEPSEEK_BASE_URL.replace(/\/+$/, '')}/chat/completions`
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          temperature,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await record({ completionTokens: 0, ok: false, error: message })
      throw new Error(`DeepSeek 请求失败(${req.purpose}): ${message}`)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const message = `HTTP ${res.status} ${body.slice(0, 300)}`
      await record({ completionTokens: 0, ok: false, error: message })
      throw new Error(`DeepSeek 返回错误(${req.purpose}): ${message}`)
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      const message = '响应里没有 choices[0].message.content'
      await record({ completionTokens: 0, ok: false, error: message })
      throw new Error(`DeepSeek 响应格式异常(${req.purpose}): ${message}`)
    }

    const realPromptTokens = payload.usage?.prompt_tokens ?? promptTokens
    const completionTokens = payload.usage?.completion_tokens ?? estimateTokens(content)

    await record({
      completionTokens,
      ok: true,
      promptTokens: realPromptTokens,
    })
    await writeCache(prisma, promptHash, req.purpose, content, clock)

    return {
      content,
      model,
      promptTokens: realPromptTokens,
      completionTokens,
      cached: false,
      latencyMs: Date.now() - started,
    }
  }

  return {
    enabled,
    mock,
    models: () => resolution,
    probe,
    chat,
  }
}

/** 从模型回包里抠出 JSON。模型常把 JSON 包在 ```json 围栏里，这里一并容忍。 */
export function extractJson(content: string): unknown {
  const trimmed = content.trim()
  const candidates: string[] = [trimmed]

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 试下一个
    }
  }
  throw new Error('响应不是合法 JSON')
}
