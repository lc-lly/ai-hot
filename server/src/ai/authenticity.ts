import type { ChatMessage, DeepSeekClient } from './client.js'
import { extractJson } from './client.js'
import { mockAuthenticityJson } from './mock.js'
import { clamp01, normalizeFlags, type AiFlag, type AiLogger } from './types.js'

/**
 * L2 —— 真伪质量（`deepseek-v4-pro`，逐条）。
 *
 * **这是产品的核心需求**：用户的原始诉求是「注意利用 AI 识别假冒的内容」。
 * 所以这一层的 prompt 不是在打分，是在做一次具体的核对：
 * 标题党了吗？是 AI 灌水吗？是没来源的传闻吗？是软文吗？是旧闻翻炒吗？
 *
 * 与 L1 的分工（契约 §6.2）：L2 是**条目级**的——
 * 「这条内容本身可不可信」，与任何关键词无关，雷达盘的真伪标记用它。
 * 所以它每条一调，不按关键词分批。
 */

/** 送进 prompt 的正文上限。压 token，也避免超长内容让模型抓不住重点。 */
export const L2_MAX_TEXT_CHARS = 1500

export interface L2Input {
  id: string
  title: string
  summary?: string | null
  url?: string | null
  author?: string | null
  /** ISO 字符串或 Date，用于识别旧闻 */
  publishedAt?: string | Date | null
  sourceName?: string | null
}

export interface L2Verdict {
  authenticity: number
  flags: AiFlag[]
  reasoning: string
}

export interface L2Deps {
  client: DeepSeekClient
  logger?: AiLogger
}

export const L2_SYSTEM_PROMPT = `你是内容真伪审核员，为一位 AI 编程方向的科技博主过滤信息。你的唯一任务是判断「这条内容本身可不可信」。

只依据给定文本判断。不要用你的世界知识去补全事实，也不要因为标题里出现了知名公司或人物的名字就默认它可信——恰恰相反，冒充大厂消息是最常见的造假手法。

【逐项核对，命中即打上对应标签】

1. clickbait（标题党）
   标题用夸张、悬念、情绪化措辞骗取点击，正文没有对应的事实量。
   例：「震惊！」「刚刚，XX 彻底杀疯了」「看完这篇你就懂了」「重磅内幕曝光」「再不看就晚了」。
   标题的承诺与正文的实际内容严重不符时，同样算。

2. ai_generated（AI 生成的低质内容）
   行文高度模板化：空泛的排比、「首先/其次/最后/总而言之」式骨架、大量无信息量的形容词。
   术语堆砌但没有一个具体事实；没有作者观点、没有第一手细节、没有可核对的数字与日期；
   段落长度异常均匀。典型的批量灌水稿。

3. rumor（未证实传闻）
   出现「据传」「有消息称」「网传」「内部人士透露」「据悉」却给不出任何可核验的来源；
   或把预测、猜测、爆料腔调写成已经发生的事实。
   注意：权威媒体引用具名信源的报道不算 rumor。

4. stale（旧闻翻炒）
   内容是过去事件的重新包装，当成新闻发出来。文本里出现去年或更早的日期、
   或自称「转载」「回顾」「盘点」却没有任何新增信息。

5. ad（广告/软文）
   核心目的是推广产品、课程或引流，而非传递信息。含优惠码、报名入口、
   「限时」「加微信」「扫码进群」等；或以「测评」「亲测」为壳行推销之实的软文。

6. unverified（无法核实）
   文本太短或缺少关键要素（无来源、无日期、无具体主体、无数字），不足以支撑任何结论。
   这种情况给 unverified，**不要猜**。

【authenticity 打分 0..1】
- 0.90-1.00：一手信息，有明确来源、日期与具体数字，措辞克制。
- 0.70-0.89：可信媒体的报道，信息具体，可能有轻微渲染。
- 0.40-0.69：信息不完整或部分可疑，需要交叉验证。
- 0.10-0.39：明显标题党、软文，或疑似 AI 灌水。
- 0.00-0.09：确定是虚假或恶意误导。

【输出】
严格输出以下 JSON，不要 markdown 代码块，不要额外解释：
{"authenticity":0.0,"flags":[],"reasoning":"<中文，40 字以内，指出具体依据，不要写套话>"}

flags 只能取上述 6 个英文标签，可为空数组；没有把握就不要乱打标签。
reasoning 必须点出具体依据（引用了哪句话、缺了什么要素），禁止「内容质量一般」这类废话。`

export function buildL2UserMessage(input: L2Input): string {
  const published =
    input.publishedAt instanceof Date
      ? input.publishedAt.toISOString()
      : (input.publishedAt ?? '未知')

  const body = (input.summary ?? '').slice(0, L2_MAX_TEXT_CHARS)

  return `【标题】${input.title}
【来源】${input.sourceName ?? '未知'}
【作者】${input.author ?? '未知'}
【发布时间】${published}
【链接】${input.url ?? '无'}
【正文/摘要】
${body || '（无正文，仅标题）'}`
}

export function buildAuthenticityMessages(input: L2Input): ChatMessage[] {
  return [
    { role: 'system', content: L2_SYSTEM_PROMPT },
    { role: 'user', content: buildL2UserMessage(input) },
  ]
}

export function parseL2Response(content: string): L2Verdict {
  const parsed = extractJson(content) as Record<string, unknown>
  const authenticity = clamp01(Number(parsed?.authenticity))
  return {
    authenticity,
    flags: normalizeFlags(parsed?.flags),
    reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning : '',
  }
}

/** 单条真伪判定。抛错由调用方接住——一条失败不该带走整轮。 */
export async function runAuthenticity(deps: L2Deps, input: L2Input): Promise<L2Verdict> {
  const start = Date.now()
  const result = await deps.client.chat({
    purpose: 'l2_authenticity',
    model: 'smart',
    json: true,
    temperature: 0,
    messages: buildAuthenticityMessages(input),
    mock: () => mockAuthenticityJson(input),
  })

  const verdict = parseL2Response(result.content)

  deps.logger?.({
    level: 'info',
    channel: 'ai',
    message: `L2 真伪判定条 ${input.id}: authenticity=${verdict.authenticity}${
      verdict.flags.length ? ` flags=[${verdict.flags.join(',')}]` : ''
    }`,
    meta: {
      model: result.model,
      cached: result.cached,
      tokens: result.promptTokens + result.completionTokens,
      elapsedMs: Date.now() - start,
    },
  })

  return verdict
}

/** `/api/ai/verify` 与 triage 都走这里，保证「条目级真伪」只有一种口径。 */
export function verdictToColumns(verdict: L2Verdict): {
  authenticity: number
  aiFlags: string
  aiReasoning: string
} {
  return {
    authenticity: verdict.authenticity,
    aiFlags: JSON.stringify(verdict.flags),
    aiReasoning: verdict.reasoning,
  }
}
