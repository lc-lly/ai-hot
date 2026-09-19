import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import { HttpError } from '../errors.js'
import { checkEngagement, DEFAULT_ENGAGEMENT_THRESHOLDS } from '../pipeline/engagement.js'
import type { ItemDTO } from '../score/types.js'
import { toItemDTO } from '../score/dto.js'
import { getAdapter } from '../sources/registry.js'
import type { RawItem, SourceAdapter } from '../sources/types.js'

/**
 * 站外搜索（阶段 4.2）。
 *
 * ```
 * GET /api/search?q=langchain&kinds=hn-algolia,reddit-search,github-search
 * ```
 *
 * ## 和 `/api/items?q=` 是两件事，不要合并
 *
 * | | `/api/items?q=` | `/api/search?q=` |
 * |---|---|---|
 * | 搜什么 | 库里**已经抓到的**内容 | 站外**此刻的**结果 |
 * | 落库 | 本来就是库里的 | **不落库**（见下） |
 * | 带 AI 结论 | 有（真伪、相关度） | 没有（还没评过） |
 *
 * 两条都保留：库里那批带 AI 结论，是站外搜索给不了的；站外那批能搜到
 * 我们从没抓过的东西（比如刚发布三小时的仓库）。界面上让用户自己选。
 *
 * ## 为什么**不**落库
 *
 * 走 `pipeline/ingest.ts` 落库看着很诱人（能复用规范化 + 去重），但会带来
 * 两个后果：一是用户随手搜的每个词都会变成 `HotItem` 永久留在信息流里，
 * 二是搜索类 `Source` 得有它自己的行。搜索是**一次性的查询**，不是订阅。
 * 用户想订阅就该去建一个监控词——那才是 `Topic` 存在的意义。
 *
 * 代价是搜索结果没有 `authenticity` / `match`。这是如实反映，不是缺陷：
 * 卡片上那几个位置本来就该显示「未评估」，而不是显示一个假的 0。
 *
 * ## 缓存
 *
 * 六个站外源里有四个是有限流/风控的：GitHub 未认证 10 次/分钟、
 * **B站 连打第二次就 412**、搜狗和百度会弹验证码。同一个查询 60 秒内
 * 重复打会直接命中缓存——用户改一下筛选条件、返回上一页都会重新请求，
 * 不缓存的话很快就撞上限流，而且国内这几个源被拦之后恢复得比 GitHub 慢。
 */

/**
 * 搜索类源的**第二份名单**——`sources/index.ts` 里还有一份（`registerBuiltinAdapters`）。
 *
 * 两处必须一起改。只注册不登记在这里，表现是「适配器明明存在，搜索 Tab 里
 * 却永远搜不到」；只登记在这里没注册，请求会走到 `getAdapter` 抛错那条分支、
 * 每个源都回一条「适配器未注册」。两个症状都不明显指向这份名单。
 */
const SEARCH_KINDS = [
  'hn-algolia',
  'reddit-search',
  'github-search',
  'bilibili-search',
  'sogou-weixin',
  'bing-search',
] as const
type SearchKind = (typeof SEARCH_KINDS)[number]

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 50

/**
 * 单个源的时间上限。
 *
 * 三个源是并发跑的，所以整个请求的耗时等于**最慢那个源**的耗时。一个
 * 连不上的源不会失败得干脆——undici 默认的 TCP 连接超时是 10 秒，于是
 * 另外两个源 1.4 秒就回来了，用户却要干等 10.6 秒，为了一个注定交不出
 * 结果的源。
 *
 * 5 秒是量出来的：本机 HN 964ms、GitHub 1411ms，留了 3.5 倍余量给网络
 * 抖动。再短会误杀慢但正常的源，再长就等于没设。
 */
const DEFAULT_SOURCE_TIMEOUT_MS = 5_000

/**
 * 网络层错误码 → 人话。
 *
 * **原始错误码一律保留在文案里**（`连接超时（UND_ERR_CONNECT_TIMEOUT）`）。
 * 翻译成中文是为了让用户一眼看懂，但被墙、被限流、DNS 污染这几件事的处置
 * 方式完全不同，用户得能拿着原文去查。只给中文等于把信息抹掉了一层。
 */
const CAUSE_LABELS: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '响应超时',
  UND_ERR_BODY_TIMEOUT: '响应超时',
  ETIMEDOUT: '连接超时',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: '域名解析失败',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  EHOSTUNREACH: '网络不可达',
  ENETUNREACH: '网络不可达',
  CERT_HAS_EXPIRED: '证书已过期',
}

/** 从 `Error.cause.code` 里取错误码；没有就返回 null。 */
function causeCodeOf(e: unknown): string | null {
  if (!(e instanceof Error)) return null
  const cause = e.cause
  if (cause === null || typeof cause !== 'object' || !('code' in cause)) return null
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * 把任意抛出物变成一句能读的话。
 *
 * ## 为什么不能直接用 `e.message`
 *
 * undici 把**所有**连接层失败都统一措辞成 `fetch failed`——连不上、DNS 查
 * 不到、证书过期、被墙，全是这四个字，真正的原因藏在 `e.cause.code` 里。
 * 原样透出去的话，用户在这个源的徽章上看到的提示就是「fetch failed」，
 * 既不知道是超时还是被墙，也不知道该不该重试——**等于没报**。
 * 这台机器上实测就是这个情况：徽章显示「fetch failed」，真实原因是
 * 连接超时。
 *
 * 适配器自己抛的错（`reddit-search HTTP 429`）没有 `cause`，原样返回，
 * 那种文案本来就是清楚的。
 */
function describeError(e: unknown, timeoutMs: number): string {
  if (!(e instanceof Error)) return String(e)

  // 我们自己那道闸门拉闸时抛的是 DOMException，不是网络层的错。
  // 报的是**这一轮真实用的**时限，不是那个默认常量——测试会把闸门调短，
  // 文案跟着写死的话就成了「超过 5000ms 未响应」，而实际只等了 150ms。
  if (e.name === 'TimeoutError' || e.name === 'AbortError') {
    return `超时（超过 ${timeoutMs}ms 未响应）`
  }

  const code = causeCodeOf(e)
  if (code === null) return e.message

  const label = CAUSE_LABELS[code]
  if (label === undefined) return `${e.message}（${code}）`
  return e.message === 'fetch failed' ? `${label}（${code}）` : `${e.message}：${label}（${code}）`
}

/**
 * 给注入的 fetch 套一个总时限。
 *
 * 在这里包而不是改每个适配器：适配器只认得 `ctx.fetch`，包住注入点就一网
 * 打尽，而且**测试里传进来的假 fetch 也一并受管**——不然「一个源挂死不拖
 * 累整体」这条行为在生产代码里对、在测试里测不到。
 *
 * 断的不只是等：`AbortSignal` 会真的把底层连接掐掉。单纯 `Promise.race`
 * 让请求「看起来」结束了，socket 仍在后台往一个连不上的地址重试。
 */
function withDeadline(fetchImpl: typeof globalThis.fetch, ms: number): typeof globalThis.fetch {
  // 参数类型从被包装的函数上取，不手写 `RequestInfo`——这个包的 tsconfig
  // 只带 node 类型、没有 DOM lib，那个名字根本不存在
  return ((input: Parameters<typeof fetchImpl>[0], init?: RequestInit) => {
    const deadline = AbortSignal.timeout(ms)
    const own = init?.signal ?? null
    // 适配器自己带了 signal 就合并，不要覆盖掉它的取消意图
    const signal = own === null ? deadline : AbortSignal.any([own, deadline])
    return fetchImpl(input, { ...init, signal })
  }) as typeof globalThis.fetch
}

export interface SearchSourceReport {
  kind: string
  ok: boolean
  /** 过滤之后真正返回给前端的条数 */
  count: number
  /** 被互动阈值挡掉的条数，见 `pipeline/engagement.ts`。恒为 0 的源居多 */
  filtered: number
  ms: number
  error: string | null
}

interface CacheEntry {
  at: number
  results: ItemDTO[]
  sources: SearchSourceReport[]
}

const cache = new Map<string, CacheEntry>()

function cacheGet(key: string, now: number): CacheEntry | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit
}

function cacheSet(key: string, entry: CacheEntry): void {
  // 简单的 FIFO 淘汰。搜索词是无限的，不设上限就是一个内存泄漏。
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, entry)
}

/** 只做测试用，别在业务代码里调。 */
export function __clearSearchCache(): void {
  cache.clear()
}

function parseKinds(raw: unknown): SearchKind[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [...SEARCH_KINDS]
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const out: SearchKind[] = []
  for (const kind of requested) {
    if ((SEARCH_KINDS as readonly string[]).includes(kind) && !out.includes(kind as SearchKind)) {
      out.push(kind as SearchKind)
    }
  }
  return out
}

/**
 * 把一条 `RawItem` 组装成 `ItemDTO`。
 *
 * `id` 用 `externalId`——搜索结果的 `id` 只服务于 React 的 key 和「已读」这类
 * 前端本地状态，**不能**用数据库 id，因为它压根没有数据库行。
 * 加 `search:` 前缀是为了让前端一眼能看出「这条是临时的，刷新就没了」。
 */
function toSearchDTO(raw: RawItem, kind: string, sourceName: string, now: Date): ItemDTO {
  return toItemDTO({
    id: `search:${raw.externalId}`,
    title: raw.title,
    url: raw.url,
    summary: raw.summary,
    author: raw.author,
    lang: raw.lang,
    publishedAt: raw.publishedAt,
    fetchedAt: now,
    // 从来没被 AI 评过。三态渲染要靠这三个 null 而不是 0——
    // 显示 authenticity=0 会被读成「AI 认定这是假的」。
    aiState: 'pending',
    authenticity: null,
    aiFlags: '[]',
    aiReasoning: null,
    raw: raw.raw,
    source: { name: sourceName, kind },
    clusterId: null,
    matches: null,
  })
}

async function runOne(
  kind: SearchKind,
  adapter: SourceAdapter,
  query: string,
  prisma: PrismaClient,
  now: Date,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<{ report: SearchSourceReport; results: ItemDTO[] }> {
  const startedAt = Date.now()
  try {
    // 搜索类的源不一定要预先登记在 Source 表里，但登记了就用它的名字，
    // 卡片上「来自哪里」才不会是空的
    const row = await prisma.source.findFirst({ where: { kind }, select: { name: true } })
    const items = await adapter.fetch({
      sourceId: `search:${kind}`,
      config: { query, limit: DEFAULT_LIMIT },
      fetch: fetchImpl,
      now,
    })

    // 互动阈值闸门。搜索结果**不落库**（见文件头「为什么不落库」），
    // 所以 `pipeline/ingest.ts` 里那道闸门管不到这里——但用户要的过滤
    // 必须在这里也生效，否则 B站 搜索那堆「播放几百、点赞个位数」的
    // 标题党照旧会出现。两处用的是同一个纯函数。
    //
    // 这里**用默认阈值**，不读 `Source.config.engagement`：搜索是用户当场
    // 发起的一次性查询，而且搜索类源往往压根没有 `Source` 行（上面那行
    // `findFirst` 就允许查不到）。要让搜索也用上自定义阈值，得先有地方配它。
    const accepted = items.filter(
      (item) => checkEngagement(kind, item.raw, DEFAULT_ENGAGEMENT_THRESHOLDS) === null,
    )

    return {
      report: {
        kind,
        ok: true,
        count: accepted.length,
        filtered: items.length - accepted.length,
        ms: Date.now() - startedAt,
        error: null,
      },
      results: accepted.map((item) => toSearchDTO(item, kind, row?.name ?? kind, now)),
    }
  } catch (e) {
    // 一个源挂了不该让整个搜索失败：另外两个源的结果仍然有价值。
    // 但**必须**在响应里说明哪个源失败了，否则用户会以为「全网只有这三条」。
    return {
      report: {
        kind,
        ok: false,
        count: 0,
        filtered: 0,
        ms: Date.now() - startedAt,
        error: describeError(e, timeoutMs),
      },
      results: [],
    }
  }
}

export interface SearchRoutesDeps {
  prisma: PrismaClient
  /**
   * 注入 fetch，测试传假实现。**默认才用 `globalThis.fetch`**——
   * 直接写死全局的话这个端点就没法在不联网的情况下测，
   * 而它恰恰是最需要测的一个（三个外部 API、限流、部分失败）。
   */
  fetch?: typeof globalThis.fetch
  /**
   * 单个源的时间上限。**只在测试里调小**——真实的 5 秒闸门测起来要等 5 秒，
   * 而「一个源挂死不能拖累整体」这条行为恰恰是最需要测的。
   */
  sourceTimeoutMs?: number
}

export function searchRoutes(deps: SearchRoutesDeps): Router {
  const router = Router()
  const { prisma } = deps
  const timeoutMs = deps.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS
  const fetchImpl = withDeadline(deps.fetch ?? globalThis.fetch, timeoutMs)

  router.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q === '') {
      throw new HttpError(400, 'BAD_REQUEST', '缺少查询词 q')
    }
    if (q.length > 120) {
      throw new HttpError(400, 'BAD_REQUEST', '查询词最长 120 字')
    }

    const kinds = parseKinds(req.query.kinds)
    if (kinds.length === 0) {
      throw new HttpError(400, 'BAD_REQUEST', `kinds 只能是 ${SEARCH_KINDS.join(' / ')} 的子集`)
    }

    const rawLimit = Number(req.query.limit)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIMIT

    const now = new Date()
    const key = `${q}|${kinds.join(',')}`
    const cached = cacheGet(key, now.getTime())
    if (cached) {
      res.json(envelope(cached.results, cached.sources, q, limit, true))
      return
    }

    const settled = await Promise.all(
      kinds.map(async (kind): Promise<{ report: SearchSourceReport; results: ItemDTO[] }> => {
        let adapter: SourceAdapter
        try {
          adapter = getAdapter(kind)
        } catch {
          return {
            report: {
              kind,
              ok: false,
              count: 0,
              filtered: 0,
              ms: 0,
              error: '适配器未注册（服务端启动时 registerBuiltinAdapters 没跑？）',
            },
            results: [],
          }
        }
        return runOne(kind, adapter, q, prisma, now, fetchImpl, timeoutMs)
      }),
    )

    const sources = settled.map((s) => s.report)
    const results = dedupeByUrl(settled.flatMap((s) => s.results))
    // 热度降序。**必须带 url 作 tiebreaker**：`HEAT_FALLBACK` 让同一批
    // 无互动数据的条目同分，而 `Array.prototype.sort` 在 V8 上虽然稳定，
    // 但稳定只保证「不重排」，不保证用户看到的是一个有意义的次序。
    results.sort((a, b) => b.heat - a.heat || a.url.localeCompare(b.url))

    cacheSet(key, { at: now.getTime(), results, sources })
    res.json(envelope(results, sources, q, limit, false))
  })

  return router
}

/**
 * 按 URL 去重。**同一条 URL 保留热度最高的那条。**
 *
 * 触发场景是 HN 上同一条链接被反复提交——这在 Algolia 的全文检索里很常见，
 * 而且重复提交里通常有一条是几小时前的（分数低、没评论），一条是此刻在榜的。
 * 不去重的话结果里会出现两条标题不同、点进去同一个页面的条目。
 *
 * **不能「先到先留」**：命中顺序是源返回的顺序（按相关度，不按热度），
 * 先到的完全可能是那条没人理的老帖——于是用户看到一条 3 分的链接，
 * 而真正热的那条被当成重复丢掉了。（红迪那条不会参与这里：它落的是
 * permalink 而不是被链的原站地址，所以跨源碰撞不是真实场景。）
 */
function dedupeByUrl(items: readonly ItemDTO[]): ItemDTO[] {
  const best = new Map<string, ItemDTO>()
  for (const item of items) {
    const key = item.url.trim().toLowerCase()
    const kept = best.get(key)
    if (kept === undefined || item.heat > kept.heat) best.set(key, item)
  }
  return [...best.values()]
}

/**
 * 响应信封与 `/api/items` 对齐（`{data, pagination}`），前端可以复用同一个
 * 归一化函数（`normalizeItems` / `normalizePagination`）。
 *
 * **没有真正的分页**：每个源只给「最相关的 N 条」，三个源合起来最多 3N 条，
 * 再往下翻要去打源站的第二个请求——那既慢又会让限流提前触发。
 * 所以恒返回单页，`total` 就是这一页的真实条数。假装有第 2 页比没有更糟。
 */
function envelope(
  results: readonly ItemDTO[],
  sources: readonly SearchSourceReport[],
  q: string,
  limit: number,
  cached: boolean,
): Record<string, unknown> {
  return {
    data: results,
    pagination: {
      page: 1,
      pageSize: limit,
      total: results.length,
      totalPages: 1,
    },
    q,
    sources,
    cached,
  }
}
