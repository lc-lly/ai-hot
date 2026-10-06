---
name: hotspot-radar
description: "跨源热点监控：抓取 AI/科技热点、热搜、trending，用关键词盯盘只报新增，按发布者或话题过滤。当用户问「今天有什么热点」「AI 圈有什么新闻」「最近 XXX 有什么进展」「帮我关注 XX 的动向」「最近科技圈在聊什么」「某个人/某个机构最近发了什么 AI 内容」，或要舆情、日报、周报、行业速览时使用。只用 Python 3 标准库，无需 API Key、无需安装依赖、不启动任何服务，也不调用任何 LLM —— 抓取和归一化由脚本完成，去重、聚类、排序、摘要由你（Agent）来做。"
---

# hotspot-radar

一个**自包含**的热点监控技能：抓取多个公开信源 → 归一化成统一 JSON → 由你分析。

没有任何外部依赖：不需要 API Key，不需要 `pip install`，不需要数据库或常驻服务，
也不需要额外调用任何大模型。**你本身就是分析引擎。**

## 何时用它

用户提到这些时：

- 今日热点 / AI 热点 / 科技资讯 / 热搜 / trending / 舆情
- 「今天 AI 圈有什么」「最近有什么值得关注的」
- 「帮我盯着 XX」「关注 XX 的动向」→ 用盯盘流程
- 日报 / 周报 / 行业速览
- 「**某人/某机构最近发了什么**」「只看 XX 相关的」→ 用 `--author` / `--grep`
- 排查某个资讯源为什么没数据

**不适用**：需要登录或付费的私有数据源、需要实时推送的场景。

## 两条命令先跑起来

```bash
# 1. 看看现在有什么（Windows 用 py，macOS/Linux 用 python3）
#    速览约 23,000 字符（13 个源），超过工具单次输出上限 —— 必须走 --out
py scripts/fetch.py --since 24h --limit 10 \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/today.json
# 然后 Read 那个文件（约 800 行）

# 2. 设一次监控词，之后每次跑都只报新增
py scripts/watch.py --add "deepseek,智能体,MCP"
py scripts/watch.py
```

> ⚠️ **工具单次输出上限约 15,000 字符，超了从「中间」截断，而且不报错。**
> 你拿到的是**合法 JSON**，`count` 也正常，只是中间少了一截条目 ——
> 会让你误判成「有的源没抓到」，然后再抓一遍。**这是本技能最容易踩的坑。**
> 实测：14,308 字符完整读到；16,462 字符被截成 10,039（中间丢 7,070）。
> **别用字节或 KB 估** —— 中文一个字 3 字节，但截断是按**字符**算的。
> 吃不准就直接 `--out`，多一次 `Read` 远比静默丢数据便宜。

> ⚠️ **`--limit` 是「每源上限」，不是总数。** 默认 13 个源，上限是 130 条，
> 实测 24h 窗口下 60 条上下（每天不同）—— 也就是约 23,000 字符，**远超截断线**。
> `fetch.py` 不传 `--limit` 时默认 10；`watch.py` 默认 50，
> 因为告警漏报的代价远大于多读几条。

> ⚠️ **`--fields` 里一定要留 `summary`。** 砍掉它省约三成字符，
> 但**你就写不出摘要了 —— 只能把 13 个源全量重抓一遍**，
> 省一点体积换来一次完整重抓，净亏。
> 推荐字段已经去掉了 `id`：它只是 `source` + 原生 id 的拼接，
> 写摘要时用不上，去掉省约 2,400 字符。

> ⚠️ **脚本路径相对于本技能目录，不是当前工作目录。**
> 在别的目录里直接敲 `py scripts/fetch.py` 会报
> `can't open file '...\scripts\fetch.py'` —— 那是 Python 自己找不到文件，
> 脚本压根没启动，所以你**看不到任何本技能的日志**。
> 先 `cd` 到本技能目录，或改用绝对路径。

## 输出长什么样

```json
{
  "schema": "hotspot-radar/fetch/v1",
  "count": 53,
  "sources": [
    { "id": "bilibili", "ok": true,  "count": 5, "ms": 239, "error": null },
    { "id": "reddit",   "ok": false, "count": 0, "ms": 976, "error": "HTTP 403 Blocked" }
  ],
  "items": [
    {
      "id": "bilibili:BV1ndHf6xEsz",
      "source": "bilibili",
      "title": "……",
      "url": "https://www.bilibili.com/video/BV1ndHf6xEsz",
      "summary": "……", "author": "杨齐家_",
      "publishedAt": "2026-10-06T09:25:43Z",
      "heat": 172539, "rank": 1, "lang": "zh",
      "raw": { "view": 172539, "like": 9000 }
    }
  ]
}
```

### 三个必须记住的点

1. **stdout 只有 JSON**，日志全在 stderr。可以直接管道给 JSON 解析器。

2. **`heat` 跨源不可比。** 百度热搜是百万~千万级，V2EX 是回复数（几十），
   GitHub Trending 是今日新增 star（几百）。
   **直接按 `heat` 排序会得到一张被百度热搜统治的榜。**
   跨源可比的是 `rank`（源内排名）。详见 [taxonomy.md](references/taxonomy.md)。

3. **先看 `sources[].ok`。** 有源失败时要在回答里说明，
   别让用户以为拿到的是全网。退出码 `2` = 部分失败，不是错误。

## 默认信源（13 个，全部免密钥）

全部在**中国大陆网络直连实测可用**：

`bilibili` B站热门 · `baidu` 百度热搜 · `juejin` 掘金 · `github` GitHub 搜索 ·
`github-trending` GitHub Trending · `v2ex` V2EX 热帖 · `36kr` 36氪 ·
`infoq` InfoQ 中国 · `sspai` 少数派 · `ruanyifeng` 阮一峰 · `solidot` Solidot ·
`hn` Hacker News · `lobsters` Lobsters

最后两个是英文源，**默认开着是有意的**：节假日中文源会被社会新闻占满，
那时 AI 内容基本只剩它俩（实测大陆直连可通）。

默认关闭的只剩 `reddit`（实测 403，要代理）。所以 `--all-sources` 如今
基本只有「把 reddit 也带上」这一个作用，**通常不需要它**。

不可用：知乎（需签名 Cookie）、机器之心（RSS 已失效）、RSSHub（站点不通）。

| 命令 | 用途 |
|---|---|
| `py scripts/sources.py list` | 列出所有信源 |
| `py scripts/sources.py health` | **逐源体检** —— 排查「怎么没数据」的第一步 |

## 三个主要流程

### 速览 —— 「今天有什么热点」

```bash
py scripts/fetch.py --since 24h --limit 10 \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/today.json
```

stdout 只回一行收据，然后**用 `Read` 把那个文件读进来** —— 一次读完。

> ⚠️ **不要用 `py -c` 分段打印那个文件。** 上面这条命令的产物是
> 60 条左右 / 约 700 行，`Read` 一次就装下了（Read 上限 2000 行）。
> 有人会图省事写成 `python -c "…for i in items[:17]…"` 一段段翻，
> 结果**同样一份数据花掉三四个工具轮次**，还容易写错崩掉。
> 要控制进入上下文的量，用 `--fields` 在抓取时裁，而不是读的时候切。

拿到 JSON 后：跨源合并同一事件 → 归类（模型/Agent/开源/融资/政策…）→
按 [taxonomy.md](references/taxonomy.md) 的准则排序输出。
**别按 `heat` 排。**

> ⚠️ **`count` 是「抓取条数」，不是「AI 热点条数」—— 别让它误导用户。**
> 这 13 个源里百度热搜 / B站热门 / Lobsters 是**全品类榜单，不是 AI 频道**。
> 实测 `--since 24h --limit 10` 抓到 **61 条，其中约 42 条（69%）和 AI 无关**
> （百度 10 条全是时政体育社会、B站 6 条全是游戏番剧、Lobsters 6 条全是系统编程），
> AI 相关约 19 条，**去掉同一话题的重复后约 15 条**。
> **开口就说「抓到 61 条」然后列出 15 条，用户会以为你丢了 46 条。**
> 要么先讲清这个漏斗，要么直接说「筛出 N 条 AI 相关」，别报原始 count。

**一次抓够，别抓两遍。** 写摘要需要 `summary`，`summary` 要占约三成体积 ——
但「先抓个不带 summary 的看看，需要再抓一次」是**净亏**：
省约三成体积，代价是 13 个源全量重抓一遍。要摘要就第一次就带上。

**万一还是被截断了，不要换命令重抓。** 先确认有没有
`... [N characters truncated] ...` 标记；有的话用**同一个命令**加 `--out` 重跑 ——
改成 `--sources` 换源再抓一遍拿到的是同一批数据，只是白花一轮。

### 盯盘 —— 「帮我盯着 XX」

```bash
py scripts/watch.py --add "关键词1,关键词2"    # 只设一次
py scripts/watch.py                            # 之后每次跑这个
```

只读 `new` 数组。**先看 `baseline` 字段**：

- `baseline: false` → `new` 就是真正的增量
- `baseline: true` → 首次运行或状态被重建，`new` 是当前命中项**不是新增**。
  **必须告诉用户这是基线轮**，否则他会以为一下冒出 20 条新闻。

`newCount: 0` 是好消息，如实说「今天没有新增命中」，不要翻历史条目来凑内容。

状态在 `~/.hotspot-radar/`，不在技能目录里（技能目录受 git 管理，升级会丢）。

### 深挖 —— 「最近 XXX 有什么进展」

```bash
py scripts/fetch.py --since 7d --limit 20 --query "搜索词" \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/deep.json
```

13 个源 × `7d` × `--limit 20`，很容易上千条 ——
**这条命令务必带 `--out` 写文件**，再按需读，不要直接往 stdout 拿。

`--query` **只影响 GitHub 源**，其余源是榜单/RSS，没有搜索能力。

### 按人 / 按机构 / 按话题筛

```bash
# 某人或某机构最近发了什么（人名、机构名都行）
py scripts/fetch.py --since 7d --limit 50 --author "OpenAI,李沐" \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/who.json

# 只看某话题（--grep 命中 title+summary）
py scripts/fetch.py --since 24h --limit 50 --grep "大模型,Agent"
```

两者同时给 = **取交集**（「某人发布的、讲某话题的」）。

> ⚠️ **示例里的 `OpenAI,李沐` 只是占位，不是「一定有数据」的名字。**
> 这 13 个源都是**当日榜单** —— 某人今天没上榜就是没有，
> 上面那条命令 2026-10-06 实测就是 **0 条**。**查到 0 条不等于功能坏了。**
> 名字写法拿不准时，先花一轮把榜上的作者列出来照抄：
>
> ```bash
> py scripts/fetch.py --since 7d --limit 50 --fields source,author 2>/dev/null \
>   | py -c 'import sys,json;d=json.load(sys.stdin);[print(i["source"],"|",i.get("author")) for i in d["items"] if i.get("author")]' \
>   | sort -u
> ```
>
> 实测 173 行 / 3,954 字符，且只要走管道就**不会撞 15,000 字符截断线**。
> 名字不在输出里 = 确实没有，**换 `WebSearch` 或放宽 `--since`，别继续调参数**。

> ⚠️ **`--limit` 必须调大。** 过滤发生在**抓取之后**，默认 10 意味着你只在每源前 10 条里找，
> 排在后面的命中项会**静默漏掉**，你会误判成「这个人没发东西」。
> 按发布者查请给到 50 甚至更大，时间窗口也放宽。
> **`--author` 也匹配信源显示名**，所以 `--author 36氪`、`--author Solidot`
> 能捞出那三个 `author` 恒为 null 的源（36kr / solidot / baidu）。
> `--grep` 是**字面子串、不是正则**，且短英文词会命中单词内部
> （`AI` 会命中 `Email`、`Pretraining`）—— 明细见 [cli.md](references/cli.md)。

**脚本做不到「枚举某个人的全部产出」** —— 13 个源都是榜单/RSS，没有这个能力
（B站 UP主 投稿接口实测需要登录态）。要覆盖全额产出得先用 `WebSearch`
找出该人的主题词，再回灌 `--grep` 做跨源匹配。

### 中文源今天没有 AI 内容怎么办

节假日、周末、慢新闻日，中文源会被社会新闻和娱乐占满：百度热搜 30 条里可能
**一条 AI 都没有**，B站热门全是游戏动画。**这不是故障** ——
`sources.py health` 照样全绿，因为源是好的，只是今天没那个内容。

这种情况**换源，而不是换手段**。既然第一轮已经证明中文源空转，
第二轮就**直接点名国际源 + 垂类源**，不要再抓一遍中文源：

```bash
py scripts/fetch.py --sources hn,lobsters,github --since 24h --limit 10 \
  --fields source,title,url,summary,author,heat,rank,publishedAt
```

20 条 / 6,814 字符（实测），能直接读完。这几个源 AI 内容密度远高于中文热搜 ——
中文源空转的日子它们才是主力。想再宽一点就加上 `github-trending`
（它偶发 HTTP 500，脚本已对 5xx 自动重试一轮）。

> ⚠️ **不要用 `--all-sources` 来救场。** 它会把 13 个源连同 `reddit`（必定 403）
> 全部重抓一遍 —— 包括你刚刚验证过是空的那 9 个中文源。
> 输出约 23,000 字符 **必然被截断**，你还得再抓一次，
> 正是本技能要避免的那种浪费。`--all-sources` 现在只剩「顺便试试 reddit」这一个用途。

> ⚠️ **不要手写 `curl` 去抓榜外的站点。** 那样拿到的结果：
> 不进归一化、不参与去重、不进盯盘状态、`sources[]` 里也留不下记录。
> 等于在技能外面又造了个一次性脚本，而且下次还得重来。
> 真缺源就按 [references/sources.md](references/sources.md) 加适配器
> （RSS 只要三行），或直接告诉用户这个源不在覆盖范围内。

---

## 详细文档（按需读，不要一次全读）

| 文件 | 什么时候读 |
|---|---|
| [references/cli.md](references/cli.md) | **要精确的命令签名、退出码、JSON schema 时。这是唯一事实源** |
| [references/workflows.md](references/workflows.md) | 要完整的端到端流程（速览/盯盘/深挖/周报/排错） |
| [references/taxonomy.md](references/taxonomy.md) | **准备排序、去重、归类、写摘要之前** —— 这份决定输出质量 |
| [references/sources.md](references/sources.md) | 要加信源，或要查某个源的端点与已知坑 |
| [references/troubleshooting.md](references/troubleshooting.md) | 编码乱码、代理、403/422/429、盯盘异常 |

## 你要做的工作

脚本**不做**这些（它刻意不调用任何 LLM）：

- 跨源去重合并（脚本只去同一源内的重复）
- 排序与热度归一
- 归类打标
- 写摘要、写日报/周报
- 判断哪些值得说、哪些是标题党

**唯一的例外是 `--author` / `--grep`**：那是**确定性子串过滤**（「这个字符串在不在」，
可复现、不含判断），所以放在抓取侧省一轮工具调用。它**不**判断相关性 ——
`--grep OpenAI` 命中的是字符串，不是「这条和 OpenAI 有多相关」。

准则见 [references/taxonomy.md](references/taxonomy.md)。**动笔前先读它。**

## 边界

- **不编造。** 只有标题时就说「标题显示…」，不要脑补正文。
- **如实报告失败源。** `sources[]` 里 `ok: false` 的要在回答末尾提一句。
- **不凑数。** 只有 3 条值得说就说 3 条。
- **每个条目都要有链接。** 没有 URL 的直接跳过。
- **不越出技能去抓数据 —— 但核实除外。** 别手写 `curl` / `WebFetch` 去给榜单
  **扩源**：那些结果不进归一化、不参与去重、不进盯盘状态，`sources[]` 里也留不下记录。
  缺源就用 `--sources` 点名，
  或按 [sources.md](references/sources.md) 加适配器。
  **反过来，用户问「这条是不是真的」时，读那一篇原文是该做的** —— 那是核实。
- **不重复抓取。** 一次 `fetch` 拿全要用的字段（**含 `summary`**），
  不要「先抓一遍看看，需要再抓一遍」—— 那是 13 个源的全量重跑。
- **能不装懂就不装懂。** 你手上只有 `title` + `summary`，**没读过正文**，
  任何数字、日期、人名都没核实过。问「这是真的吗」时，要么读原文再说，
  要么直说「我只能看到标题」。**别拿自己的记忆去"确认"一条当天新闻** ——
  你的知识有截止日期，而这条新闻比它新。
  怎么分级、怎么说，见 [taxonomy.md §4](references/taxonomy.md)。
