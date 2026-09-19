/**
 * 契约 §3.4 冻结的 `domain` 算法。
 *
 * 第一版用关键词映射，**不调 AI**（省钱，且 spec §8 的 `discover` 才需要 AI 分领域）。
 * 按顺序匹配 `title + summary`，命中即返回，全不中返回 `其他`。
 *
 * **这是刻意的粗糙**：领域只决定雷达盘上的**角度**，粗分类不影响可用性；
 * 精确分类留给阶段 5 的 `discover`。
 *
 * 纯函数，无 IO、**读时计算**，不落库。
 */

export const DOMAIN_FALLBACK = '其他'

/**
 * 顺序即优先级：先命中的 domain 胜出。
 * 关键词一律小写，匹配时把 haystack 也转小写。
 */
export const DOMAIN_KEYWORDS: ReadonlyArray<{ domain: string; keywords: readonly string[] }> = [
  { domain: '大模型', keywords: ['gpt', 'claude', 'gemini', 'llama', 'qwen', 'deepseek', '大模型', '语言模型', 'llm'] },
  { domain: '编程工具', keywords: ['cursor', 'copilot', 'ide', '编程', '代码', 'coding', 'developer', '编辑器'] },
  { domain: '开源', keywords: ['github', '开源', 'open source', 'repo', 'star'] },
  { domain: '硬件', keywords: ['gpu', '芯片', 'nvidia', '算力', '显卡', 'tpu'] },
  { domain: '行业', keywords: ['融资', '收购', '发布', '裁员', '监管', '政策'] },
]

/** 所有可能的 domain 取值（含 fallback），供前端做角度映射。 */
export const DOMAINS: readonly string[] = [...DOMAIN_KEYWORDS.map((d) => d.domain), DOMAIN_FALLBACK]

/**
 * 按 `title + summary` 匹配领域。大小写不敏感。
 *
 * @returns 命中的 domain，全不中返回 `'其他'`
 */
export function domain(
  title: string | null | undefined,
  summary: string | null | undefined,
): string {
  const haystack = `${title ?? ''}\n${summary ?? ''}`.toLowerCase()

  for (const entry of DOMAIN_KEYWORDS) {
    for (const keyword of entry.keywords) {
      if (haystack.includes(keyword)) return entry.domain
    }
  }
  return DOMAIN_FALLBACK
}
