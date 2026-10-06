# hotspot-radar

自包含的热点监控技能：从多个公开信源抓取 AI/科技热点，归一化成统一 JSON，
**由你（Agent）负责分析** —— 去重、聚类、排序、写摘要。

## 前提

- **Python 3.8+**，仅标准库。
- **不需要 API Key，不需要 `pip install`，不需要启动任何服务。**
- 本技能**不调用任何 LLM**。脚本只抓取和归一化，分析是你的活儿。
- Windows 上用 `py` 启动（`python` 可能是 Microsoft Store 的占位存根）；
  macOS/Linux 用 `python3`。
- **脚本路径相对于本技能目录**，不是当前工作目录。
  在别处直接敲 `py scripts/fetch.py` 会报 `can't open file '...\scripts\fetch.py'`
  —— 那是 Python 找不到文件，脚本没启动，因此不会有本技能的任何日志。
  先 `cd` 到本技能目录，或用绝对路径。

## 快速上手

```bash
# 速览：一次抓够。约 60 条 / 约 23,000 字符 —— 超过工具上限，必须走 --out
py scripts/fetch.py --since 24h --limit 10 \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/today.json
# 然后 Read 那个文件

py scripts/fetch.py --sources bilibili,v2ex --limit 10
py scripts/fetch.py --out runs/latest.json       # 结果写文件（stdout 只回一行收据）

# 只要某个人/某个机构发的，或只要某个话题（子串过滤，人名机构名都行）
# --limit 必须调大：过滤在抓取之后，默认 10 会把排在后面的命中项漏掉
# 查到 0 条是常态（这些都是当日榜单，某人今天没上榜就是没有），不是坏了
# 名字拿不准就先列榜上现有的作者：--fields source,author 走管道 + sort -u
py scripts/fetch.py --since 7d --limit 50 --author "OpenAI,李沐" \
  --fields source,title,url,summary,author,heat,rank,publishedAt
py scripts/fetch.py --since 24h --limit 50 --grep "大模型,Agent"

py scripts/watch.py --add "deepseek,智能体"       # 设一次监控词
py scripts/watch.py                              # 之后每次跑这个，只报新增

py scripts/sources.py list                       # 有哪些信源
py scripts/sources.py health                     # 逐源体检
```

## 五条必读

1. **stdout 只有 JSON**，日志全在 stderr。可以直接管道给 JSON 解析器。
2. **`heat` 跨源不可比** —— 百度热搜是百万级，V2EX 是回复数（几十）。
   **直接按 `heat` 排序会被百度热搜统治。** 跨源可比的是 `rank`（源内排名）。
   排序/去重/归类的完整准则见 `references/taxonomy.md`。
3. **先看 `sources[].ok`**，有源失败要在回答里说明。退出码 `2` = 部分失败，不是错误。
4. **工具单次输出上限约 15,000 字符，超了从「中间」截断，而且不报错。**
   拿到的是合法 JSON、`count` 也正常，只是中间少了一截条目 ——
   会让你误判成「有的源没抓到」，然后再抓一遍。**这是本技能最容易踩的坑。**
   实测：14,308 字符完整读到；16,462 字符被截成 10,039（中间丢 7,070）。
   **别用字节或 KB 估** —— 中文一个字 3 字节，但截断是按**字符**算的。
   `--limit` 是「每源」上限不是总数（13 源 × 10 = 上限 130 条，实测 60 条上下，每天不同）。
   `--fields` **务必留 `summary`** —— 砍掉它省约三成体积，却让你写不出摘要、
   只能把 13 个源重抓一遍，净亏。
5. **可信度要靠措辞表达出来。** 只有单一低信噪源命中就写「未获其他源证实」，
   多源就写「多家报道」。你**没读过正文**，数字、日期一概没核实过，
   **别拿自己的记忆去"确认"当天新闻**。详见 `references/taxonomy.md` §4。

## 中文源今天没有 AI 内容？

节假日中文源会被社会新闻和娱乐占满（百度热搜可能一条 AI 都没有，B站全是游戏动画）。
**这不是故障**，health 照样全绿。**换源，不要换手段** ——
而且既然中文源已经证明是空的，就直接点名国际源，别再抓一遍：

```bash
py scripts/fetch.py --sources hn,lobsters,github --since 24h --limit 10 \
  --fields source,title,url,summary,author,heat,rank,publishedAt
```

20 条 / 6,814 字符（实测），能直接读完。这几个源 AI 内容密度远高于中文热搜。

**这个场景别用 `--all-sources`** —— 它会把 13 个源连同 reddit（必 403）全部重抓，
包括你刚验证过是空的那 9 个中文源，输出约 23,000 字符 **必然被截断**。
`--all-sources` 现在只剩「顺便试试 reddit」这一个用途。

**不要手写 `curl` 去抓榜外站点** —— 那些结果不进归一化、不去重、不进盯盘状态、
`sources[]` 里也留不下记录，等于在技能外面又造了个一次性脚本。缺源就按
`references/sources.md` 加适配器（RSS 三行），或直接告诉用户不在覆盖范围内。

## 文档

| 文件 | 内容 |
|---|---|
| `references/cli.md` | **命令、参数、退出码、JSON schema 的唯一事实源** |
| `references/taxonomy.md` | 排序、去重、归类、摘要的准则 —— **动笔写分析前读它** |
| `references/workflows.md` | 端到端流程：速览 / 盯盘 / 深挖 / 周报 / 排错 |
| `references/sources.md` | 信源端点、已知坑、如何加信源 |
| `references/troubleshooting.md` | 编码、代理、403/422/429、盯盘异常 |
| `SKILL.md` | 同一内容在 Claude Code 技能格式下的版本 |

## 边界

- **不编造**：只有标题时就说「标题显示…」，不要脑补正文。
- **如实报告失败源**，不要让用户以为拿到的是全网。
- **不凑数**：只有 3 条值得说就说 3 条。
- **每条都要有链接**，没有 URL 的跳过。
