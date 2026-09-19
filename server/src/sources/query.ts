import type { FetchContext } from './types.js'

/**
 * 搜索类适配器共用的查询词读取。
 *
 * ## 为什么单独成文件而不是放在某个 adapter 里
 *
 * `hn-algolia` / `reddit-search` / `github-search` 三个适配器都要读它。
 * 让后两个从 `hn-algolia.ts` import 一个叫 `readQuery` 的函数，会让
 * 「Reddit 的搜索依赖 HN 的实现文件」——改 HN 时不敢动，读代码时要多跳一次。
 *
 * ## 为什么缺失时返回 `null` 而不是空串
 *
 * 调用方必须**区分**「没配查询词」（跳过请求，返回空数组）和
 * 「查询词是空串」（同样跳过）。两者行为一致，但 `null` 让调用点写成
 * `if (query === null) return []` ——一眼能看出这是「不请求」而不是「请求了但没结果」。
 */
export function readQuery(ctx: FetchContext): string | null {
  const value = ctx.config.query ?? ctx.config.q
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
