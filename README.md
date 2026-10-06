# ai-hot

AI 领域的热点聚合与分诊系统。从多个公开源采集资讯，用分层 AI 做相关性判断和真实性交叉验证，聚合成热点簇，命中你设定的监控词时推送通知。

## 这个项目解决什么

信息源太散、噪音太大。这个项目做两件事：

1. **聚合** —— 把散在百度热搜、B 站、GitHub Trending、RSS、Hacker News 等处的 AI 相关资讯收进一个时间线，去重、聚合、按热度排序。
2. **分诊** —— 用 AI 判断"这条和我关心的领域有关吗""这条可信吗"，把噪音挡在外面。

关键在于**分层**：绝大多数条目用零成本的纯代码规则筛掉，只有少数"值得花钱"的才送进大模型。配合每日 token 预算和结果缓存，让长期运行的成本可控。

## 核心特性

- **分层 AI 分诊** —— L0 规则预筛（零成本）→ L1 相关性 → L2 真实性 → L3 交叉验证。超预算时自动降级为只跑 L0 + L1，服务不中断。
- **12 个数据源适配器** —— 全部免 API key，打公开端点。单源失败被完全隔离，不影响其它源。
- **热点聚类** —— 把报道同一件事的多条资讯归成一个簇，按簇展示而不是按条。
- **监控词 + 通知** —— 自定义关键词规则，命中后经邮件等渠道推送。
- **实时推送** —— WebSocket 广播，前端状态条实时更新，无需手动刷新。
- **可视化任务调度** —— 5 个定时任务（采集/分诊/发现/日报/清理）可在界面上看到下次运行时间并手动触发。
- **降级优先** —— 缺 API key、缺 SMTP、数据库暂时不可用，都不阻止服务启动，只是对应能力静默禁用。

## 技术栈

### 后端 `server/`

| 用途 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 20（用到 `process.loadEnvFile`，建议 20.12+） |
| Web 框架 | Express 5 |
| 数据库 | SQLite + Prisma 6（11 个模型，5 个迁移） |
| 实时通道 | `ws` 8，与 HTTP 共用一个 `http.Server` |
| 定时任务 | `node-cron` 3（触发）+ 自研 cron 解析器（算 `nextRunAt`） |
| 数据采集 | `rss-parser` + `cheerio` |
| 参数校验 | Zod |
| AI | DeepSeek（OpenAI 兼容协议，直接用全局 `fetch`，**不引 SDK**） |
| 通知 | `nodemailer`（邮件）、`web-push`（Web Push） |
| 测试 | Vitest（41 个测试文件） |
| 开发运行 | `tsx` |

### 前端 `web/`

| 用途 | 选型 |
|---|---|
| 框架 | React 19 |
| 构建 | Vite 7 |
| 样式 | Tailwind CSS v4（`@theme` 标记，无 config 文件） |
| 动画 | `motion`（仅两处动态引入，刻意不占首屏） |
| 图标 | `lucide-react` |
| 字体 | `@fontsource-variable/*`（**打包进产物，不走 Google Fonts**） |

> 字体和图标全部本地化是有意为之：`fonts.googleapis.com` 在国内基本不可达，走 CDN 会让首屏卡住。

## 项目结构

```
ai-hot/
├── package.json              # npm workspaces 根，统一入口脚本
├── tsconfig.base.json        # 共享 TS 配置（注意：noEmit: true）
├── .env.example              # 环境变量模板，复制到 server/.env
│
├── server/                   # 后端
│   ├── prisma/
│   │   ├── schema.prisma     # 11 个数据模型
│   │   ├── migrations/       # 5 个迁移
│   │   └── dev.db            # SQLite 文件（已 gitignore）
│   ├── scripts/
│   │   └── backfill-scores.ts  # 给历史数据回填热度分
│   ├── tests/                # 41 个测试文件
│   └── src/
│       ├── index.ts          # 进程入口：装配、启动、优雅关闭
│       ├── app.ts            # Express 应用装配（中间件 + 路由挂载）
│       ├── env.ts            # 环境变量 schema（Zod）与校验
│       ├── db.ts             # PrismaClient 构造
│       ├── errors.ts         # HttpError 与统一错误处理
│       ├── stats.ts          # 统计计算与周期广播
│       ├── window.ts         # 时间窗口工具
│       │
│       ├── routes/           # HTTP 接口层（11 个文件，按资源划分）
│       │   ├── items.ts      #   条目查询（筛选/排序/分页）
│       │   ├── stats.ts      #   统计卡片数据
│       │   ├── topics.ts     #   监控词增删改查
│       │   ├── jobs.ts       #   任务列表与手动触发
│       │   ├── sources.ts    #   数据源管理与健康状态
│       │   ├── search.ts     #   站外搜索（走搜索类适配器）
│       │   ├── notifications.ts
│       │   ├── settings.ts   #   键值配置读写
│       │   ├── logs.ts       #   内存日志环形缓冲的读取
│       │   ├── ai.ts         #   AI 用量统计、单条验证
│       │   └── health.ts     #   健康检查（真的会探库）
│       │
│       ├── ai/               # 分层 AI 引擎
│       │   ├── index.ts      #   门面：createAiLayer
│       │   ├── prefilter.ts  #   L0 纯代码预筛（关键词/同义词/去重/排除词）
│       │   ├── relevance.ts  #   L1 相关性判断
│       │   ├── authenticity.ts #  L2 真实性判断
│       │   ├── crosscheck.ts #   L3 跨源交叉验证
│       │   ├── triage.ts     #   打分编排（只写 HotItem，不写 Match）
│       │   ├── client.ts     #   DeepSeek 客户端（超时/重试/降级）
│       │   ├── budget.ts     #   每日 token 预算跟踪
│       │   ├── cache.ts      #   结果缓存（promptHash 索引）
│       │   └── mock.ts       #   AI_MOCK=1 时的确定性回包
│       │
│       ├── jobs/             # 定时任务
│       │   ├── registry.ts   #   任务登记表（cron 表达式在这里）
│       │   ├── scheduler.ts  #   调度器：并发锁、JobRun 记录、状态查询
│       │   ├── cron.ts       #   自研 cron 解析 + nextRunAt 计算
│       │   ├── collect.ts    #   采集（每 15 分钟）
│       │   ├── triage.ts     #   分诊（每小时 :10）
│       │   ├── discover.ts   #   领域发现（每 6 小时）
│       │   ├── digest.ts     #   日报（每天 09:00）
│       │   ├── cleanup.ts    #   清理 30 天前的 raw 字段（每天 04:00）
│       │   └── seams.ts      #   依赖注入接缝（便于测试解耦）
│       │
│       ├── sources/          # 数据源适配器
│       │   ├── registry.ts   #   适配器注册表
│       │   ├── seed.ts       #   默认数据源种子（幂等 upsert）
│       │   ├── http.ts       #   统一请求封装（UA/超时/重试）
│       │   ├── rss.ts / bilibili.ts / baidu-hot.ts / github-trending.ts
│       │   ├── hackernews.ts / hn-algolia.ts / reddit.ts
│       │   └── *-search.ts   #   搜索类（靠 query 驱动，无 query 返回空）
│       │
│       ├── pipeline/         # 采集后处理：ingest → 去重 → 互动量
│       ├── cluster/          # 热点聚类：归一化 → 相似度 → 成簇
│       ├── score/            # 打分纯函数：热度/领域/重要度（无 IO）
│       ├── discover/         # 领域画像与发现评分
│       ├── triage/           # 监控词匹配 → 写 Match → 触发通知
│       ├── notify/           # 通知渠道：邮件 / Web Push
│       ├── realtime/         # WebSocket 服务端 + 内存日志总线
│       └── util/             # 并发控制（mapLimit）、文本工具
│
├── web/                      # 前端
│   ├── index.html
│   ├── vite.config.ts        # dev server 代理 /api 与 /ws 到 8787
│   └── src/
│       ├── main.tsx          # 入口（含字体引入）
│       ├── App.tsx           # 三个 Tab 的状态机
│       ├── styles.css        # Tailwind v4 主题与自定义层
│       ├── net/              # 网络层
│       │   ├── api.ts        #   所有 HTTP 调用的唯一出口
│       │   └── useRealtime.ts#   WebSocket 连接、心跳、退避重连
│       ├── state/            # 数据 hook：useDashboard/useFeed/useTicker 等
│       ├── components/
│       │   ├── ui/           #   基础组件：Card/Field/Button/Badge/Toast 等
│       │   ├── aceternity/   #   视觉组件（Meteors/Spotlight/NumberTicker…）
│       │   ├── HotspotCard.tsx / StatCards.tsx / FilterSortBar.tsx
│       │   ├── KeywordPanel.tsx / SearchPanel.tsx / NotificationBell.tsx
│       │   └── AppHeader.tsx / TabNav.tsx / LiveTicker.tsx
│       ├── lib/              # cn()=twMerge+clsx、格式化、归一化
│       └── types.ts          # 与后端 DTO 对齐的类型
│
└── skills/                   # Agent Skill —— 独立于上面的服务，不共享代码
    └── hotspot-radar/        # 自包含热点监控技能（零依赖 CLI + 文档）
        ├── SKILL.md          # Claude Code 入口
        ├── AGENTS.md         # 通用 Agent 入口（Codex/Cursor/…）
        ├── README.md         # 技能自己的说明
        ├── scripts/          # fetch / watch / sources 等（仅标准库）
        └── references/       # CLI、信源、流程、准则、排错
```

## 快速开始

### 1. 环境要求

- **Node.js ≥ 20**（建议 20.12+，入口用到 `process.loadEnvFile`）
- npm（项目用 npm workspaces，不需要 pnpm/yarn）

### 2. 安装依赖

```bash
git clone https://github.com/lc-lly/ai-hot.git
cd ai-hot
npm install
```

根目录执行即可，workspaces 会一并安装 `server/` 和 `web/`。

### 3. 配置环境变量

```bash
cp .env.example server/.env
```

**注意目标路径是 `server/.env`，不是根目录。** 入口用 `process.loadEnvFile()` 从**当前工作目录**读 `.env`，而 `server` 的启动脚本 cwd 是 `server/`；放在根目录读不到，且失败是静默的。

所有变量都有默认值，**不填也能启动**——只是对应能力会禁用：

| 变量 | 默认 | 不填的后果 |
|---|---|---|
| `PORT` | `8787` | — |
| `DATABASE_URL` | `file:./dev.db` | 相对 `server/prisma/` 解析 |
| `DEEPSEEK_API_KEY` | 空 | **AI 层整体禁用**，条目停在 `pending`，服务照跑 |
| `DEEPSEEK_MODEL_FAST` | `deepseek-flash` | 模型名走配置，不硬编码 |
| `DEEPSEEK_MODEL_SMART` | `deepseek-v4-pro` | 同上 |
| `AI_MOCK` | `0` | 置 `1` 时 AI 返回固定结果，用于离线开发 |
| `AI_DAILY_TOKEN_BUDGET` | `200000` | 超出后降级为只跑 L0 + L1 |
| `SMTP_URL` | 空 | 邮件渠道自动禁用 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 空 | Web Push 渠道自动禁用 |
| `LOG_LEVEL` | `info` | — |

**只想先跑起来看看**：什么都不用改，直接下一步。数据源全是免 key 的。

完整列表见 `.env.example`。其中有三个变量**当前代码里没有任何地方消费**，属于尚未落地的设计，填了不生效：`AI_HOT_TOKEN`（预留给接口鉴权）、`TWITTERAPI_IO_KEY`、`FIRECRAWL_API_KEY`（预留给付费数据源）。

### 4. 建库

```bash
npm run db:migrate
```

首次克隆必须执行——`dev.db` 被 gitignore 了，仓库里没有。

### 5. 启动

```bash
npm run dev
```

一条命令同时拉起前后端：

- 后端 → `http://localhost:8787`
- 前端 → `http://localhost:5173`（Vite 把 `/api` 和 `/ws` 代理到 8787）

打开 `http://localhost:5173` 即可。

> **首屏是空的，这是正常的。** 定时任务在启动时**不会预热**，第一次 `collect` 要等到下一个 15 分钟边界（`:00` / `:15` / `:30` / `:45`）。
> 想立刻看到数据：点界面上的**「立即扫描」**按钮，等价于 `POST /api/jobs/collect/run`。

## 命令参考

在项目根目录执行：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 同时启动前后端（开发用） |
| `npm run dev:server` | 只启动后端 |
| `npm run dev:web` | 只启动前端 |
| `npm test` | 跑后端测试（Vitest，41 个文件） |
| `npm run typecheck` | 前后端类型检查 |
| `npm run db:migrate` | 创建/更新数据库结构（`prisma migrate dev`） |

在 `server/` 目录下另有：

| 命令 | 作用 |
|---|---|
| `npm run start -w @ai-hot/server` | 启动后端（不带 watch） |
| `npm run db:studio -w @ai-hot/server` | 打开 Prisma Studio 可视化查库 |
| `npx tsx scripts/backfill-scores.ts` | 给历史条目回填热度分 |

## API 一览

所有接口在 `/api` 下，**目前没有鉴权**（见文末「已知限制」）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，会真的 `SELECT 1` 探库；库挂时返回 503 |
| GET | `/api/items` | 条目查询，支持筛选、排序、分页 |
| GET | `/api/stats` | 统计卡片数据 |
| GET | `/api/topics` | 监控词列表 |
| POST | `/api/topics` | 新建监控词 |
| PATCH | `/api/topics/:id` | 修改监控词（含启用开关） |
| DELETE | `/api/topics/:id` | 删除监控词 |
| GET | `/api/jobs` | 任务列表，含 `lastRunAt` / `nextRunAt` |
| POST | `/api/jobs/:name/run` | 手动触发任务 |
| GET | `/api/discover` | 领域发现结果 |
| GET | `/api/sources` | 数据源列表 |
| POST | `/api/sources` | 新增数据源 |
| POST | `/api/sources/:id/collect` | 单独触发某个源采集 |
| GET | `/api/sources/health` | 各源最近一次采集的健康状况 |
| GET | `/api/search` | 站外搜索（走搜索类适配器） |
| GET | `/api/notifications` | 通知列表 |
| GET | `/api/notifications/channels` | 各通知渠道状态（含禁用原因） |
| POST | `/api/notifications/read-all` | 全部标记已读 |
| POST | `/api/notifications/:id/read` | 单条标记已读 |
| GET | `/api/settings` / `/api/settings/:key` | 读取配置 |
| GET | `/api/logs` | 内存日志（环形缓冲，固定 500 条） |
| GET | `/api/ai/stats` | AI 调用量与预算使用情况 |
| POST | `/api/ai/verify` | 对单条内容做一次 AI 验证 |
| WS | `/ws` | 实时通道，广播 stats / log / item / notification |

## AI 分层与成本控制

送进大模型的每一条都要花钱，所以分四层，**逐层收窄**：

| 层 | 做什么 | 成本 |
|---|---|---|
| **L0** | 关键词与同义词正则、URL/内容哈希去重、排除词过滤 | 纯代码，**零成本** |
| **L1** | 相关性判断（这条和我的领域有关吗） | 便宜模型 |
| **L2** | 真实性判断（这条可信吗、是不是标题党） | 便宜模型 |
| **L3** | 跨源交叉验证（多个源是否互相印证） | 按需 |

L0 的取向是**宁松勿紧**——误放进来的代价是一次便宜的 L1 调用，误挡掉的代价是漏掉一条热点，而漏报比误报更难被发现。

**两道成本闸门**：

- **每日 token 预算**（`AI_DAILY_TOKEN_BUDGET`）——用量从 `AiCall` 表按天汇总。超预算后除 L1 外全部拒绝，即 spec 所说的"降级为只跑 L0 + L1"。
- **结果缓存**（`AiCache` 表）——按 `promptHash` 索引，命中缓存的调用在预算检查**之前**返回，所以超预算时仍能吃到缓存结果。

## 数据源

12 个适配器，**全部免 API key**：

| 类型 | 源 |
|---|---|
| 热榜 | 百度热搜、B 站综合热门、GitHub Trending |
| RSS | InfoQ 中文、Solidot、Google AI Blog、Simon Willison、Latent Space |
| 社区 | Hacker News、HN Algolia 搜索、Reddit |
| 搜索类 | B站搜索、搜狗微信、必应搜索、GitHub 搜索 |

搜索类是**靠 query 驱动**的，没有 query 就返回空数组，不会每轮往站外打空查询。

默认种子里 `reddit` 是**禁用**的——国内网络对 `reddit.com` 存在 DNS 污染，实测 TCP 超时。`hackernews`（Google Firebase）、`hn-algolia` 和几个境外 RSS 在国内机房也不可达，部署到国内服务器时建议一并禁用。

## 技能：hotspot-radar

`skills/hotspot-radar/` 是一个**自包含的 Agent Skill**（Claude Code / Codex / Cursor 等通用）。
它和上面的服务是**两条独立的路径，不共享任何代码**：

| | `server/` + `web/` | `skills/hotspot-radar/` |
|---|---|---|
| 形态 | 常驻进程 + SQLite + 前端 | 一组 CLI，跑完即退出 |
| 依赖 | Node 20、Express、Prisma… | **只要 Python 3.8+，仅标准库** |
| API Key | DeepSeek（可选） | **不需要**，13 个源全部免密钥 |
| 谁做分析 | 分层 AI（L0–L3，花 token） | **调用它的 Agent 本身**，零 token 费用 |

一句话：服务是「长期跑、自动分诊、命中就推送」；技能是「你问一次、它抓一次、Agent 自己读完给你答」。

### 安装

不用 clone 整个仓库（`server/` + `web/` 和这个技能无关），一行装完：

```bash
npx skills add lc-lly/ai-hot --skill hotspot-radar      # 装到当前项目
npx skills add lc-lly/ai-hot --skill hotspot-radar -g   # 装到用户级，所有项目可用
npx skills add lc-lly/ai-hot -l                         # 只列出仓库里有哪些 skill，不安装
```

装好后**不用记任何命令**，直接用自然语言问：

> 今天 AI 圈有什么热点？
> 最近 DeepSeek 有什么进展？
> 帮我盯「智能体、MCP」这几个词，之后只报新增的。

抓取和归一化由 Python 脚本完成，去重、聚类、排序、摘要由**调用它的 Agent** 完成，
所以这一步不烧 token。想脱离 Agent 手动跑，命令见文末的 `references/cli.md`。

### ⚠️ 它查的是**榜单数据**，不是搜索

这是理解它输出的前提 —— **13 个源全是热榜 / RSS / Trending**：
百度热搜、B站综合热门、掘金推荐、GitHub 搜索、GitHub Trending、V2EX 热帖、
36氪、InfoQ 中国、少数派、阮一峰、Solidot、Hacker News、Lobsters。

> 注意这份清单和上面 `server/` 的 12 个适配器**是两套独立实现**，别混用。

**榜单回答的是「此刻什么在被讨论」，不是「关于 X 的一切」。** 由此有三条硬约束：

1. **只有进榜的内容才拿得到。** 没上榜、或排在榜单靠后的，一条都抓不到 ——
   这是榜单本身就没有，不是抓取失败。
2. **榜单是当日快照。** 每天换一批，今天没有不代表功能坏了。
3. **榜单是全品类的，不是 AI 频道。** 百度热搜、B站热门、Lobsters 上 AI 内容
   往往只占少数 —— 实测 `--since 24h --limit 10` 抓到 **61 条**，其中
   **约 42 条（69%）和 AI 完全无关**（时政、体育、游戏番剧、系统编程）。
   所以输出里的 **`count` 是「抓取条数」，不是「AI 热点条数」**，
   两者的落差是正常漏斗（过滤 → 跨源去重 → 聚类），不是丢数据。

由此推论：**「枚举某个人/某个机构的全部产出」它做不到** —— 榜单里没有的人就是没有，
B站 UP主 投稿接口实测也需要登录态。这类需求得先 `WebSearch` 找人发了什么，
再把主题词拿回技能的 `--grep` 去 13 个源里做跨源匹配。

技能另有 `--author` / `--grep` 做确定性子串过滤（人名、机构名都支持），
完整命令、schema 与踩坑记录见
[`skills/hotspot-radar/README.md`](skills/hotspot-radar/README.md)
和 [`references/cli.md`](skills/hotspot-radar/references/cli.md)。

## 测试

```bash
npm test
```

41 个测试文件覆盖适配器解析、聚类、打分、AI 各层、HTTP 接口、WebSocket、cron 解析。

测试用独立的 `test.db`（`server/tests/global-setup.ts` 里自动执行 `prisma migrate deploy` 建库），不会碰你的开发数据。

## 已知限制

- **接口无鉴权**。所有 `/api/*` 和 `/ws` 都是开放的，包括能触发采集与 AI 分诊的 `POST /api/jobs/:name/run`。**仅适合本地或内网运行**，暴露到公网前必须自行加访问控制，否则任何人都能消耗你的 AI 额度。
- **不能跑多副本**。任务锁是进程内的（`jobs/scheduler.ts` 的 `inflight` 集合），没有分布式锁；多副本会导致定时任务重复执行并争抢 SQLite 写锁。
- **Web Push 未接通**。服务端有完整的 `web-push` 实现，但前端没有 service worker、没有订阅上报，服务端也没有订阅路由。配了 VAPID 也不会生效，目前只有邮件渠道可用。
- **生产化配置未就绪**。没有 `build` 脚本（`tsconfig.base.json` 是 `noEmit: true`，`tsx` 在 devDependencies），也没有 `prisma migrate deploy` 脚本，直接以生产方式启动需要先补齐。
- **cron 使用进程本地时区**。日报的 09:00 是服务器本地时间，部署到 UTC 机器会变成北京时间 17:00。

## 许可

未声明。
