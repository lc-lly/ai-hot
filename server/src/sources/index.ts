import { baiduHotAdapter } from './baidu-hot.js'
import { bilibiliAdapter } from './bilibili.js'
import { bilibiliSearchAdapter } from './bilibili-search.js'
import { bingSearchAdapter } from './bing-search.js'
import { githubSearchAdapter } from './github-search.js'
import { githubTrendingAdapter } from './github-trending.js'
import { hackernewsAdapter } from './hackernews.js'
import { hnAlgoliaAdapter } from './hn-algolia.js'
import { redditAdapter } from './reddit.js'
import { redditSearchAdapter } from './reddit-search.js'
import { registerAdapter } from './registry.js'
import { rssAdapter } from './rss.js'
import { sogouWeixinAdapter } from './sogou-weixin.js'

/**
 * 注册全部内置数据源。重复调用是安全的（registry 会抛 duplicate，这里先判空）。
 *
 * 十二个适配器分两组（与 `routes/topics.ts` 的 `SOURCE_KINDS` 白名单、
 * 前端的 `SOURCE_KINDS` 一一对应）：
 *
 * - **采集类** `hackernews` / `github-trending` / `reddit` / `rss` /
 *   `bilibili` / `baidu-hot`：
 *   配置里没有 query，`collect` 每 15 分钟跑一轮，是信息流的常驻来源。
 * - **搜索类** `hn-algolia` / `reddit-search` / `github-search` /
 *   `bilibili-search` / `sogou-weixin` / `bing-search`：
 *   靠 `config.query` 驱动，**没有 query 就返回空数组**。
 *   它们在同一个 registry 里，所以 `collect` 也会遍历到它们——
 *   这一点必须靠适配器自己守住（见 `sources/query.ts`），
 *   否则每一轮采集都会往站外打一次空查询。
 *
 * 搜索类那份名单**在 `routes/search.ts` 里还有一份**（`SEARCH_KINDS`），
 * 两处必须一起改，只改一处的结果是「适配器注册了但搜索 Tab 永远搜不到」。
 */
export function registerBuiltinAdapters(): void {
  for (const adapter of [
    hackernewsAdapter,
    githubTrendingAdapter,
    redditAdapter,
    rssAdapter,
    bilibiliAdapter,
    baiduHotAdapter,
    hnAlgoliaAdapter,
    redditSearchAdapter,
    githubSearchAdapter,
    bilibiliSearchAdapter,
    sogouWeixinAdapter,
    bingSearchAdapter,
  ]) {
    try {
      registerAdapter(adapter)
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('duplicate')) throw e
    }
  }
}
