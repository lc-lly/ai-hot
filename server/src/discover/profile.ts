/**
 * 领域画像 —— 把 `Setting` 里那串自由文本（spec §8 默认「AI 编程」）
 * 翻译成一组可匹配的关键词。
 *
 * 为什么不用 AI：契约 §3.4 已经为**分类**定死了关键词映射的口径
 * （「第一版用关键词映射，不调 AI」）。领域**筛选**比分类更简单——
 * 它只需要一个布尔判断，用 AI 属于把零成本环节变成持续花钱的环节。
 * spec §8 说「`discover` 才需要 AI 分领域」，但 AI 那一步的产出
 * （`Cluster.aiSummary` / `aiVerdict`）属于阶段 2 的 AI 层，不归这里；
 * 本模块只负责「这条簇算不算在这个领域里」。
 */

/** spec §8：领域范围第一版默认值 */
export const DEFAULT_DISCOVER_DOMAIN = 'AI 编程'

// 汉字（含扩展 A）、假名、谚文。写成 \u 转义，免得被工具链的编码处理改坏。
const CJK_RANGES = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af'
const CJK_CHAR = new RegExp(`[${CJK_RANGES}]`)

/**
 * 内置领域画像。key 是**归一化后**的领域名（小写、去空格）。
 *
 * 只内置最常用的一个：spec 只要求默认值可用，
 * 其余领域名走「按分隔符拆词」的通用路径，用户填 `Agent, RAG` 就能用。
 */
export const DOMAIN_PROFILES: Readonly<Record<string, readonly string[]>> = {
  ai编程: [
    'ai',
    '人工智能',
    '大模型',
    '语言模型',
    'llm',
    'gpt',
    'chatgpt',
    'openai',
    'claude',
    'anthropic',
    'gemini',
    'llama',
    'qwen',
    'deepseek',
    'mistral',
    'copilot',
    'cursor',
    'ide',
    '编辑器',
    '编程',
    '代码',
    'coding',
    'code',
    'developer',
    '开发者',
    'agent',
    '智能体',
    'mcp',
    '开源',
    'github',
    'prompt',
    '提示词',
    'rag',
    '微调',
    'fine-tune',
    '推理',
  ],
}

function normalizeDomainKey(domain: string): string {
  return domain.trim().toLowerCase().replace(/\s+/g, '')
}

/** 领域名 → 关键词列表。未知领域名按 `,` `，` `、` `;` `|` 与空白拆词。 */
export function domainKeywords(domain: string | null | undefined): string[] {
  const fallback = [...(DOMAIN_PROFILES[normalizeDomainKey(DEFAULT_DISCOVER_DOMAIN)] ?? [])]
  const raw = (domain ?? '').trim()
  if (raw === '') return fallback

  const profile = DOMAIN_PROFILES[normalizeDomainKey(raw)]
  if (profile) return [...profile]

  const parts = raw
    .split(/[,，、;；|\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '')

  return parts.length > 0 ? [...new Set(parts)] : fallback
}

const latinPatternCache = new Map<string, RegExp>()

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 单个关键词的命中判断。
 *
 * 拉丁关键词必须落在词边界上（`(?<![a-z0-9])` / `(?![a-z0-9])`），
 * 否则 `ai` 会在 `said`、`chain`、`air` 里命中，`code` 会在 `encode` 里命中——
 * 那会让领域筛选退化成「几乎什么都算 AI」。
 * 中日韩关键词没有词边界的概念，直接子串匹配。
 */
export function containsKeyword(haystack: string, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase()
  if (kw === '') return false
  if (CJK_CHAR.test(kw)) return haystack.includes(kw)

  let re = latinPatternCache.get(kw)
  if (re === undefined) {
    re = new RegExp(`(?<![a-z0-9])${escapeRegExp(kw)}(?![a-z0-9])`)
    latinPatternCache.set(kw, re)
  }
  return re.test(haystack)
}

/**
 * 文本是否落在该领域内（任一关键词命中即算）。
 *
 * 文本先做 NFKC + 小写；另用「去掉空白」的版本再扫一遍，
 * 这样关键词里的空格（`vibe coding`）与正文里的断行都不会导致漏判。
 */
export function matchesDomain(text: string, keywords: readonly string[]): boolean {
  if (text === '') return false
  const haystack = text.normalize('NFKC').toLowerCase()
  const compact = haystack.replace(/\s+/g, '')

  return keywords.some((raw) => {
    const kw = raw.replace(/\s+/g, '')
    if (kw === '') return false
    return containsKeyword(haystack, kw) || containsKeyword(compact, kw)
  })
}

/** 把一列标题（+ 可选摘要）拼成供领域匹配用的文本。 */
export function domainText(
  titles: readonly (string | null | undefined)[],
  summaries: readonly (string | null | undefined)[] = [],
): string {
  const parts: string[] = []
  for (const t of titles) if (t) parts.push(t)
  for (const s of summaries) if (s) parts.push(s)
  return parts.join(' \n ')
}
