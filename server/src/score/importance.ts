/**
 * 条目的「重要程度」分档，参考项目卡片上那个四色徽章。
 *
 * 分四档，与参考项目一致：`urgent` | `high` | `medium` | `low`。
 *
 * ## 为什么先做纯函数版
 *
 * 最终口径应该由 L2 的 AI 判定给出（AI 读得懂「某大模型发布」比「某库发了个
 * patch」重要），但那要改 prompt、改 mock 回包、改解析器，链路长。
 * 而卡片的首要视觉、筛选栏的一个下拉、统计卡的「紧急热点」全都依赖这个字段，
 * 不能等。
 *
 * 所以：**先用热度 + flags 算出一个确定性结果，让链路立刻可用；
 * AI 覆盖是后续增量，不改这个函数的签名。**
 *
 * 纯函数，无 IO。
 */

export const IMPORTANCE_LEVELS = ['urgent', 'high', 'medium', 'low'] as const
export type Importance = (typeof IMPORTANCE_LEVELS)[number]

/** 顺序即严重度，`urgent` 在最前。给筛选栏和排序用。 */
export const IMPORTANCE_RANK: Readonly<Record<Importance, number>> = {
  urgent: 3,
  high: 2,
  medium: 1,
  low: 0,
}

/**
 * 可疑内容降权系数。
 *
 * 「重要」的前提是「可信」——一条被标了 rumor / clickbait / ad 的内容
 * 即使热度很高，也不该占据卡片列表顶部的 urgent 位。
 * 注意这里是**降权不是归零**：它仍然值得看，只是不该排在最前
 * （与 spec §4.2「低置信不删除，只降级」同一原则）。
 */
const FLAG_PENALTY: Readonly<Record<string, number>> = {
  ad: 0.5,
  clickbait: 0.6,
  rumor: 0.6,
  ai_generated: 0.8,
}

/**
 * 分档阈值（作用在**调整后**的分数上，不是原始 heat）。
 *
 * 定这几个数的依据：`HEAT_FALLBACK = 0.3` 意味着取不到互动量的源
 * （rss 等）恒定落在 `medium` 的边界上，不会因为「拿不到数据」被误判成 `low`。
 */
const BANDS: ReadonlyArray<{ min: number; level: Importance }> = [
  { min: 0.7, level: 'urgent' },
  { min: 0.5, level: 'high' },
  { min: 0.3, level: 'medium' },
]

export interface ImportanceInput {
  /** 0..1，来自 `score/heat.ts` */
  heat: number
  /** `HotItem.aiFlags` 解析后的数组 */
  flags?: readonly string[]
}

/**
 * 由热度与 flags 推出重要程度。
 *
 * 多个 flag 的惩罚是**连乘**的：一条既是广告又是标题党的内容，
 * 应当比只中一个的更低，而不是取最重的那一个。
 */
export function importanceOf(input: ImportanceInput): Importance {
  const heat = Number.isFinite(input.heat) ? input.heat : 0

  let score = heat
  for (const flag of input.flags ?? []) {
    const penalty = FLAG_PENALTY[flag]
    if (penalty !== undefined) score *= penalty
  }

  for (const band of BANDS) {
    if (score >= band.min) return band.level
  }
  return 'low'
}

/** 校验一个任意值是不是合法档位。用于筛选参数的**白名单**映射。 */
export function isImportance(v: unknown): v is Importance {
  return typeof v === 'string' && (IMPORTANCE_LEVELS as readonly string[]).includes(v)
}
