# 信源注册表

> **本文件是信源端点的唯一事实源。** 全部免密钥、全部实测过。
>
> 可达性结论**会变**（CDN、DNS、反爬策略随时调整）。
> 判断某个源此刻能不能用，唯一可靠的办法是跑：
> ```
> py scripts/sources.py health
> ```

## 默认开启（13 个）

| id | 名称 | 形式 | 端点 / 说明 |
|---|---|---|---|
| `bilibili` | B站热门视频 | JSON | `GET https://api.bilibili.com/x/web-interface/popular?ps=N&pn=1` · 取 `data.list[]` · 需浏览器 UA + `referer` |
| `baidu` | 百度热搜 | HTML 内嵌 JSON | `GET https://top.baidu.com/board?tab=realtime` · 数据在注释 `<!--s-data:{…}-->` 里 · 路径 `data.cards[0].content[]` · **无 JSON 接口变体** |
| `juejin` | 掘金推荐 | JSON (POST) | `POST https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed` · 取 `item_type==2` 的文章 |
| `github` | GitHub 仓库搜索 | JSON | `GET https://api.github.com/search/repositories` · 默认 `topic:ai created:>=<30天前>` 按 star 排序 · 无 token 限 **10 次/分钟** |
| `github-trending` | GitHub Trending | HTML | `GET https://github.com/trending?since=daily` · 按 `<article>` 切块解析 · `heat` = 今日新增 star |
| `v2ex` | V2EX 热帖 | JSON | `GET https://www.v2ex.com/api/topics/hot.json` · 顶层数组 |
| `36kr` | 36氪 | RSS | `GET https://www.36kr.com/feed` · **必须带 `www.`** |
| `infoq` | InfoQ 中国 | RSS | `GET https://www.infoq.cn/feed` |
| `sspai` | 少数派 | RSS | `GET https://sspai.com/feed` · 无 `dc:creator`，作者在 `<author>` |
| `ruanyifeng` | 阮一峰的网络日志 | Atom | `GET https://www.ruanyifeng.com/blog/atom.xml` · 周更，条数少 |
| `solidot` | Solidot | RSS | `GET https://www.solidot.org/index.rss` |
| `hn` | Hacker News (Algolia) | JSON | `GET https://hn.algolia.com/api/v1/search?tags=front_page` · 实测大陆直连可通 |
| `lobsters` | Lobsters | JSON | `GET https://lobste.rs/hottest.json` · 实测大陆直连可通 |

后两个英文源**默认开着是有意的**：节假日/周末中文源会被社会新闻占满，
那时 AI 内容基本只剩它俩。AI 内容密度远高于中文热搜。

## 默认关闭（1 个）

用 `--sources <id>` 显式指定，或 `--all-sources`。

| id | 名称 | 状态 |
|---|---|---|
| `reddit` | Reddit r/MachineLearning | **实测 HTTP 403 Blocked**，数据中心 IP 被反爬拦下。需要代理或住宅 IP |

> `--all-sources` 如今等于「13 个默认源 + reddit」，而 reddit 大陆直连必失败 ——
> 所以**基本没有使用它的场景**，点名 `--sources` 更省。

## 明确不支持

这三个没有免密钥可用路径。`sources.py` 会列出它们并给出原因，**不要尝试绕过**：

| 源 | 原因 |
|---|---|
| 知乎热榜 | 需要签名 Cookie（`x-zse`），无免密钥路径 |
| 机器之心 | `/rss` 已失效（302 跳转到 HTML 页面），`/feed` 404 |
| RSSHub (`rsshub.app`) | 站点从大陆整体不可达。**不要基于它构建任何默认源** |

---

## 每个适配器要处理的坑

这些都是实测踩出来的，改代码前先读：

### 请求头

- **默认 UA 会被封。** `Python-urllib/3.x` 会被 GitHub 直接 403，
  被百度/B站判定为爬虫触发风控。注册表里每个源都带真实 Chrome UA。
- **显式发 `Accept-Encoding: identity`。** 若邀请 gzip 就得自己解压；
  更糟的是某些 CDN 会回 Brotli，而 Python 标准库没有 Brotli 解码器。
- **百度/B站需要 `referer`。**

### 「HTTP 200 但内容是错的」

这是最危险的一类失败 —— 它**不报错**，只是静默地没有数据。

- **B站**：HTTP 200 + `{"code": -412}` 是风控拦截。必须抛错。
- **百度**：改版后 `<!--s-data:-->` 注释可能消失。找不到就抛错。
- **36氪**：漏掉 `www.` 时返回 HTML 首页（HTTP 200，`text/html`）。
  所以 RSS 源会校验 `Content-Type` 必须含 `xml`/`rss`/`atom`，
  否则报「期望 XML/RSS，实际 text/html」。
- **掘金**：接口混了文章和「沸点」，必须按 `item_type == 2` 过滤。

**统一规则：结构缺失即报错，绝不返回空数组。**
返回 `[]` 会让这个源静默假死好几天 —— 报错至少能在 `sources.py health` 里看见。

### 日期

- **36氪的 `pubDate` 是 `"2026-10-05 16:36:43  +0800"`**（双空格、无星期），
  `email.utils.parsedate_to_datetime` 会直接抛 `ValueError`。
  `_common.parse_date` 实现了容错解析链：RFC822 → 常见 strptime 格式 → ISO-8601。
- 解析不出来返回 `null`，**不猜、不编造**。
- `publishedAt` 为 `null` 的条目在 `--since` 过滤时**会被保留** ——
  「不知道什么时候发的」不等于「很旧」。百度热搜根本没有时间字段，
  丢掉它们等于把这个源废掉。

### 类型

- **百度热搜的 `hotScore` 是字符串**（`"7981234"`），B站/掘金是 int。
  `_common.as_int` 统一强转，否则 Agent 排序时会拿到混合类型。

### id 稳定性

- 缺 `<guid>` 的 RSS 会退化成用 URL 当 id，
  此时**跟踪参数会被剥掉**（`?f=rss`、`?utm_source=…`）。
  不剥的话，同一条内容每轮都会被判成「新增」，盯盘直接变刷屏。

### `author` 字段：哪些源有，装的是什么

`--author` 靠这个字段工作。**2026-10-06 实测 13 源、每源 limit 20** 的真实构成：

| 源 | 有 `author` 的条数 | 装的是什么 |
|---|---|---|
| `bilibili` | 20/20 | UP主名（`owner.name`） |
| `juejin` | 2/2 | 作者名（`author_user_info.user_name`） |
| `github` | 12/12 | 仓库 owner 的 login（**人也可以是机构**） |
| `github-trending` | 12/12 | 仓库 owner（从 `owner/repo` 里切出来） |
| `v2ex` | 9/9 | 用户名 |
| `infoq` | 20/20 | `作者：<姓名>`（**带「作者：」前缀**） |
| `sspai` | 9/9 | 作者名 |
| `hn` | 20/20 | 提交者用户名 |
| `lobsters` | 20/20 | 提交者用户名 |
| **`baidu`** | **0/20** | 恒为 `null` —— 热搜词条没有作者 |
| **`36kr`** | **0/17** | **恒为 `null`** —— 它的 RSS 不带 `<creator>` |
| **`solidot`** | **0/8** | **恒为 `null`** |

> ⚠️ **不要假设「RSS 源就有作者」。** 实测 36氪 和 Solidot 的 feed 里
> 根本没有 `<creator>`/`<author>`，`author` 恒为 `null`；
> 而 InfoQ 和少数派有。这不是能靠读代码推断的，得实测（上面这张表就是实测的）。

**这三个没有 `author` 的源只能靠信源显示名查** —— `--author` 同时匹配
`REGISTRY[id]["name"]`，所以 `--author 36氪` / `--author Solidot` / `--author 百度`
照样能命中。这也是那个匹配规则存在的**唯一理由**：它们让机构名查询成为可能。
详见 [cli.md](cli.md) 的「过滤」一节。

### GitHub 搜索语法

**不支持限定符之间的 `OR`。** 实测：

| 查询 | 结果 |
|---|---|
| `topic:ai created:>=2026-09-06` | ✅ 10705 条 |
| `topic:ai OR topic:llm created:>=…` | ❌ 422「The search contains only logical operators (AND / OR / NOT) without any search terms」 |
| `(topic:ai OR topic:llm) created:>=…` | ❌ **静默返回 0 条**（比报错更糟，看起来像源挂了） |

所以默认查询是**单个限定符** `topic:ai`。`--query` 传原样 GitHub 搜索语法。

### GitHub Trending 解析

- 必须按 `<article>` 切块再提取，不能在整个页面全局匹配 ——
  否则标题和 star 数会串行错位（第 N 个仓库配上第 M 个 star 数），
  这种错误不报错，只静默产出错数据。
- star 数在 `<svg …></svg>` **之后**、`</a>` 之前，不能假设它紧跟 `>`。
- `heat` 取「今日新增 star」而不是总 star 数：总 star 万级的仓库长期霸榜，
  反映不出「今天什么在涨」。

---

## 加自己的信源

改 `scripts/sources.py` 里的注册表即可，模式是：

```python
def _req_mysite(ctx):
    return (f"https://example.com/api?limit={ctx.limit}", "GET", None, {"user-agent": UA_CHROME})

def _parse_mysite(text, ctype, ctx):
    data = json_of(text, ctype)
    rows = data.get("items")
    if not isinstance(rows, list):
        raise SchemaError("items 不存在（接口可能已改版）")   # ← 不要 return []
    out = []
    for i, v in enumerate(rows[: ctx.limit], 1):
        out.append(make_item(
            source="mysite", native_id=v["id"], title=v["title"],
            url=v["link"], rank=i, lang="zh", heat=v.get("score"),
        ))
    return out

_register({
    "id": "mysite", "name": "我的源", "kind": "api",
    "default": True, "lang": "zh", "reach": "cn",
    "request": _req_mysite, "parse": _parse_mysite,
})
```

`make_item` 会统一处理归一化、时间解析、id 稳定化、HTML 清洗，适配器不用管。

写完用 `py scripts/sources.py health --sources mysite` 验一下。

### 只想加个 RSS

不用改代码 —— `rss` 的通用解析器已经在了，照 `_parse_feed_items("myid", "zh")` 加一条
`_register` 就行，三行。
