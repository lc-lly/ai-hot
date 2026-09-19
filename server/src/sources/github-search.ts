import { readQuery } from './query.js'
import { truncate } from '../util/text.js'
import type { FetchContext, RawItem, SourceAdapter } from './types.js'

/**
 * GitHub 仓库搜索 —— **搜索类**适配器，不参与定时采集。
 *
 * ## 免 key，但有限流
 *
 * 官方对**未认证**请求给 10 次/分钟（认证后 30 次）。搜索类适配器只在
 * 用户主动搜索时才跑，一分钟内不会打十次，所以不引入 token。
 * 真被限流了会拿到 403，适配器如实抛出，前端显示成一条失败提示——
 * 比静默返回空列表好：用户会以为「GitHub 上没有这个东西」。
 *
 * ## `publishedAt` 用 `pushed_at` 而不是 `created_at`
 *
 * 仓库的「新鲜度」看的是最近一次有动静，不是建仓时间。用 `created_at`
 * 的话，一个 2019 年建、这周突然涨星的仓库会被 `score/crosscheck.ts` 的
 * `ageHours` 判成「陈旧」——而它恰恰是此刻最热的东西。
 */

const ENDPOINT = 'https://api.github.com/search/repositories'
const DEFAULT_PER_PAGE = 30

interface RepoItem {
  id?: number
  full_name?: string
  html_url?: string
  description?: string | null
  created_at?: string
  pushed_at?: string
  stargazers_count?: number
  forks_count?: number
  language?: string | null
  owner?: { login?: string } | null
  archived?: boolean
  fork?: boolean
}

/** 解析 `/search/repositories` 的 `items`。结构不符返回空数组。 */
export function parseRepos(payload: unknown, query: string): RawItem[] {
  const items = (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []

  const out: RawItem[] = []
  for (const raw of items) {
    const repo = raw as RepoItem
    if (typeof repo.id !== 'number' || typeof repo.full_name !== 'string') continue
    if (repo.html_url === undefined) continue
    // 归档仓库与 fork 不是「新热点」，它们出现在搜索结果里只会挤掉真正相关的
    if (repo.archived === true || repo.fork === true) continue

    const description = (repo.description ?? '').trim()

    out.push({
      externalId: `gh:${String(repo.id)}`,
      url: repo.html_url,
      title: repo.full_name,
      summary: description === '' ? null : truncate(description, 400),
      author: repo.owner?.login ?? null,
      publishedAt: parseDate(repo.pushed_at) ?? parseDate(repo.created_at),
      lang: repo.language ?? null,
      // 字段名与 `github-trending.ts` 对齐，好让 `score/heat.ts` 与
      // `score/metrics.ts` 复用同一套取数逻辑（搜到的是 stars 总数，
      // 而 trending 给的是「今日新增」，所以 starsToday 留空、用 stars）
      raw: {
        stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : null,
        forks: typeof repo.forks_count === 'number' ? repo.forks_count : null,
        language: repo.language ?? null,
        query,
      },
    })
  }
  return out
}

function parseDate(value: string | undefined): Date | null {
  if (value === undefined) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export const githubSearchAdapter: SourceAdapter = {
  kind: 'github-search',

  async fetch(ctx: FetchContext): Promise<RawItem[]> {
    const query = readQuery(ctx)
    if (query === null) return []

    const perPage = Number(ctx.config.perPage ?? DEFAULT_PER_PAGE)
    // 用户输入的关键词里可能已经有 `stars:>100` 这类限定符，原样透传，
    // 不要替他把查询改写成别的语义
    const suffix = typeof ctx.config.qualifiers === 'string' ? ctx.config.qualifiers.trim() : ''
    const q = suffix === '' ? query : `${query} ${suffix}`

    const url =
      `${ENDPOINT}?q=${encodeURIComponent(q)}&sort=stars&order=desc` +
      `&per_page=${Math.min(100, Math.max(1, perPage))}`

    const res = await ctx.fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        // 没有 User-Agent 会被 GitHub 直接拒绝
        'user-agent': 'ai-hot/0.1',
        ...(ctx.config.token === undefined
          ? {}
          : { authorization: `Bearer ${String(ctx.config.token)}` }),
      },
    })

    if (res.status === 403 || res.status === 429) {
      throw new Error('github-search 触发限流（未认证请求 10 次/分钟），请稍后再试')
    }
    if (!res.ok) throw new Error(`github-search HTTP ${res.status}`)

    return parseRepos(await res.json(), query)
  },

  async health(ctx: FetchContext) {
    try {
      const res = await ctx.fetch(`${ENDPOINT}?q=test&per_page=1`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'ai-hot/0.1' },
      })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  },
}
