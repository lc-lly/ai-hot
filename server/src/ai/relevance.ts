import type { ChatMessage, DeepSeekClient } from './client.js'
import { extractJson } from './client.js'
import { mockRelevanceJson } from './mock.js'
import { clamp01, type AiLogger } from './types.js'

/**
 * L1 —— 相关性（`deepseek-flash`）。
 *
 * spec §4 的那个关键区别：判定条目是不是**关于**这个关键词，
 * 而不是文中**提到**了这个关键词。这一层是全系统误报的主要来源：
 * 「本周 AI 新闻汇总」里带过一句 Cursor，和一篇专门评测 Cursor 的文章，
 * 对博主的价值差着数量级。
 *
 * 10 条一批（spec §4 表格），把固定的 system prompt 摊薄到 10 条上。
 */

export const L1_BATCH_SIZE = 10

/** 单条摘要送进 prompt 的截断长度。目的是压 token，不是保真。 */
const SUMMARY_LIMIT = 300

export interface L1Input {
  id: string
  title: string
  summary?: string | null
  url: string
}

export interface L1Verdict {
  id: string
  isAboutTopic: boolean
  relevance: number
  reason: string
}

export interface L1Deps {
  client: DeepSeekClient
  logger?: AiLogger
}

export const L1_SYSTEM_PROMPT = `你在为一位 AI 编程方向的科技博主做关键词监控筛选。

给你一个监控关键词，判断每一条内容是不是「关于」这个关键词。

【最重要的判断】
区分「关于」和「提到」：
- 关于（is_about_topic = true）：这条内容的主旨就是在讨论该关键词所指的事物。把关键词从内容里拿掉，这条内容就不成立或失去主要意义。
- 提到（is_about_topic = false）：关键词只是顺带出现。

【必须判 false 的典型情况】
- 关键词出现在「相关阅读」「猜你喜欢」「其他文章」「评论区」这类导航或周边文本里。
- 关键词在一篇讲别的话题的文章里只出现一次，且只是举例或类比。
- 关键词属于「本周汇总」「10 条快讯」这类聚合体裁中的一行——聚合条目本身不是关于它的。
- 命中来自歧义（同一个词在该语境下是另一个意思，如人名、地名、编程语言名与产品名冲突）。
- 内容是招聘启事、课程广告、活动通知，只在要求或卖点里提到该关键词。
- 关键词命中的是文章里引用的旧内容、历史回顾段落。

【relevance 打分 0..1】
- 0.90-1.00：整篇围绕该关键词展开，且是该关键词的最新进展。
- 0.60-0.89：主体相关，关键词是其中一个重要方面。
- 0.30-0.59：明确提到，但主题是别的。
- 0.00-0.29：几乎无关，或纯属噪音。

【输出】
严格输出以下 JSON，不要 markdown 代码块，不要额外解释：
{"results":[{"id":"<原样返回输入的 id>","is_about_topic":true,"relevance":0.0,"reason":"<中文，30 字以内，说明是「关于」还是「仅提及」>"}]}

results 必须与输入条目一一对应，一条不漏、顺序不限，id 必须原样回传。`

export interface L1PayloadItem {
  id: string
  title: string
  summary: string
  url: string
}

export function buildL1UserMessage(topic: string, items: readonly L1Input[]): string {
  const payload: L1PayloadItem[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    summary: (item.summary ?? '').slice(0, SUMMARY_LIMIT),
    url: item.url,
  }))
  return `监控关键词：「${topic}」

待判断条目（共 ${payload.length} 条）：
${JSON.stringify(payload, null, 1)}`
}

export function buildRelevanceMessages(topic: string, items: readonly L1Input[]): ChatMessage[] {
  return [
    { role: 'system', content: L1_SYSTEM_PROMPT },
    { role: 'user', content: buildL1UserMessage(topic, items) },
  ]
}

/** 把模型回包解析成 id → 判定。无法解析的 id 不在这里报错，交给调用方标 failed。 */
export function parseL1Response(content: string): Map<string, L1Verdict> {
  const parsed = extractJson(content) as { results?: unknown }
  const rows = Array.isArray(parsed?.results) ? parsed.results : []
  const out = new Map<string, L1Verdict>()

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : null
    if (!id) continue
    const relevance = clamp01(Number(r.relevance))
    const isAbout =
      typeof r.is_about_topic === 'boolean' ? r.is_about_topic : relevance >= 0.5
    out.set(id, {
      id,
      isAboutTopic: isAbout,
      relevance,
      reason: typeof r.reason === 'string' ? r.reason : '',
    })
  }
  return out
}

export interface L1BatchResult {
  verdicts: Map<string, L1Verdict>
  /** 模型没回或者回得不全的条目 id —— 调用方应当把它们留在 pending 重试 */
  missing: string[]
  calls: number
}

/** 跑一批（≤10 条）。调用方负责分片，这个函数只处理一批。 */
export async function runRelevanceBatch(
  deps: L1Deps,
  topic: string,
  items: readonly L1Input[],
): Promise<L1BatchResult> {
  if (items.length === 0) return { verdicts: new Map(), missing: [], calls: 0 }

  const start = Date.now()
  const result = await deps.client.chat({
    purpose: 'l1_relevance',
    model: 'fast',
    json: true,
    temperature: 0,
    // L1 是预算耗尽后仍然保留的那一层（spec §4.4「降级为只跑 L0 + L1」）
    budgetExempt: true,
    messages: buildRelevanceMessages(topic, items),
    mock: () => mockRelevanceJson(items, topic),
  })

  const verdicts = parseL1Response(result.content)
  const missing = items.filter((i) => !verdicts.has(i.id)).map((i) => i.id)

  deps.logger?.({
    level: missing.length ? 'warn' : 'debug',
    channel: 'ai',
    message: `L1 相关性判定 ${items.length} 条：关键词「${topic}」`,
    meta: {
      model: result.model,
      cached: result.cached,
      tokens: result.promptTokens + result.completionTokens,
      elapsedMs: Date.now() - start,
      about: [...verdicts.values()].filter((v) => v.isAboutTopic).length,
      missing: missing.length,
    },
  })

  return { verdicts, missing, calls: 1 }
}

export interface L1RunResult {
  verdicts: Map<string, L1Verdict>
  missing: string[]
  /** 实际发生的 AI 调用次数（= ceil(items / 10)） */
  calls: number
}

/** 按 10 条一批切分并依次跑完。某一批失败不影响其它批。 */
export async function runRelevance(
  deps: L1Deps,
  topic: string,
  items: readonly L1Input[],
): Promise<L1RunResult> {
  const verdicts = new Map<string, L1Verdict>()
  const missing: string[] = []
  let calls = 0

  for (let i = 0; i < items.length; i += L1_BATCH_SIZE) {
    const batch = items.slice(i, i + L1_BATCH_SIZE)
    try {
      const res = await runRelevanceBatch(deps, topic, batch)
      calls += res.calls
      for (const [id, verdict] of res.verdicts) verdicts.set(id, verdict)
      missing.push(...res.missing)
    } catch (e) {
      // 一批挂了只丢这一批，其余批继续——单点失败不该让整轮 triage 归零
      deps.logger?.({
        level: 'warn',
        channel: 'ai',
        message: `L1 批次失败（keyword=${topic}，${batch.length} 条）: ${e instanceof Error ? e.message : String(e)}`,
      })
      missing.push(...batch.map((b) => b.id))
    }
  }

  return { verdicts, missing, calls }
}
