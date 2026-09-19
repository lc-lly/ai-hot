/**
 * 集合相似度 —— 纯函数。
 *
 * 用 **Dice 系数**（`2|A∩B| / (|A|+|B|)`）而不是 Jaccard：
 * Dice 对「一条标题比另一条长、但核心词一致」的情况更宽容
 * （长标题带来的额外 token 只稀释一次，而不是同时抬高并集）。
 * 新闻标题里这种长度差异极常见：`OpenAI ships GPT-6`
 * vs `OpenAI ships GPT-6 to all Plus users`。
 */

/** 把 token 数组收成集合。 */
export function toSet(tokens: readonly string[]): Set<string> {
  return new Set(tokens)
}

/** Dice 系数，两个空集约定为 0（没有证据就不算相似）。 */
export function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  // 遍历小的那个，减少哈希查找次数
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const token of small) if (large.has(token)) shared += 1
  if (shared === 0) return 0
  return (2 * shared) / (a.size + b.size)
}

/** token 数组之间的 Dice。 */
export function diceOfTokens(a: readonly string[], b: readonly string[]): number {
  return dice(toSet(a), toSet(b))
}
