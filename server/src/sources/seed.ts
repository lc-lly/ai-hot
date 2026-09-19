/**
 * 默认数据源种子。
 *
 * **本模块是幂等的。** 唯一键用 schema 里已有的 `@@unique([kind, name])`
 * （Prisma 里的复合唯一输入叫 `kind_name`），全部走 `prisma.source.upsert`，
 * 因此每次进程启动都调用它也不会产生重复行，反复调用结果一致。
 *
 * **为什么 `update: {}`：** `Source.config` 是**运行期、用户可改**的配置
 * （前端与 API 都能改，见 `routes/sources.ts`）。种子的职责只有一个——
 * 「把缺失的源补上」，绝不能拿代码里的默认值去覆盖用户已经改过的 config，
 * 否则每次重启都会把用户的自定义配置悄悄回滚成默认值。
 * 同理，`name` / `enabled` / `weight` 也只在 `create` 里给：
 * 用户手动禁用过的源不应该被启动流程重新打开。
 * 空对象的 `update` 在 Prisma 里是合法的 no-op（仍然会执行那条 UPDATE/或直接跳过），
 * 语义上明确表达「已存在的行我一个字都不动」。
 */
import type { PrismaClient } from '@prisma/client'

export interface SeedResult {
  /** 本次新建的源数量 */
  created: number
  /** 本次已存在、被原样保留（配置未被覆盖）的源数量 */
  existing: number
}

interface SeedSource {
  kind: string
  /** 人类可读，会直接显示在前端卡片上 */
  name: string
  /**
   * adapter 私有配置，**字段名来自各 adapter 的实现**，不是猜的：
   * - `hackernews`        { limit?: number }                                   默认 60
   * - `github-trending`   { since?: string; language?: string }                默认 since='daily'、无语言
   * - `reddit`            { subreddits?: string[]; limit?: number }            默认 ['LocalLLaMA','MachineLearning']、25
   * - `rss`               { feeds: Array<{ name: string; url: string; lang?: string }>; keywords?: 'default' | string[] }
   *                       关键词是**按需**的：不配就全收（订阅源默认都想要）；
   *                       配 `'default'` 用共享 AI 词表，配数组用给定词。见 `readOptInKeywords`
   * - `bilibili`          { ps?: number; keywords?: string[] }                  默认 50 条、关键词用 `DEFAULT_AI_KEYWORDS`
   * - `baidu-hot`         { tab?: string; keywords?: string[] }                 默认 tab='realtime'、同上
   * - `bilibili-search`   { limit?: number }                                   搜索词来自查询，不来自这里
   * - `sogou-weixin`      { limit?: number }                                   同上
   * - `bing-search`       { limit?: number }                                   同上
   *
   * 所有源都还认一个公共字段 `engagement: { likes?, reposts?, views? }`，
   * 用于逐源覆盖互动阈值（见 `pipeline/engagement.ts`）。不配就用默认的
   * 「点赞>10 且 转发>5 且 浏览>500」。
   *
   * **`keywords` 不配 ≠ 配成空数组**：不配用内置的 AI 词表，配成 `[]` 是
   * 「不过滤，全收」。前者是默认行为，后者是明确的意图，见 `sources/keywords.ts`。
   */
  config: Record<string, unknown>
  enabled?: boolean
}

/**
 * 默认源清单。
 *
 * 目标都是**真实存在、长期稳定**的公开端点；每一项都在本机实跑验证过
 * （见 `.scratch/verify-sources.mjs` 与 `.scratch/task-adapters-report.md`）。
 */
export const DEFAULT_SOURCES: readonly SeedSource[] = [
  // ---- GitHub 趋势（HTML 抓取，依赖 github.com，本机可达）----
  {
    kind: 'github-trending',
    name: 'GitHub 趋势 · 全语言（每日）',
    config: { since: 'daily' },
  },
  {
    kind: 'github-trending',
    name: 'GitHub 趋势 · Python（每日）',
    config: { language: 'python', since: 'daily' },
  },

  // ---- RSS / Atom ----
  {
    kind: 'rss',
    name: 'RSS · Google AI 博客',
    config: { feeds: [{ name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', lang: 'en' }] },
  },
  {
    kind: 'rss',
    name: 'RSS · Simon Willison',
    config: { feeds: [{ name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', lang: 'en' }] },
  },
  {
    kind: 'rss',
    name: 'RSS · Latent Space',
    config: { feeds: [{ name: 'Latent Space', url: 'https://www.latent.space/feed', lang: 'en' }] },
  },
  {
    kind: 'rss',
    name: 'RSS · InfoQ 中文',
    config: { feeds: [{ name: 'InfoQ 中文', url: 'https://www.infoq.cn/feed', lang: 'zh' }] },
  },
  {
    // Solidot 奇客是这批订阅源里**唯一一个综合科技源**（其余四个都是 AI 专源），
    // 实测它会发气象、电动汽车、人口这类与 AI 无关的内容。所以给它单独开白名单：
    // `'default'` 表示用共享的 `DEFAULT_AI_KEYWORDS`，而不是在这里抄一份词表
    // （抄一份就有两份口径，必然漂移）。见 `sources/keywords.ts` 的 `readOptInKeywords`。
    kind: 'rss',
    name: 'RSS · Solidot 奇客',
    config: {
      feeds: [{ name: 'Solidot', url: 'https://www.solidot.org/index.rss', lang: 'zh' }],
      keywords: 'default',
    },
  },

  // ---- 国内平台 ----
  //
  // 这两个是**榜单类**：B站 综合热门榜、百度热搜榜。入库前会过一遍
  // `DEFAULT_AI_KEYWORDS`（见 `sources/keywords.ts`）——榜单是全站热门，
  // AI 相关内容占比很低（实测百度热搜 51 条里只有 3 条相关），
  // 不过滤的话雷达盘会被社会新闻淹没。
  //
  // `keywords` 一律不写：留给适配器用内置词表，词表更新时这两个源自动跟上。
  {
    kind: 'bilibili',
    name: 'B站 · 综合热门',
    config: { ps: 50 },
  },
  {
    kind: 'baidu-hot',
    name: '百度 · 热搜榜',
    config: { tab: 'realtime' },
  },

  // ---- 搜索类：只登记「名字」，不参与定时采集 ----
  //
  // 这三个是搜索类，靠用户输入的查询词驱动，**没有 query 就返回空数组**。
  // 之所以还是给它们建行，是因为 `routes/search.ts` 会用
  // `prisma.source.findFirst({ where: { kind } })` 查名字来填卡片的
  // 「来自哪里」——查不到就退化显示原始 kind，卡片上会出现
  // 「sogou-weixin」这种给机器看的字符串。
  //
  // `enabled: false` 是**故意的**：`collect` 只遍历 `enabled: true` 的源，
  // 关掉它们就不会每 15 分钟产生一条「抓到 0 条」的日志噪音。
  // 它们照样能被搜索路由用到——那个查询不看 enabled。
  {
    kind: 'bilibili-search',
    name: 'B站 · 视频搜索',
    config: {},
    enabled: false,
  },
  {
    kind: 'sogou-weixin',
    name: '搜狗 · 微信文章',
    config: {},
    enabled: false,
  },
  {
    kind: 'bing-search',
    name: 'Bing · 网页搜索',
    config: {},
    enabled: false,
  },

  // ---- Reddit ----
  // 配置本身是对的（字段名与 reddit.ts 的读取方式一致），但**本机网络到不了 reddit**：
  // www/old/oauth/api.reddit.com 解析到 157.240.7.20（Meta 段）与 2001::1，
  // 典型 DNS 污染，TCP 连接 10s 超时。留着启用只会在每轮 collect 里稳定报错、
  // 把源健康面板刷成红的，所以默认 `enabled: false`——
  // 换到能直连 reddit 的网络后，把这一行改成 true（或在前端启用）即可，配置不用动。
  {
    kind: 'reddit',
    name: 'Reddit · AI 版块',
    config: { subreddits: ['LocalLLaMA', 'MachineLearning', 'OpenAI'], limit: 25 },
    enabled: false,
  },
]

/**
 * 幂等地写入默认数据源。失败会向调用方抛出，由调用方决定是否影响启动。
 */
export async function seedDefaultSources(prisma: PrismaClient): Promise<SeedResult> {
  // 一次查出所有已存在的 (kind, name)，避免 N 次额外查询。
  // upsert 本身才是写入路径，这里的读只用于统计 created/existing。
  const existingRows = await prisma.source.findMany({
    where: { OR: DEFAULT_SOURCES.map((s) => ({ kind: s.kind, name: s.name })) },
    select: { kind: true, name: true },
  })
  const seen = new Set(existingRows.map((r) => `${r.kind} ${r.name}`))

  let created = 0
  let existing = 0

  for (const source of DEFAULT_SOURCES) {
    await prisma.source.upsert({
      where: { kind_name: { kind: source.kind, name: source.name } },
      // 已存在则一个字都不改（见文件头说明）
      update: {},
      create: {
        kind: source.kind,
        name: source.name,
        config: JSON.stringify(source.config),
        enabled: source.enabled ?? true,
      },
    })

    if (seen.has(`${source.kind} ${source.name}`)) existing += 1
    else created += 1
  }

  return { created, existing }
}
