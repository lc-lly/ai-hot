# 端到端工作流

每条都给出**确切命令**和**命令之后你要做的分析动作**。
排序、去重、归类的判断准则见 [taxonomy.md](taxonomy.md)。

命令里的 `py` 在 macOS/Linux 上换成 `python3`。

---

## 1. 今日速览（最常见）

用户说：「今天 AI 圈有什么热点」「今日热点」「AI 新闻」

```bash
py scripts/fetch.py --since 24h --limit 10 \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/today.json
```

stdout 只回一行收据，然后 `Read` 那个文件（约 800 行）。
**一次抓够，不要抓两遍。**

> ⚠️ 实测约 23,000 字符（13 个源、60 条上下），**远超工具单次输出上限（约 15,000 字符）**。
> 直接读 stdout 会被**从中间截掉一截，而且不报错** ——
> 你看到的是一份合法的、只是少了几十条条目的 JSON，
> 很容易误判成「有的源没抓到」。字段里已经去掉了 `id`（写摘要用不上）。

拿到 JSON 后：

1. 按 [`taxonomy.md` §1](taxonomy.md) 选一种排序方式 ——
   **别直接按 `heat` 排**（会被百度热搜统治）。速览场景推荐按 `rank`。
2. 跨源合并同一事件（§2），把「出现在 N 个源」同时当成**热度信号和可信度信号**。
3. 归类（§3），输出按 §5 的结构。
4. 按 §4 把可信度写进措辞（单源说「据…」，多源说「多家报道」）。
5. 末尾如实写一句本次哪些源没取到。

> 中文源当天没有 AI 内容时（节假日常见），**直接点名国际源 + 垂类源**：
> `--sources hn,lobsters,github`（20 条 / 6,814 字符，实测），
> 不要用 `--all-sources` —— 那会把刚验证过是空的那 9 个中文源重抓一遍，
> 23,000 字符必被截断。
> 详见 [SKILL.md](../SKILL.md) 同名小节。
> **别手写 `curl`**，那样拿到的结果不进归一化和盯盘状态。

---

## 2. 只看某个领域 / 某个人 / 某个机构

用户说：「有什么 AI 编程相关的」「关注大模型，别的不用说」
「**看看 XX 最近发了什么**」「**XX 机构最近有什么动静**」

**确定性的子串过滤现在有抓取参数了**，不用抓完再自己筛：

```bash
# 按话题
py scripts/fetch.py --since 24h --limit 50 --grep "大模型,LLM,Agent,智能体" \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/topic.json

# 按人 / 按机构（人名和机构名都行）
py scripts/fetch.py --since 7d --limit 50 --author "OpenAI,Anthropic,李沐" \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/who.json

# 某人发布的 + 讲某话题的（两个参数=取交集）
py scripts/fetch.py --since 7d --limit 50 --author "OpenAI" --grep "Agent" \
  --fields source,title,url,summary,author,heat,rank,publishedAt
```

> ⚠️ **查到 0 条是常态，不是坏了。** 上面 `--author "OpenAI,Anthropic,李沐"`
> 这条命令 2026-10-06 实测返回 **0 条** —— 因为这 13 个源全是**当日榜单**，
> 这几个人当天就是没被收录。**不要因此改脚本、换命令重抓，或告诉用户「功能有问题」。**
> 拿不准名字写法时，先列榜上现有的作者照着抄（一条管道搞定，体积恒定）：
>
> ```bash
> py scripts/fetch.py --since 7d --limit 50 --fields source,author 2>/dev/null \
>   | py -c 'import sys,json;d=json.load(sys.stdin);[print(i["source"],"|",i.get("author")) for i in d["items"] if i.get("author")]' \
>   | sort -u
> ```
>
> 名字不在输出里 = 确实没有 → 换 `WebSearch`，别继续调参数。

> ⚠️ **过滤发生在抓取之后，所以要把 `--limit` 调大。** `--limit` 是**每源**上限，
> 默认 10 意味着你只在每源前 10 条里找 —— 排在后面的命中项**静默漏掉**，
> 你会误判成「这个人没发东西」。按发布者查请给到 50 或更大，
> 时间窗口也放宽（7d/30d）。详见 [cli.md](cli.md) 的「过滤」一节。

> ⚠️ **`--grep` 是字面子串，不是正则**；短英文词会命中小写串
> （`AI` 会命中 `Email`、`Pretraining`）。用 `OpenAI`、`大模型` 这类更长的词更准。

**判断仍然是你的活儿。** `--author`/`--grep` 只回答「这个字符串在不在」，
不回答「这条到底相不相关」—— 相关性排序、跨源去重合并、可信度分级、写摘要
一项都没少。也可以只挑特定来源（结果小，直接读 stdout 即可）：

```bash
py scripts/fetch.py --sources v2ex,36kr,infoq --since 24h
```

### 想查某个人的**完整产出**？脚本做不到

13 个源都是榜单/RSS，**没有「枚举某人所有投稿」的能力**。
B站 的 UP主 投稿接口实测需要登录态（`space/arc/search` 回 `-799`、
wbi 签名版回 `412`/`-352`，空间页 HTML 里 0 条内嵌数据），
`--author` 只是在**已抓到的那批条目**里筛。

要覆盖某人的全部产出，走 `WebSearch`（见 [troubleshooting.md](troubleshooting.md)），
再把搜到的主题词喂给 `--grep` 去 13 个源里匹配 —— 即：
**WebSearch 负责「某人发了什么」，本技能负责「这件事在 13 个源里怎么被讲」。**

---

## 3. 盯盘（持续关注某几个词）

### 首次设置

```bash
py scripts/watch.py --add "deepseek,智能体,MCP"
py scripts/watch.py --list          # 确认词已写入
```

### 日常运行

```bash
py scripts/watch.py                 # 默认 24h 窗口
```

只读 `new` 数组。**先看 `baseline` 字段**：

- `baseline: false` → `new` 里就是真正的增量，直接汇报。
- `baseline: true` → 这是首次运行或 state 被重建，
  `new` 是「当前命中的前 N 条」而**不是**新增。
  **必须告诉用户这是基线轮**，否则他会以为一下子冒出来 20 条新闻。

`newCount: 0` 是好消息（没有新东西），如实说「这几个词今天没有新增命中」，
不要为了有内容可讲就把历史条目翻出来。

### 定时执行

脚本本身**不调度**，交给系统的定时器。每次运行会自己加锁，
两轮重叠时后来者会直接退出并提示，不会互相覆盖状态导致漏报。

Windows 计划任务 / macOS launchd / Linux cron 都行，例如 crontab：

```cron
0 */2 * * *  cd /path/to/skills/hotspot-radar && python3 scripts/watch.py --out ~/.hotspot-radar/runs/latest.json >> ~/.hotspot-radar/cron.log 2>&1
```

> 顺带一提：`--out` 写文件时 stdout 只回一行收据，
> 所以 `>> cron.log` 不会把整个 JSON 灌进日志。

---

## 4. 单主题深挖

用户说：「最近 XXX 有什么进展」「帮我查查 YYY 的动向」

```bash
py scripts/fetch.py --since 7d --limit 20 --query "你的搜索词" \
  --out ~/.hotspot-radar/runs/deep.json
```

13 个源 × `7d` 窗口 × `--limit 20`，不写文件的话输出轻松上千条。
**这条命令一定带 `--out`**，然后按需读文件。

注意：

- `--query` 只影响 **GitHub 源**（其余源没有搜索能力，它们是榜单/RSS）。
  所以这条命令的语义是「榜单 + GitHub 上关于该词的仓库」。
- 不要加 `--all-sources`：它只会多带一个 reddit，且从大陆网络跑时必定 403。
- 想让 GitHub 搜索更精确，直接传 GitHub 搜索语法：

```bash
py scripts/fetch.py --sources github --query "llm agent stars:>500" --limit 20
```

> ⚠️ GitHub 搜索**不支持限定符之间的 `OR`**，会报 422 或静默返回 0 条。
> 详见 [sources.md](sources.md)。

---

## 5. 周报

```bash
py scripts/fetch.py --since 7d --limit 100 --out ~/.hotspot-radar/runs/week.json
```

然后**读那个文件**（不要读 stdout，100 条会占掉大量上下文），做：

1. 跨源合并 + 归类
2. 挑出「本周最值得关注的 5-8 件」
3. 按类别分组，每组一句话总结趋势
4. 和用户关注的方向做关联

---

## 6. 排查「某个源怎么没数据」

**先跑体检，不要瞎猜：**

```bash
py scripts/sources.py health
```

它会逐源报告 `ok` / `count` / 耗时 / 错误，明确区分：

- `ok: false` + `HTTP 403` / 超时 → 源挂了或被拦了
- `ok: true` + `count: 0` → 源正常，只是当下没内容
- `ok: false` + `SchemaError` → **源改版了**，需要改解析器

只想测一个源：

```bash
py scripts/sources.py health --sources bilibili
```

需要走代理时：

```bash
py scripts/fetch.py --all-sources --proxy http://127.0.0.1:7890
```

> ⚠️ 只支持 **HTTP/HTTPS 代理**，不支持 SOCKS。
> Clash 用户要给 HTTP 端口（通常 7890），不是 SOCKS 端口（7891）。

---

## 7. 加一个新信源

见 [sources.md](sources.md) 末尾「加自己的信源」。
加 RSS 只要三行。

---

## 给 Agent 的通用提醒

- **命令跑完先看 `sources[]`。** 有 `ok: false` 就在回答里说明，
  别让用户以为拿到的是全网。
- **`exit code 2` 不是失败**，是「部分源没取到」，数据照样能用。
- **不要重复读同一个文件。** `--out` 之后读一次就够。
- **不确定就说不知道。** 只有标题时别脑补正文内容。
