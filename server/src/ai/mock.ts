import { expandKeyword } from './prefilter.js'
import { clamp01, type AiFlag } from './types.js'

/**
 * `AI_MOCK=1` 下的确定性回包（契约 §7）。
 *
 * 三条硬约束：
 *   1. **不联网**——全部测试靠它离线跑。
 *   2. **完全确定**——不看时钟、不取随机数，同一输入永远同一输出，
 *      否则断言会随机红。
 *   3. **可被文本驱动**——按内容里的特征词决定 flags，
 *      这样测试能构造出「标题党」「软文」等场景去验证分流，
 *      而不是只能断言一个恒定值。
 */

interface Marker {
  flag: AiFlag
  pattern: RegExp
}

/** 特征词 → 标签。顺序固定，输出顺序才稳定。 */
export const MOCK_MARKERS: readonly Marker[] = [
  { flag: 'clickbait', pattern: /震惊|必看|重磅|揭秘|炸了|杀疯了|标题党|不看后悔|!!!|！！！/i },
  { flag: 'rumor', pattern: /传闻|据传|网传|据说|有消息称|内部人士|疑似|小道消息/i },
  { flag: 'ai_generated', pattern: /ai\s*生成|ai-generated|synthetic|由ai撰写|机器生成|本文由ai/i },
  { flag: 'ad', pattern: /广告|推广|优惠|限时|折扣|加微信|扫码|课程报名|软文/i },
  { flag: 'stale', pattern: /去年|旧闻|回顾|转载|重发|2023|2024/i },
  { flag: 'unverified', pattern: /未证实|未经证实|无法核实|尚无官方|unverified/i },
]

/** mock 的判罚步长：每命中一个标签扣 0.18 */
export const MOCK_FLAG_PENALTY = 0.18

export function mockFlagsOf(text: string): AiFlag[] {
  const flags: AiFlag[] = []
  for (const marker of MOCK_MARKERS) {
    if (marker.pattern.test(text)) flags.push(marker.flag)
  }
  return flags
}

export interface MockAuthenticityInput {
  title: string
  summary?: string | null
  url?: string | null
  author?: string | null
}

export interface MockAuthenticityPayload {
  authenticity: number
  flags: AiFlag[]
  reasoning: string
}

export function mockAuthenticityPayload(input: MockAuthenticityInput): MockAuthenticityPayload {
  const text = `${input.title}\n${input.summary ?? ''}`
  const flags = mockFlagsOf(text)
  const authenticity = clamp01(Number((1 - MOCK_FLAG_PENALTY * flags.length).toFixed(3)))
  const reasoning = flags.length
    ? `[mock] 命中特征: ${flags.join(', ')}`
    : '[mock] 未命中任何可疑特征，判为可信'
  return { authenticity, flags, reasoning }
}

export function mockAuthenticityJson(input: MockAuthenticityInput): string {
  return JSON.stringify(mockAuthenticityPayload(input))
}

export interface MockRelevanceInput {
  id: string
  title: string
  summary?: string | null
}

export interface MockRelevanceVerdict {
  id: string
  is_about_topic: boolean
  relevance: number
  reason: string
}

/**
 * mock 版相关性：关键词出现在标题 → 0.9；只出现在摘要 → 0.6；都没有 → 0.3。
 * 0.5 是 `is_about_topic` 的分界，所以只有「标题命中」才算「关于」。
 */
export function mockRelevanceVerdicts(
  items: readonly MockRelevanceInput[],
  topic: string,
): MockRelevanceVerdict[] {
  const terms = expandKeyword(topic)
  const titleRes = terms.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))

  return items.map((item) => {
    const inTitle = titleRes.some((re) => re.test(item.title))
    const inSummary = titleRes.some((re) => re.test(item.summary ?? ''))
    const relevance = inTitle ? 0.9 : inSummary ? 0.6 : 0.3
    return {
      id: item.id,
      is_about_topic: relevance >= 0.5,
      relevance,
      reason: inTitle
        ? `[mock] 标题直接命中「${topic}」`
        : inSummary
          ? `[mock] 仅摘要提及「${topic}」`
          : `[mock] 未命中「${topic}」`,
    }
  })
}

export function mockRelevanceJson(items: readonly MockRelevanceInput[], topic: string): string {
  return JSON.stringify({ results: mockRelevanceVerdicts(items, topic) })
}
