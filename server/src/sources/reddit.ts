import { truncate } from '../util/text.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

const DEFAULT_SUBREDDITS = ['LocalLLaMA', 'MachineLearning']
const DEFAULT_LIMIT = 25
const UA = 'ai-hot/0.1 (+https://github.com/local/ai-hot)'

interface RedditPost {
  id?: string
  name?: string
  title?: string
  permalink?: string
  selftext?: string
  author?: string
  created_utc?: number
  stickied?: boolean
  over_18?: boolean
}

/** 解析 Reddit listing JSON。结构不符时返回空数组，交由调用方决定是否算失败。 */
export function parseListing(payload: unknown, subreddit: string): RawItem[] {
  const children = (payload as { data?: { children?: unknown } } | null)?.data?.children
  if (!Array.isArray(children)) return []

  const out: RawItem[] = []
  for (const child of children) {
    const post = (child as { data?: RedditPost } | null)?.data
    if (!post?.id || !post.title || !post.permalink) continue
    if (post.stickied === true) continue
    if (post.over_18 === true) continue

    const selftext = (post.selftext ?? '').trim()
    out.push({
      externalId: `reddit:${post.name ?? `t3_${post.id}`}`,
      url: `https://www.reddit.com${post.permalink}`,
      title: post.title,
      summary: selftext ? truncate(selftext, 400) : null,
      author: post.author ?? null,
      publishedAt: post.created_utc ? new Date(post.created_utc * 1000) : null,
      lang: 'en',
      raw: post,
    })
  }
  return out
}

export const redditAdapter: SourceAdapter = {
  kind: 'reddit',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const subs = Array.isArray(ctx.config.subreddits)
      ? (ctx.config.subreddits as string[])
      : DEFAULT_SUBREDDITS
    const limit = Number(ctx.config.limit ?? DEFAULT_LIMIT)

    const out: RawItem[] = []
    const failures: string[] = []

    for (const sub of subs) {
      const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=${limit}&raw_json=1`
      try {
        const res = await ctx.fetch(url, { headers: { 'user-agent': UA } })
        if (!res.ok) {
          failures.push(`r/${sub}: HTTP ${res.status}`)
          continue
        }
        out.push(...parseListing(await res.json(), sub))
      } catch (e) {
        failures.push(`r/${sub}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    if (out.length === 0 && failures.length > 0) {
      throw new Error(`reddit 全部子版块失败 -> ${failures.join('; ')}`)
    }
    return out
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch('https://www.reddit.com/r/LocalLLaMA/hot.json?limit=1', {
        headers: { 'user-agent': UA },
      })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
