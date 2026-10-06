# 排错

## 先跑这个

```bash
py scripts/sources.py health
```

它给出的信息比任何猜测都准。三种失败要分清楚：

| 症状 | 含义 | 怎么办 |
|---|---|---|
| `ok: false` + `HTTP 403` / 超时 | 源被拦或不可达 | 挂代理；或该源从当前网络就是不通 |
| `ok: true` + `count: 0` | **源是好的**，当下没内容 | 不是故障。阮一峰是周更，别指望天天有新帖 |
| `ok: false` + `SchemaError` | **源改版了** | 要改 `scripts/sources.py` 里的解析器 |

---

## `--author` / `--grep` 过滤后一条都没有

**先接受一件事：0 条经常就是正确答案。** 这 13 个源全是**当日榜单**，
一个人今天没上榜、甚至这几天都没被任何一个源收录，都很正常 ——
文档里那个 `--author "李沐,OpenAI"` 的示例，2026-10-06 实测就是 **0 条**。
**不要因为查到 0 条就去改脚本、换命令重抓，或断定功能坏了。**

按可能性排序 —— **先看 `sources[].count`**：如果它 > 0，说明源是好的，是过滤太严或筛错了。

0. **这个名字压根不在今天的榜上。** 最快的确认办法是把榜上现有的作者列出来看一眼：

   ```bash
   py scripts/fetch.py --since 7d --limit 50 --fields source,author 2>/dev/null \
     | py -c 'import sys,json;d=json.load(sys.stdin);[print(i["source"],"|",i.get("author")) for i in d["items"] if i.get("author")]' \
     | sort -u
   ```

   实测 173 行 / 3,954 字符。名字在里面 → 写法问题（见第 3 条）；
   **不在里面 → 就是没有，换 `WebSearch` 或换时间窗口**，别继续调参数。
   （别用 `--fields source,title,author` 直接看 —— 实测 19,211 字符会被静默截断。）

1. **`--limit` 太小（最常见）。** 过滤发生在**抓取之后**，`--limit` 是**每源**上限 ——
   默认 10 就是「只在每源前 10 条里找」。某人的内容排在第 30 位就永远找不到，
   而且**不报错**。按发布者查请给到 50 或更大，并把 `--since` 放宽到 `7d`/`30d`。
2. **该源根本没有 `author`。** `baidu` / `36kr` / `solidot` 的 `author` 恒为 `null`。
   用**信源显示名**查（`--author 36氪`），别看作者名。完整表见 [sources.md](sources.md)。
3. **名字写法不对。** 匹配是**子串、不区分大小写**：`--author 李沐` 能命中
   `跟李沐学AI`；但 `--author 李沐老师` 就命中不了 `跟李沐学AI`。宁短勿长。
4. **以为它是正则。** 不是。`--grep "^GPT"` 会被当成字面量 `^GPT`，一条都匹配不到，
   **也不报错**。直接写 `GPT`。
5. **词太短，反而命中一堆无关的**（这是反向问题）。`--grep AI` 会命中
   `Email`、`Pretraining`、`JetBrains`。用 `OpenAI`、`大模型` 这类更长的词，
   或加 `--grep-all` 收紧。
6. **只有正文里才有的词。** `summary` 被截断在 300 字符左右，
   正文深处才出现的词匹配不到。这时只能靠标题/摘要里的词，或改用 `WebSearch`。

---

## 想查「某个人/某个机构的全部产出」——脚本做不到

13 个源都是榜单和 RSS，**没有「枚举某人的全部投稿」的能力**。
B站 UP主 投稿接口实测要求登录态（`space/arc/search` 回 `-799 请求过于频繁`，
wbi 签名版回 `412` / `-352 风控校验失败`，空间页 HTML 里 0 条内嵌数据）。
`--author` 只能在**已经抓到的那批条目**里筛。

**正确做法是分工：**

1. 用 **`WebSearch`** 搜「`<人名>` 最新 视频/文章/动态」—— 搜索引擎对 B站空间页、
   个人博客的收录比这些榜单全得多。**别用 `WebFetch`**，本环境下它会被域名校验拦住（见下节）。
2. 从搜索结果里提炼主题词，再喂给本技能做跨源匹配：

   ```bash
   py scripts/fetch.py --since 7d --limit 50 --grep "<搜索得到的主题词>" \
     --fields source,title,url,summary,author,heat,rank,publishedAt
   ```

即：**WebSearch 负责「某人发了什么」，本技能负责「这件事在 13 个源里怎么被讲」。**

---

## 中文输出是乱码

脚本启动时已把 stdout/stderr 切成 UTF-8。如果**仍然**乱码，通常是终端本身不支持：

```bash
py scripts/fetch.py --ascii          # 用 \uXXXX 转义，纯 ASCII 输出
```

或设环境变量：

```bash
PYTHONUTF8=1 py scripts/fetch.py --since 24h     # Windows cmd: set PYTHONUTF8=1
```

Windows 上还可以 `chcp 65001` 把控制台切到 UTF-8。

> **为什么这必须是脚本自己处理而不是让用户配？**
> 中文 Windows 的 Python 默认按 cp936 写 stdout，
> 第一句 `print("中文")` 就烂了。改终端设置要求用户在**第一次运行之前**
> 就知道要这么做 —— 那等于默认坏了。

---

## `python` 找不到 / 打开的是应用商店

Windows 上如果没装 Python，`python` 会命中 Microsoft Store 的占位存根，
弹一个商店页面而不是报错。用 `py` 启动器：

```bash
py scripts/fetch.py --since 24h
```

本技能要求 **Python 3.8+**。检查版本：

```bash
py --version
```

---

## `--help` 里是乱码

不该发生了 —— 脚本在 `argparse` 之前就切了编码。
如果还遇到，说明这个版本的脚本有问题，见上文用 `--ascii` 应急。

---

## 代理相关

### 我配了系统代理，但脚本还是直连

`urllib` 读的是**环境变量**（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，
大小写都可），不是系统代理设置。要么导出环境变量，要么显式传：

```bash
py scripts/fetch.py --proxy http://127.0.0.1:7890
```

Git Bash 里临时导出：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

### 报错说不支持 SOCKS

标准库的 urllib **没有 SOCKS 支持**（那需要 PySocks，而本技能要求零依赖）。

用 Clash / V2Ray 时，给它暴露的 **HTTP 端口**，不是 SOCKS 端口：

```bash
py scripts/fetch.py --sources reddit --proxy http://127.0.0.1:7890   # ✅ HTTP 端口
py scripts/fetch.py --sources reddit --proxy socks5://127.0.0.1:7891 # ❌ 不支持
```

Clash 默认：HTTP `7890`，SOCKS `7891`。把 `mixed-port` 指到 7890 最省事。

### 想强制不走代理

```bash
py scripts/fetch.py --no-proxy
```

优先级：`--proxy` > `--no-proxy` > 环境变量 > 直连。

---

## 某些源总是失败

这是**预期内**的，不是 bug。README 的「默认源」一节记录了实测结论：

- `reddit` —— 实测 HTTP 403 Blocked（数据中心 IP + 反爬），需要代理或住宅 IP。
  它是**唯一默认关闭**的源，所以只在你显式点名时才会出现。
- 其余的源都在大陆直连下实测可用，但**可达性会随链路变化** ——
  `hn` / `lobsters` 尤其如此。用 `sources.py health` 查当下状态。

**部分失败不影响整轮**，其余源照常返回。`exit code 2` 就是这个意思。
汇报时如实说「这几个源没取到」即可。

---

## `WebFetch` 被网络策略拦下（核实原文时）

本环境下 `WebFetch` 会返回
`Unable to verify if domain … is safe to fetch. This may be due to network restrictions…`，
对 `github.com`、`reflection.ai` 这类域名都一样 —— 这是宿主的域名校验，不是目标站点的问题，
**换域名也没用**。

需要核实某条时**直接改用 `WebSearch`**（搜标题或关键实体），一次就能拿到同样的信息，
别在 `WebFetch` 上试第二个域名白花一轮。

> 记得先读 [taxonomy.md §4.5](taxonomy.md) 的边界：核实是**被问到时**才做的，
> 速览场景不必逐条开原文。

---

## `HTTP 500`（瞬时故障，已自动重试）

`github.com/trending` 会**随机**回 500 —— 实测同一时刻、同一请求头连续发，
大约每 4 次里就有 1 次 500，其余 200。这是 GitHub 自己的抖动，不是被墙、也不是解析器坏了。

脚本已对 **5xx 自动重试**（`--retries`，默认 1 轮），实测把失败率从 ~25% 压到 5% 左右。
所以偶发一次 500 不用管；**如果一直 500**，那是 GitHub 真出事或网络问题，
换 `--sources github`（搜索 API，不受影响）先顶着。

> 4xx（403/422/429）**刻意不重试** —— 那是限流或参数错，重试只会白等一轮超时。

## `HTTP 422` （GitHub）

GitHub 搜索**不支持限定符之间的 `OR`**：

| 查询 | 结果 |
|---|---|
| `topic:ai created:>=2026-09-06` | ✅ |
| `topic:ai OR topic:llm` | ❌ 422 |
| `(topic:ai OR topic:llm) created:>=…` | ❌ 静默返回 0 条 |

用单个限定符，或改用文本词（`llm agent stars:>500`）。

---

## GitHub 限流（`HTTP 403`，偶尔才是 `429`）

GitHub 搜索无 token 时是 **10 次/分钟**。跑得太频就会被限。

> ⚠️ **GitHub 限流返回的是 403，不是 429。**
> 错误长这样：`HTTP 403 rate limit exceeded — {"message":"API rate limit exceeded for <你的IP>…"}`
> 别把它当成「被墙了」—— 同一个 IP 的全部请求会一起被限，
> 所以连跑几次 `health` 或 `fetch` 很容易自己把自己打爆。

`--retries` 对 4xx **不重试**（重试一个被限的请求只是白等一次超时）。

等一分钟，或换 `--sources` 跳过它：

```bash
py scripts/fetch.py --no-github
```

想更稳就用 GitHub token —— 但**本技能不要求任何 API Key**，
所以这里只是提供一个可选的提升手段：

```bash
GH_TOKEN=ghp_xxx py scripts/fetch.py        # 提到 30 次/分钟
```

---

## 盯盘每次都报一堆「新增」

按可能性排序：

1. **`baseline: true`** —— 首次运行或 state 被清空。
   这不是真的新增。看 [cli.md](cli.md) 的「首次运行」一节。
2. **`--state-dir` 每次都不一样** —— 状态没存住。
   检查是不是每条命令都传了不同的 `--state-dir`，
   或者环境变量 `HOTSPOT_RADAR_HOME` 被改了。
3. **id 不稳定** —— 某个源的 id 每轮都变。用 `--dedup-by url` 或 `--dedup-by title` 绕过：

   ```bash
   py scripts/watch.py --dedup-by url
   ```

4. **`--retain` 设得太短** —— 已见集合被清空了。默认 30d 通常够。

重置一次就好：

```bash
py scripts/watch.py --reset-state
```

---

## 盯盘什么都不报

- 先确认有监控词：`py scripts/watch.py --list`
- 确认词能匹配上：默认只在 `title` 里找。想让描述也参与：

  ```bash
  py scripts/watch.py --in-fields title,summary
  ```

- 确认窗口够大：默认 `--since 24h`。慢速源（阮一峰周更）要 `--since 7d`。

---

## 提示「另一个 hotspot-radar 进程正在运行」

有锁文件在。正常情况下几秒就释放。
如果确认没有进程在跑（比如上次被 `kill -9`），删掉即可 ——
超过 10 分钟的锁脚本会自己回收：

```
~/.hotspot-radar/watch.lock
```

---

## `SSL: CERTIFICATE_VERIFY_FAILED`

通常是企业 MITM 代理或证书链不全。指向系统的 CA 包：

```bash
SSL_CERT_FILE=/path/to/ca-bundle.crt py scripts/fetch.py --since 24h
```

---

## 状态文件损坏

脚本会先读 `state.json`，坏了自动回退 `state.json.bak`。
两个都坏就当首次运行处理（不会崩，只是走一次基线）。

想手动清干净：

```bash
py scripts/watch.py --reset-state
```

---

## `--out` 写的文件找不到

在 Git Bash 里 `/tmp/x.json` 会被 MSYS 改写成 Windows 路径，
但 Python 眼里的 `/tmp` 是 `C:\tmp`。用 `$TEMP` 或明确的路径：

```bash
py scripts/fetch.py --out "$TEMP/radar.json"         # Git Bash
py scripts/fetch.py --out "$HOME/.hotspot-radar/x.json"
```

写文件时 stdout 会回一行收据，里面有**绝对路径**，照着看就行。
