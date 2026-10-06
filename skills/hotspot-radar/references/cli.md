# 命令行与数据契约

> **本文件是命令、参数、退出码、JSON schema 的唯一事实源。**
> `SKILL.md` / `AGENTS.md` / Copilot 指令都只是指向这里的摘要。
> 改命令只改这里。

## 运行方式

所有脚本都用 Python 3 标准库，无第三方依赖，无 API Key。

| 平台 | 调用方式 |
|---|---|
| Windows | `py scripts/fetch.py …`（`python` 可能是 Microsoft Store 的占位存根） |
| macOS / Linux | `python3 scripts/fetch.py …` |

### ⚠️ 先 `cd` 到技能目录，再用相对路径

脚本路径相对于**本技能目录**（即 `SKILL.md` 所在目录），**不是**当前工作目录。
在别的目录里直接敲 `py scripts/fetch.py` 会得到
`can't open file '...\scripts\fetch.py': [Errno 2] No such file or directory` ——
注意这是 Python 自己报的错，脚本根本没跑起来，所以看不到任何本技能的日志。

**稳定做法是两步，或直接用绝对路径：**

```bash
cd <技能目录> && py scripts/fetch.py --since 24h      # ✅ 先 cd
py <技能目录>/scripts/fetch.py --since 24h            # ✅ 或绝对路径
py scripts/fetch.py --since 24h                       # ❌ 取决于 cwd，容易踩
```

Claude Code 加载技能时会把技能目录作为基目录报给模型，可据此拼绝对路径。

## 全局约定

### stdout 只输出 JSON

**所有日志、进度、警告一律走 stderr。** 因此可以放心地：

```
py scripts/fetch.py --since 24h | py -c "import json,sys; print(json.load(sys.stdin)['count'])"
```

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 全部成功 |
| `2` | 部分信源失败 |
| `3` | 全部信源失败 |
| `1` | 用法错误（未知信源、参数非法、无监控词…） |
| `130` | 被 Ctrl-C 中断 |

**JSON 内容才是准，退出码只是给 shell 用的提示。** 部分失败时 `sources[]` 里
会有 `ok: false` 的条目和具体 `error`，Agent 应该读那个而不是只看退出码。

### 中文与编码

脚本启动时会把 stdout/stderr 切成 UTF-8（中文 Windows 默认是 cp936，不切会乱码）。
如果终端仍然显示异常，加 `--ascii` 用 `\uXXXX` 转义输出，或设 `PYTHONUTF8=1`。

### 环境变量

全部**可选**，一个都不设也能跑。

| 变量 | 作用 | 默认 |
|---|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | 代理（大小写都认，`urllib` 原生支持） | 直连 |
| `HOTSPOT_RADAR_HOME` | 盯盘状态目录 | `~/.hotspot-radar/` |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub 搜索限流从 10 次/分提到 30 次/分 | 匿名 |
| `PYTHONUTF8` | 强制 UTF-8（`--ascii` 的环境变量版） | 自动切 |

> ⚠️ **只支持 HTTP/HTTPS 代理，不支持 SOCKS** —— 标准库没有 SOCKS 支持。
> Clash 用户给 HTTP 端口（7890），不是 SOCKS 端口（7891）。
> 优先级：`--proxy` > `--no-proxy` > 环境变量 > 直连。

---

## `fetch.py` — 抓取

```
py scripts/fetch.py
  [--sources ID[,ID...]]     逗号分隔；默认 = 所有默认开启的源
  [--all-sources]            加上默认关闭的源 —— 如今只剩 reddit（实测 403）
  [--no-github]              跳过 GitHub 源
  [--since 6h|24h|7d|30d|all]  默认 24h
  [--limit N]                每源条数上限，fetch 默认 10，watch 默认 50（见下）
  [--query "..."]            GitHub 搜索词；默认用内置 AI 主题词
  [--author NAME[,NAME]]     按发布者过滤（人名/机构名）；见下方「过滤」
  [--grep TERM[,TERM]]       按 title+summary 过滤；见下方「过滤」
  [--grep-all]               --grep 的多个词需全部命中（默认任一命中）
  [--proxy URL]              http://127.0.0.1:7890（**不支持 SOCKS**）
  [--no-proxy]               忽略环境变量代理，强制直连
  [--timeout SEC]            单源超时，默认 15
  [--retries N]              网络错误与 HTTP 5xx 重试，默认 1（4xx 不重试）
  [--verbose]                每源进度打到 stderr
  [--out FILE|-]             写文件；默认 stdout
  [--fields a,b,c]           裁剪字段以省 token
  [--ascii] [--compact]
```

### ⚠️ `--limit` 是「每源」上限，不是总数

**总条数 ≈ 源数 × `--limit`**。13 个源 × `--limit 10` 的上限是 130 条，
实测 24h 窗口下落在 60 条出头（多数源的热榜里没那么多是 24 小时内的）。

### 过滤：`--author` / `--grep` / `--grep-all`

问「**某个人或某个机构**发布的 AI 热点」用它。这是本技能里**唯一**在脚本侧做的筛选。

```bash
# 某个人 / 某个机构发了什么
py scripts/fetch.py --since 7d --limit 50 --author "李沐,OpenAI" \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/who.json

# 某人发布的、且讲某个话题的（两个参数=取交集）
py scripts/fetch.py --since 7d --limit 50 \
  --author "OpenAI" --grep "大模型,Agent" --out ~/.hotspot-radar/runs/x.json
```

> ⚠️ **示例里的 `李沐` / `OpenAI` 只是占位，不是「一定有数据」的名字。**
> 这 13 个源都是**当日榜单**，某个人今天没上榜、这几天的榜里压根没有他，
> **都是常态** —— 上面那条命令 2026-10-06 实测就是 **0 条**。
> **查到 0 条不等于功能坏了**，先按下面这步确认「名字写法」还是「确实没有」。

**查名字之前，先花一轮看看榜上到底有哪些作者**（这是最省事的排错，
比反复猜写法快得多）：

```bash
# 不加任何过滤，把 13 个源的作者列去重打出来
py scripts/fetch.py --since 7d --limit 50 --fields source,author 2>/dev/null \
  | py -c 'import sys,json;d=json.load(sys.stdin);[print(i["source"],"|",i.get("author")) for i in d["items"] if i.get("author")]' \
  | sort -u
```

实测 **173 行 / 3,954 字符**（2026-10-06）—— 而且**这行命令的体积与抓多少条无关**，
`--limit` 开到几百也不会撞上下面那条 15,000 字符的截断线。

> ⚠️ **不要为了「先看看有哪些作者」去加 `--fields source,title,author` 直接 `--out -`。**
> 实测 `--limit 50` 时那是 **19,211 字符，必被静默截断**；
> `--limit 20` 也要 12,847 字符，源抓满时同样越线。
> 想省事就照抄上面这条管道 —— 它把输出压到几千字符。

照着输出的作者名改写 `--author` 的值，命中率立刻从「靠猜」变成「照抄」。
注意 `baidu` / `36kr` / `solidot` 的 `author` 恒为 `null`（见下表），
它们只能靠**信源显示名**查。

| | 匹配范围 | 分隔符语义 |
|---|---|---|
| `--author A,B` | 条目的 `author` 字段 **或** 该信源的显示名 | **任一**命中（没有 all 变体） |
| `--grep A,B` | `title` + `summary` | **任一**命中；加 `--grep-all` 变成**全部**命中 |
| 两者同时给 | — | **取交集**（AND） |

#### ⚠️ 三条硬性事实

1. **字面子串，不是正则。** 不区分大小写，但 `--grep "^GPT"` 会被当成
   字面量 `^GPT`，**一条都匹配不到**，且不报错。
2. **短英文词会命中单词内部。** 实测 `--grep AI` 命中了
   `Pretr**ai**ning`、`JetBr**ai**ns`、`Ema**il**`、`m**ai**lservers`。
   中文不受影响（没有词边界问题）。想精确就用更长的词（`OpenAI`、`大模型`），
   或加 `--grep-all` 收紧。
3. **过滤发生在抓取之后。** 召回受 `--limit`（每源上限）和 `--since` 限制 ——
   排在源内靠后的命中项**捞不到**。按发布者筛时**务必把 `--limit` 调大**（几百条不嫌多），
   否则你会误判成「这个人没发东西」。

#### `--author` 在你关心的源上能不能用（2026-10-06 实测 13 源）

| 源 | `author` 装的是 | 人名 | 机构名 |
|---|---|---|---|
| `bilibili` | UP主名 | ✅ | 用信源名 |
| `juejin` | 作者名 | ✅ | 用信源名 |
| `github` | 仓库 owner（**人也可以是机构**） | ✅ | ✅ |
| `github-trending` | 仓库 owner | ✅ | ✅ |
| `v2ex` / `hn` / `lobsters` | 用户名 | ✅ | 用信源名 |
| `infoq` | `作者：<姓名>` | ✅ | 用信源名 |
| `sspai` | 作者名 | ✅ | 用信源名 |
| **`baidu`** | **恒为 `null`** | ❌ | **只能靠信源名** |
| **`36kr`** | **恒为 `null`** | ❌ | **只能靠信源名** |
| **`solidot`** | **恒为 `null`** | ❌ | **只能靠信源名** |

**「用信源名」= `--author` 也匹配信源显示名**，所以 `--author 36氪`、
`--author Solidot` 照样能捞出那三个没有 author 的源。这就是它必须匹配信源名的原因 ——
不是顺手加的便利，是**唯一**能让 36氪/Solidot/百度 按机构查的路径。

副作用：`--author github` 会同时命中两个 GitHub 源（显示名里都有 GitHub），
`--author 百度` 会命中百度热搜。这是**预期行为**。
另外 `--author` 不搜正文和标题 —— 想找「谁在**谈论** OpenAI」用 `--grep OpenAI`。

### ⚠️ 单次输出上限约 15,000 字符 —— 超了从**中间**截断，且不报错

**这是本技能最容易踩的坑，因为失败是静默的。** 拿到的是**合法 JSON**，
`count` 还是原值，只是中间少了一截条目。Agent 会以为「有的源没抓到」，
再抓一遍 —— 白跑两轮，而且抓回来的是同一批数据。

实测锚点（2026-10-06，本机）：

| 原始输出 | 结果 |
|---|---|
| **14,308 字符** | 完整读到 ✅ |
| **16,462 字符** | 截成 10,039 字符，**中间丢 7,070** ❌ |
| 22,626 字符 | 截成 10,040 字符，丢 12,586 ❌ |

规律：上限约 **15,000 字符**；超了保留头 ~5,000 + 尾 ~5,000，
中间换成 `... [N characters truncated] ...`。

> ⚠️ **别用「字节」或「KB」估。** 中文一个字 3 字节，但截断是按**字符**算的。
> 按字节估会得出「29 KB 没问题」这种错误结论 —— 这个坑已经栽过一次。

### 常用组合（字符数为实测）

| 场景 | 源数 | 命令 | 条数 | 字符 |
|---|---|---|---|---|
| **速览（推荐）** | 13 | `--limit 10 --out …` | 60±3 | **约 23,000** → 写文件 |
| 只要国际源 | 3 | `--sources hn,lobsters,github --limit 10` | 20 | **6,814** ✅ |
| 只要两三个源 | 2-3 | `--sources v2ex,36kr --limit 10` | ~10 | **~3,000** ✅ |

> 条数每天不一样（60±3 是 10-06 前后几次实测的范围），别把某个数字当常量。
> 加了 `author` 字段后速览约 22,968 字符（同一天不含 `author` 是 21,345）——
> 结论不变：**仍然远超 15,000，必须走 `--out`**。

**两条经验规则：**

1. **已知哪些源有内容时，就点名 `--sources`**，不要把已经验证过是空的源再抓一遍。
   `--all-sources` 现在只多带一个 reddit（大陆直连必 403），**基本没有使用场景**。
2. **吃不准会不会超，就直接 `--out`。** stdout 只回一行收据，
   再用 `Read` 读文件（约 800 行，Read 上限 2000 行，装得下），目录不存在会自动建。
   多一次 `Read` 远比「静默丢数据 + 多跑两轮抓取」便宜。

**默认值**：`fetch.py` 不传 `--limit` 时是 10；
**`watch.py` 是 50**，因为告警漏报的代价远大于多读几条 ——
`--limit` 调小会让排在源内靠后的命中项静默地报不出来。

### ⚠️ `--fields` 里务必留 `summary`

`summary` 占了输出约三成的体积（实测 13 源 62 条：22,768 → 16,478 字符），
很容易想砍掉。**但砍掉它就写不了摘要**，
只能把 13 个源全量重抓一遍 —— 省几 KB，换来一次完整重抓，净亏。

速览的推荐组合：

```bash
py scripts/fetch.py --since 24h --limit 10 \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/today.json
```

**这里保留 `author`、去掉了 `id`。** `author` 要留着 —— 用 `--author` 筛的时候
得看得见是谁发的（约 +1,600 字符）。`id` 只是 `source` + 原生 id 的拼接
（`bilibili:BV1ndHf6xEsz`），是给脚本的去重和盯盘状态用的；
写摘要时 `source` + `url` 已经够了。去掉它省约 2,400 字符。

只在**确实只要列表**（不写摘要）时才去掉 `summary`。
`raw` 字段基本可以去掉，它只是源特有字段的容器，分析时很少需要。

### 输出

```json
{
  "schema": "hotspot-radar/fetch/v1",
  "generatedAt": "2026-10-06T10:40:00Z",
  "since": "24h",
  "count": 53,
  "sources": [
    { "id": "bilibili", "ok": true,  "count": 5, "fetched": 5, "ms": 239, "error": null },
    { "id": "reddit",   "ok": false, "count": 0, "fetched": 0, "ms": 976,
      "error": "HTTP 403 Blocked — <body class=theme-beta>…" }
  ],
  "items": [ /* 见下 */ ],
  "filter": { "author": ["OpenAI"], "grep": ["大模型"],
              "before": 59, "matched": 6 }
}
```

三个计数，**恒有 `matched <= count <= fetched`**：

| 字段 | 含义 |
|---|---|
| `fetched` | 该源解析出的原始条数（**任何过滤之前**） |
| `count` | 按 `--since` 过滤后剩余的条数 |
| `matched` | **只有用了 `--author`/`--grep` 才出现**：再按发布者/关键词过滤后剩余的条数 |

`fetched` 与 `count` 不等是正常的（比如掘金热榜里常有超过 24 小时的文章）。

**`filter` 块只在过滤生效时出现**（否则整个键都不存在，输出与不带过滤时逐字节一致）：
`before` = 过滤前条数，`matched` = 过滤后条数（与顶层 `count` 相同），
`author`/`grep` 原样回显你传入的词。每源 `matched` 从去重后的条目按源统计，
所以 `count == sum(sources[].matched)` 恒成立。

> 判读要点：**`sources[].count` 是过滤前**的。某个源 `count: 20, matched: 0`
> 意思是「它今天有 20 条，但一条都不是你要的那个人/词」——
> 不是「这个源挂了」（那看 `ok`）。

### 条目 schema

```json
{
  "id": "bilibili:BV1ndHf6xEsz",
  "source": "bilibili",
  "title": "虽败犹荣",
  "url": "https://www.bilibili.com/video/BV1ndHf6xEsz",
  "summary": "……",          // 可能为 null
  "author": "杨齐家_",        // 可能为 null
  "publishedAt": "2026-10-06T09:25:43Z",  // 可能为 null
  "heat": 172539,            // 可能为 null
  "rank": 1,                 // 1 起，源内排名
  "lang": "zh",
  "raw": { "view": 172539, "like": 9000, "bvid": "BV1ndHf6xEsz" },
  "matched": ["OpenAI"],     // 仅过滤生效时出现：命中的 author 词 + grep 词（去重保序）
}
```

`matched` 是**作者词和关键词的并集**，所以 `--author 36氪` 命中时它会是 `["36氪"]`
—— 据此能分清这条是靠记者名命中的还是靠信源名命中的。
用 `--fields` 时它会被自动保留（同 `watch.py` 的约定），不用手写进字段列表。

#### ⚠️ `heat` 跨源不可比 —— 用 `rank` 排序

每个源的 `heat` 是自己的原生数值，量纲完全不同：

| 源 | `heat` 含义 | 典型量级 |
|---|---|---|
| `baidu` | 热搜指数 hotScore | 百万 ~ 千万 |
| `bilibili` | 播放量 | 万 ~ 百万 |
| `v2ex` | 回复数 | 十 ~ 百 |
| `lobsters` / `hn` | 分数 / 点赞 | 十 ~ 千 |
| `github-trending` | **今日新增 star** | 十 ~ 千 |
| `github` | 总 star 数 | 十 ~ 十万 |
| `juejin` | hot_index | 千 ~ 万 |
| RSS 类（36kr/infoq/sspai/…） | 恒为 `null` | — |

**直接按 `heat` 跨源排序会得到一张被百度热搜统治的榜。** 需要跨源可比时，
用 `rank`（源内排名），或按源分组后各自内部排序再合并。详见 [taxonomy.md](taxonomy.md)。

#### `id` 的稳定性

`id` 形如 `<source>:<原生 id>`，是去重和盯盘判定的唯一键。
当源没有稳定原生 id 时（如某些 RSS 缺 `<guid>`）会退化为 URL，
此时**跟踪参数会被剥掉**（`?f=rss`、`?utm_source=…`），
但返回给用户点击的 `url` 保持原样。

---

## `watch.py` — 盯盘

抓取 → 匹配监控词 → **只报上次之后新增的**条目。

```
py scripts/watch.py
  [--add "关键词1,关键词2"]   追加监控词并写回配置
  [--list]                    只看监控词与状态，不抓取
  [--config FILE]             默认 <state-dir>/watchlist.json
  [--in-fields title,summary] 在哪些字段匹配，默认 title
  [--state-dir DIR]           默认 ~/.hotspot-radar
  [--reset-state]             丢弃已见集合，重建基线
  [--dedup-by id|url|title]   默认 id
  [--retain 30d]              已见集合保留期，默认 30d
  [--first-run-limit N]       基线轮最多报几条，默认 20
  （抓取参数同 fetch.py）
```

### 输出

```json
{
  "schema": "hotspot-radar/watch/v1",
  "generatedAt": "2026-10-06T12:00:00Z",
  "baseline": false,
  "dedupBy": "id",
  "watchedTerms": ["deepseek", "智能体"],
  "fetchedCount": 53,
  "newCount": 3,
  "totalMatched": 3,
  "new": [
    { "…条目字段…": "…", "matched": ["deepseek"], "firstSeenAt": "2026-10-06T12:00:00Z" }
  ],
  "sources": [ /* 同 fetch.py 的健康块 */ ]
}
```

- `newCount` 是**本轮回报**的条数；`totalMatched` 是本轮命中的总数。
  基线轮两者会不同（见下）。
- `baseline: true` 表示这是首次运行或 state 被清空后的重建轮。

### 首次运行 / state 丢失的行为

state 丢了的时候，如果老老实实把当前 200 条全判成「新增」，结果就是刷屏，
用户第一次跑就被淹没。所以：

- 首轮把**当前所有条目记为基线**（视为已见）
- 但只回报监控词命中的**前 `--first-run-limit` 条**（默认 20）
- 输出里 `baseline: true`，看到它就该告诉用户「这是基线轮，不是真的新增」

`--reset-state` 可以显式触发同样的重建。

### 状态文件

默认在 `~/.hotspot-radar/`（可用 `--state-dir` 或环境变量 `HOTSPOT_RADAR_HOME` 覆盖）。

```
watchlist.json      监控词，可手改
state.json          已见集合（机器所有，别手改）
state.json.bak      上一次的好副本，主文件损坏时自动回退
watch.lock          运行期的互斥锁，防定时任务重叠导致漏报
runs/               放 --out 输出的惯用目录（不存在时 --out 会自动创建）
```

看看当前监控词长什么样：

```json
{
  "schema": "hotspot-radar/watchlist/v1",
  "keywords": ["deepseek", "智能体"]
}
```

也接受完整写法：

```json
{
  "keywords": [
    { "id": "agent", "terms": ["agent", "智能体", "Agent"],
      "match": "any", "sources": ["v2ex", "36kr"], "exclude": ["agent orange"] }
  ]
}
```

- `terms` 多个词，`match` 为 `any`（默认）或 `all`
- `sources` 限定来源，`["*"]` 或省略 = 不限
- `exclude` 命中任一即否决整条

---

## `sources.py` — 信源清单与体检

```
py scripts/sources.py list      # 列出所有信源（默认动作）
py scripts/sources.py list --json
py scripts/sources.py health [--sources …] [--proxy …] [--json] [--out FILE]
py scripts/sources.py export
```

排查「某个源怎么没数据」时**先跑 `health`** —— 它会明确区分
「这个源挂了」和「这个源今天就是没内容」。

---

## `install-shims.py` — 可选的多 Agent 适配

默认**什么都不做**。详见 [../AGENTS.md](../AGENTS.md)。

```
py scripts/install-shims.py --agents-md    # 仓库根写 AGENTS.md
py scripts/install-shims.py --copilot      # .github/copilot-instructions.md
py scripts/install-shims.py --all
py scripts/install-shims.py --uninstall
```

---
---

# 给 Agent 的消费指引

## 优先用 stdout，别急着写文件

- **输出 ≲15,000 字符**（约 30 条带 `summary`）：不加 `--out`，直接读 stdout 的 JSON。
  **按字符算，不要按 KB 算** —— 中文一个字 3 字节，按字节估会得出「没问题」的错误结论。
- **更大，或要反复读**：`--out <路径>`，然后只读那个文件。
  此时 stdout 会回一行收据（`{"out":…,"count":N,"sourcesOk":M,"sourcesFailed":K}`），
  不会把大 JSON 塞进上下文两遍。
- **要缩小结果**：优先用 `--author` / `--grep` 在**抓取时**筛掉不要的，
  而不是读了再切（后者照样占满上下文）。确实只要列表时才用
  `--fields source,title,url,author,heat,publishedAt`（去掉 `summary`）。

## 失败要如实转达

- `sources[]` 里 `ok: false` 的源，**要在回答里说明「这几个源没取到」**，
  不要让用户以为这就是全部。
- 全部源都失败（退出码 3）时不要编内容，直接报告失败原因。

## 不要重复造轮子

`count > 0` 之后，去重 / 聚类 / 排序 / 写摘要**都是你的活儿**，脚本不做这些
（也刻意不调用任何 LLM）。具体怎么排、怎么归类，见 [taxonomy.md](taxonomy.md)。

**唯一的例外是 `--author` / `--grep`** —— 那是**确定性子串过滤**
（「这个字符串在不在」，可复现、无判断），所以放在抓取侧省一轮工具调用。
它**不**判断「这条到底相不相关」：`--grep OpenAI` 命中的是字符串，不是相关性。
相关性排序、跨源合并、可信度分级仍然是你的活儿。
