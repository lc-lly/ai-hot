import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseFeed, rssAdapter } from '../../src/sources/rss.js'
import { DEFAULT_AI_KEYWORDS, passesTitleFilter } from '../../src/sources/keywords.js'
import type { FetchContext } from '../../src/sources/types.js'

const xml = readFileSync(new URL('../fixtures/rss-feed.xml', import.meta.url), 'utf8')
const feed = { name: 'example', url: 'https://example.com/feed', lang: 'zh' }

describe('parseFeed', () => {
  it('解析出全部条目', async () => {
    expect(await parseFeed(xml, feed)).toHaveLength(2)
  })

  it('externalId 用 feed 名 + guid，避免不同源撞号', async () => {
    const items = await parseFeed(xml, feed)
    expect(items[0]?.externalId).toBe('rss:example:post-1001')
  })

  it('描述里的 HTML 被清掉、实体被解码', async () => {
    const items = await parseFeed(xml, feed)
    expect(items[0]?.summary).toBe('该模型在 SWE-bench 上取得 78% 的成绩 & 引发讨论。')
  })

  it('把 pubDate 转成 Date', async () => {
    const items = await parseFeed(xml, feed)
    expect(items[0]?.publishedAt?.toISOString()).toBe('2026-09-15T00:00:00.000Z')
  })

  it('缺 pubDate 时 publishedAt 为 null，不编造时间', async () => {
    const items = await parseFeed(xml, feed)
    expect(items[1]?.publishedAt).toBeNull()
  })

  it('取自 dc:creator 的作者', async () => {
    const items = await parseFeed(xml, feed)
    expect(items[0]?.author).toBe('张三')
  })

  it('lang 取自 feed 配置', async () => {
    const items = await parseFeed(xml, feed)
    expect(items[0]?.lang).toBe('zh')
  })

  it('feed 未配 lang 时为 null', async () => {
    const items = await parseFeed(xml, { name: 'example', url: 'https://example.com/feed' })
    expect(items[0]?.lang).toBeNull()
  })

  it('空 feed 返回空数组', async () => {
    const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>'
    expect(await parseFeed(empty, feed)).toEqual([])
  })
})

describe('rssAdapter.fetch', () => {
  const okFetch = (() => Promise.resolve(new Response(xml, { status: 200 }))) as unknown as typeof globalThis.fetch

  const ctx = (config: Record<string, unknown>): FetchContext => ({
    sourceId: 'src-rss',
    config,
    fetch: okFetch,
    now: new Date('2026-09-15T00:00:00Z'),
  })

  it('未配置 feeds 时返回空数组', async () => {
    expect(await rssAdapter.fetch(ctx({}))).toEqual([])
  })

  it('逐个抓取配置的 feed 并合并结果', async () => {
    const seen: string[] = []
    const spy = ((url: string) => {
      seen.push(url)
      return Promise.resolve(new Response(xml, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    const out = await rssAdapter.fetch({
      ...ctx({ feeds: [
        { name: 'a', url: 'https://a.com/feed' },
        { name: 'b', url: 'https://b.com/feed' },
      ] }),
      fetch: spy,
    })
    expect(seen).toEqual(['https://a.com/feed', 'https://b.com/feed'])
    expect(out).toHaveLength(4)
  })

  it('单个 feed 失败不影响其余', async () => {
    const spy = ((url: string) => {
      if (url.includes('bad')) return Promise.resolve(new Response('x', { status: 500 }))
      return Promise.resolve(new Response(xml, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    const out = await rssAdapter.fetch({
      ...ctx({ feeds: [
        { name: 'bad', url: 'https://bad.com/feed' },
        { name: 'good', url: 'https://good.com/feed' },
      ] }),
      fetch: spy,
    })
    expect(out).toHaveLength(2)
  })

  it('XML 格式非法时跳过该 feed 而不是崩掉', async () => {
    const spy = ((url: string) => {
      if (url.includes('broken')) return Promise.resolve(new Response('<<<not xml', { status: 200 }))
      return Promise.resolve(new Response(xml, { status: 200 }))
    }) as unknown as typeof globalThis.fetch
    const out = await rssAdapter.fetch({
      ...ctx({ feeds: [
        { name: 'broken', url: 'https://broken.com/feed' },
        { name: 'good', url: 'https://good.com/feed' },
      ] }),
      fetch: spy,
    })
    expect(out).toHaveLength(2)
  })

  it('全部 feed 失败时抛错', async () => {
    const bad = (() => Promise.resolve(new Response('x', { status: 500 }))) as unknown as typeof globalThis.fetch
    await expect(
      rssAdapter.fetch({ ...ctx({ feeds: [{ name: 'a', url: 'https://a.com/feed' }] }), fetch: bad }),
    ).rejects.toThrow(/500/)
  })
})

/**
 * 按需白名单（`readOptInKeywords`）。
 *
 * 起因：用户报《地球正变得不那么扁平》出现在雷达盘上。原因是**订阅源默认
 * 一条都不过滤**——那是刻意的（订阅源是用户自己挑的），但 Solidot 奇客
 * 是综合科技源，需要单独开白名单。
 *
 * 这一组测试的首要目的不是「过滤生效」，而是**锁住默认不过滤**：
 * 默认值反过来会让 Latent Space 那类 AI 专源静默掉一大半真 AI 新闻
 * （实测见 `keywords.ts` 的 `readOptInKeywords`）。
 */
describe('rssAdapter.fetch：按需白名单', () => {
  const mixed = readFileSync(new URL('../fixtures/rss-solidot-mixed.xml', import.meta.url), 'utf8')
  const mixedCtx = (config: Record<string, unknown>): FetchContext => ({
    sourceId: 'src-solidot',
    config: { feeds: [{ name: 'Solidot', url: 'https://solidot.org/index.rss' }], ...config },
    fetch: (() => Promise.resolve(new Response(mixed, { status: 200 }))) as unknown as typeof globalThis.fetch,
    now: new Date('2026-09-17T00:00:00Z'),
  })

  const titlesOf = async (config: Record<string, unknown>) =>
    (await rssAdapter.fetch(mixedCtx(config))).map((i) => i.title)

  it('没配 keywords = 不过滤，四条全收（默认行为，别改）', async () => {
    // 这个默认值是为了保护 Latent Space / Simon Willison 那类 AI 专源。
    // 若哪天有人把它改成「默认用 AI 词表」，这条会挂，且症状是
    // 「订阅源少了很多内容」——静默、难查，所以在这里钉死
    expect(await titlesOf({})).toHaveLength(4)
  })

  it("keywords: 'default' 用共享词表：与 AI 无关的挡在门外", async () => {
    const titles = await titlesOf({ keywords: 'default' })
    // 用户报的那条
    expect(titles).not.toContain('地球正变得不那么扁平')
    // 标题命中 `ai` 的留下
    expect(titles).toContain('微信蠕虫事件敲响 AI 安全警钟')
  })

  it('只看标题 —— 摘要里提了 AI 也留不住（RSS 的 summary 常是全文）', async () => {
    // 《青藏高原升温与加州的洪水相关》的摘要里明确写了「用 AI 模型分析了…」。
    // 看摘要就会把气象新闻放进来，而且 RSS 的 summary 常常就是**全文**，
    // 正文里提一次 AI 的概率比榜单源高得多
    const titles = await titlesOf({ keywords: 'default' })
    expect(titles).not.toContain('青藏高原升温与加州的洪水相关')
  })

  it('《…归咎于 ChatGPT》不再被误杀 —— 词表里补了厂商名', async () => {
    // 这条**曾经**是白名单的误杀：`ChatGPT` 里没有 `ai` 这个词元，而 `ai`
    // 带字母数字边界（边界用于防 `said` 被当成 `ai`），所以命中不了。
    // 修法是往词表补 `chatgpt`，不是去掉边界——去掉会让 `ai` 命中 `said`
    const titles = await titlesOf({ keywords: 'default' })
    expect(titles).toContain('律师在谋杀案中捏造了证词，他将此归咎于 ChatGPT')
    // 同批补进来的还有 openai
    expect(passesTitleFilter('OpenAI 发布新模型', DEFAULT_AI_KEYWORDS)).toBe(true)
  })

  it('补厂商名没有把词表变模糊：无关标题照旧不命中', async () => {
    // 这条是防「为了让 ChatGPT 命中而把规则放宽」的回归。
    // 放宽边界的话下面这几个会开始命中，而它们与 AI 毫无关系
    for (const t of ['Teams 会议纪要', 'Openbook 阅读器发布', 'AI 是 said 的一部分吗']) {
      if (t.includes('AI ')) continue // 这条本来就该命中，跳过
      expect(passesTitleFilter(t, DEFAULT_AI_KEYWORDS)).toBe(false)
    }
    // 边界仍然生效：`chatgpt` 不该命中含它的更长单词
    expect(passesTitleFilter('chatgptx', DEFAULT_AI_KEYWORDS)).toBe(false)
  })

  it('显式配词表就按词表来', async () => {
    // 用「洪水」而不是「气象」：**「气象」只出现在摘要里**，标题里没有，
    // 配上它筛出 0 条。写这条测试时我自己先踩了这个坑（拿摘要里的词去配
    // 只看标题的过滤器），正好说明只看标题这条规则有多容易违反
    expect(await titlesOf({ keywords: ['洪水'] })).toEqual(['青藏高原升温与加州的洪水相关'])
  })

  it('显式配空数组 = 不过滤（与「没配」同义，但仍要能表达）', async () => {
    expect(await titlesOf({ keywords: [] })).toHaveLength(4)
  })

  it('keywords 是乱七八糟的类型时按不过滤处理，不抛错', async () => {
    // config 来自数据库的 JSON，历史数据里什么都可能有
    expect(await titlesOf({ keywords: 42 })).toHaveLength(4)
    expect(await titlesOf({ keywords: null })).toHaveLength(4)
    expect(await titlesOf({ keywords: ['', '  '] })).toHaveLength(4)
  })
})
