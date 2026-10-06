# hotspot-radar

一个**自包含**的跨源热点监控技能：抓取多个公开信源 → 归一化成统一 JSON →
由 Agent（Claude Code / Codex / Cursor / Copilot…）负责分析。

```
下载 → 跑一条命令 → 拿到 JSON。没有第三步。
```

## 为什么是「自包含」

很多热点监控工具要求你先起服务、配数据库、申请 API Key。
这个技能**什么都不需要**：

| | |
|---|---|
| API Key | **不需要**，13 个默认信源全部免密钥 |
| 第三方依赖 | **不需要**，只用 Python 3 标准库，无 `pip install` |
| 常驻服务 | **不需要**，脚本跑完就退出 |
| 数据库 | **不需要**，盯盘状态存在 `~/.hotspot-radar/` 的 JSON 里 |
| LLM API | **不需要**，分析由调用它的 Agent 完成，零 token 费用 |

唯一的依赖是 **Python 3.8+**。

脚本**只抓取、归一化，外加一组确定性的子串过滤**（`--author` / `--grep`：
「这个字符串在不在」）。相关性排序、跨源去重合并、可信度分级、写摘要
全部由 Agent 完成 —— 脚本不判断、不调用任何模型。

## 安装

**方式一：整目录拷走。** 这个目录就是全部，复制到任何地方都能用。

```bash
cp -r hotspot-radar ~/skills/          # 或直接用当前的路径
python3 ~/skills/hotspot-radar/scripts/fetch.py --since 24h
```

**方式二：在 Claude Code 里用。** 放进 skills 目录即可被自动识别（无需注册）：

```bash
# 项目级
cp -r hotspot-radar <你的项目>/.claude/skills/

# 或用户级（所有项目都能用）
cp -r hotspot-radar ~/.claude/skills/
```

macOS/Linux 也可以软链，避免维护两份：

```bash
ln -s "$PWD/hotspot-radar" ~/.claude/skills/hotspot-radar
```

**方式三：其他 Agent。** 见下文「跨 Agent」。

## 快速上手

Windows 用 `py`，macOS/Linux 用 `python3`。

```bash
# 现在有什么热点（结果写文件，stdout 只回一行收据）
py scripts/fetch.py --since 24h --limit 10 \
  --fields source,title,url,summary,author,heat,rank,publishedAt \
  --out ~/.hotspot-radar/runs/today.json

# 只看某几个源
py scripts/fetch.py --sources v2ex,bilibili,36kr

# 只看某个人 / 某个机构发的（人名、机构名都可以）
# --limit 要给大：过滤在抓取之后，默认 10 会漏掉排在后面的条目
# 示例里的名字只是占位 —— 这些都是当日榜单，查到 0 条是常态，不代表坏了
py scripts/fetch.py --since 7d --limit 50 --author "OpenAI,李沐" \
  --fields source,title,url,summary,author,heat,rank,publishedAt

# 只看某个话题
py scripts/fetch.py --since 24h --limit 50 --grep "大模型,Agent"

# 结果写文件（stdout 只回一行收据，避免大 JSON 被读两遍）
py scripts/fetch.py --out "$HOME/.hotspot-radar/runs/today.json"

# 盯盘：设一次监控词，之后每次跑都只报「上次之后新增」的
py scripts/watch.py --add "deepseek,智能体,MCP"
py scripts/watch.py

# 排查某源为什么没数据
py scripts/sources.py health
```

## 信源

**13 个默认开启，全部在中国大陆网络直连实测可用，全部免密钥：**

| id | 名称 | 形式 |
|---|---|---|
| `bilibili` | B站热门视频 | JSON API |
| `baidu` | 百度热搜 | HTML 内嵌 JSON |
| `juejin` | 掘金推荐 | JSON API |
| `github` | GitHub 仓库搜索 | JSON API |
| `github-trending` | GitHub Trending | HTML |
| `v2ex` | V2EX 热帖 | JSON API |
| `36kr` | 36氪 | RSS |
| `infoq` | InfoQ 中国 | RSS |
| `sspai` | 少数派 | RSS |
| `ruanyifeng` | 阮一峰的网络日志 | Atom |
| `solidot` | Solidot | RSS |
| `hn` | Hacker News (Algolia) | JSON API |
| `lobsters` | Lobsters | JSON API |

最后两个英文源**默认开着是有意的**：节假日中文源会被社会新闻占满，
那时 AI 内容基本只剩它俩。

**默认关闭的只剩** `reddit`（实测 403，需代理），用 `--sources reddit --proxy …` 开启。
`--all-sources` 如今等于「13 个默认源 + reddit」，**基本不需要**。

**不支持：** 知乎（需签名 Cookie）、机器之心（RSS 已失效）、RSSHub（站点不通）。

> 可达性会随网络环境变化。判断此刻哪些源能用，跑 `py scripts/sources.py health`。

## 输出

```json
{
  "schema": "hotspot-radar/fetch/v1",
  "count": 53,
  "sources": [{ "id": "bilibili", "ok": true, "count": 5, "ms": 239, "error": null }],
  "items": [{
    "id": "bilibili:BV1ndHf6xEsz",
    "source": "bilibili",
    "title": "……",
    "url": "https://www.bilibili.com/video/BV1ndHf6xEsz",
    "summary": "……", "author": "……",
    "publishedAt": "2026-10-06T09:25:43Z",
    "heat": 172539, "rank": 1, "lang": "zh",
    "raw": { "view": 172539, "like": 9000 }
  }]
}
```

- **stdout 只有 JSON**，所有日志走 stderr。
- 退出码：`0` 全成功 / `2` 部分失败 / `3` 全失败 / `1` 用法错误。
  **JSON 内容才是准。**
- ⚠️ **`heat` 跨源不可比**（百度百万级、V2EX 几十）。跨源排序用 `rank`。

完整 schema 见 [`references/cli.md`](references/cli.md)。

## 目录结构

```
hotspot-radar/
├── SKILL.md                    Claude Code / agentskills.io 入口
├── AGENTS.md                   通用 Agent 入口（Codex/Cursor/Amp/Windsurf）
├── README.md                   本文件
├── scripts/
│   ├── _common.py              引擎：HTTP、归一化、RSS/Atom 解析、状态工具
│   ├── sources.py              信源注册表 + 适配器 + list/health/export
│   ├── fetch.py                抓取 → JSON
│   ├── watch.py                盯盘：监控词 diff
│   └── install-shims.py        可选：装 AGENTS.md / Copilot 指令
└── references/
    ├── cli.md                  命令与 schema（唯一事实源）
    ├── sources.md              信源端点与已知坑
    ├── workflows.md            端到端流程
    ├── taxonomy.md             排序/去重/归类准则
    └── troubleshooting.md      排错
```

## 跨 Agent

核心内容（`SKILL.md` + `scripts/` + `references/`）是 Agent 无关的。
按你的工具选入口：

| Agent | 怎么用 |
|---|---|
| **Claude Code** | 放进 `.claude/skills/`（或 `~/.claude/skills/`），自动识别，无需注册 |
| **Codex / Cursor / Amp / Windsurf** | 读 `AGENTS.md`。若工具只在仓库根找，跑 `py scripts/install-shims.py --agents-md` |
| **GitHub Copilot** | 跑 `py scripts/install-shims.py --copilot` 生成 `.github/copilot-instructions.md` |
| **其他** | 把 `AGENTS.md` 的内容贴进你的 system prompt |

`install-shims.py` 生成的都是**几行的指针**，内容本体只在 `skills/hotspot-radar/` 下，
不会产生两份需要同步维护的副本。默认**什么都不做**，不碰技能目录以外的任何位置。

## 常见问题

**中文输出乱码？** 脚本已自动切 UTF-8。仍乱码就加 `--ascii`，或设 `PYTHONUTF8=1`。

**要挂代理？** `--proxy http://127.0.0.1:7890`。
**只支持 HTTP 代理，不支持 SOCKS** —— 用 Clash 的 HTTP 端口，不是 SOCKS 端口。

**盯盘每次都报一堆新增？** 先看输出的 `baseline` 字段 ——
`true` 表示这是首次运行或状态被重建，不是真的新增。

**为什么示例都写 `--out` 而不是直接看输出？** 因为 AI 工具单次读取输出有上限
（约 15,000 字符），超了会**从中间截断，而且不报错** ——
看到的是合法的、只是少了一截条目的 JSON。速览约 23,000 字符，远超这条线。
写文件后 stdout 只回一行收据，再读文件即可，一定完整。
结果很小（点名两三个源、或不要 `summary`）时可以不走 `--out`。

**它会自己判断消息真假吗？** 不做事实核查 —— 判断者就是调用它的 Agent 本身。
它会按「命中几个源」「源是什么级别」「措辞是否流量化」给出**可信度分级**，
并在措辞里体现出来：单源写「据 X 报道，未获其他源证实」，多源写「多家报道」。
但它**没读过正文**，任何数字、日期、金额都不会替你核实 ——
用户追问时它应该说「我只能看到标题」，而不是猜。
准则见 [`references/taxonomy.md` §4](references/taxonomy.md)。

**某个源总是失败？** 这是预期内的，`reddit` 从大陆直连就是 403。
部分失败不影响整轮，退出码 `2` 就是这个意思。跑 `sources.py health` 确认。

**`github` 报 403 rate limit exceeded？** GitHub 无 token 搜索限 **10 次/分钟**，
连跑几次体检就会把自己的 IP 打爆。等一分钟即可；
想省事就设 `GH_TOKEN`（可选，不设也完全能用）提到 30 次/分钟。
注意 GitHub 限流返回的是 **403 不是 429**，别误判成"被墙"。

更多见 [`references/troubleshooting.md`](references/troubleshooting.md)。

## 加自己的信源

改 `scripts/sources.py` 的注册表。加一个 RSS 只要三行
（`_parse_feed_items` 是现成的通用解析器）：

```python
_register({
    "id": "mysite", "name": "我的源", "kind": "rss",
    "default": True, "lang": "zh", "reach": "cn",
    "request": "https://example.com/feed",
    "headers": {"user-agent": UA_CHROME},
    "parse": _parse_feed_items("mysite", "zh"),
})
```

写非 RSS 的适配器见 [`references/sources.md`](references/sources.md) 末尾。

## License

随宿主仓库。
