/**
 * 榜单类源在**入库前**用的关键词白名单。
 *
 * ## 为什么需要它，且为什么不能省
 *
 * 这与监控词（Topic）里的关键词是**两件事**：
 *
 * - 监控词决定「什么内容值得通知我」——它在 L0 预筛里生效。
 * - 这一份决定「什么内容值得入库」——它在适配器里、落库之前生效。
 *
 * 差别不是洁癖，是实打实的数据：百度热搜榜是全站热搜，实测 51 条里
 * 与 AI 沾边的只有约 3 条，剩下是社会新闻、体育、娱乐。而 **L0 预筛
 * 只挡 AI 花费，不挡入库和展示**——不过滤的话这 48 条会照常写进
 * `HotItem`、照常出现在雷达盘上。用户抱怨的「质量差」有一大半来自这里。
 *
 * ## 为什么复用 `matchesAnyKeyword` 而不是自己写正则
 *
 * 判定「命中」的语义（ASCII 词的字母数字边界、中英同义词组）只应有一份实现。
 * 两层口径一旦漂移，就会产出最难查的脏数据：**条目收进来了、却永远过不了
 * 预筛**——它占着雷达盘的位置，`aiState` 永远停在 `pending`，而没有任何
 * 一处会报错。见 `ai/prefilter.ts` 的 `matchesAnyKeyword`。
 *
 * ## 词表为什么这么短
 *
 * `expandKeyword` 会自动展开同义词组，所以 `'大模型'` 一个词就覆盖了
 * 「大語言模型 / large language model / llm / foundation model / 基础模型」，
 * `'ai'` 覆盖「人工智能 / artificial intelligence」。逐个罗列同义词
 * 只会让这份表看起来很长、维护起来很烦，且必然漏。
 */
import { matchesAnyKeyword } from '../ai/prefilter.js'

/** 榜单源的默认白名单。命中任一即入库。 */
export const DEFAULT_AI_KEYWORDS: readonly string[] = [
  'ai', // 展开为 人工智能 / artificial intelligence
  '大模型', // 展开为 大語言模型 / llm / large language model / 基础模型
  '智能体', // 展开为 agent / ai agent / 代理
  '推理', // 展开为 reasoning / 思维链 / chain of thought
  '开源模型', // 展开为 open weights / 开放权重
  '芯片', // 展开为 算力 / gpu / 显卡 / nvidia / tpu
  '编程', // 展开为 coding / programming / developer / 开发工具 / ide
  '基准测试', // 展开为 benchmark / 评测 / 榜单 / leaderboard
  '机器人',
  '具身智能',
  '自动驾驶',
  '多模态',
  '生成式',
  '深度学习',
  '机器学习',
  '神经网络',
  /*
    厂商名。它们**没有**同义词组，就是两个字面词。

    加这两个是因为实测存在「内容确实是 AI、标题却一个词都不命中」的漏网：
    Solidot 的《律师在谋杀案中捏造了证词，他将此归咎于 ChatGPT》被白名单
    挡掉了——`ChatGPT` 里没有 `ai` 这个词元，而 `ai` 带字母数字边界
    （边界是为了防 `said` 被当成 `ai`），所以命中不了。

    修的**不是**边界规则：去掉边界会让 `ai` 命中 `said`/`train` 之类，
    那是把准确的词表换成模糊的。漏一个词就补一个词。

    注意这两个词同时也会影响榜单源：百度/B站 的标题里出现 ChatGPT/OpenAI
    现在也会入库。这是想要的效果——它们本来就是 AI 热点。
  */
  'chatgpt',
  'openai',
]

/**
 * 读源配置里的关键词白名单。
 *
 * - 没配（`undefined`）→ 用默认表
 * - 显式配成空数组 → **不过滤**，全部收
 *
 * 这两者必须区分开：「我不想过滤」和「我懒得配」是相反的意图，
 * 把它们合并成一个行为，用户就只能靠改代码来表达前者了。
 */
export function readKeywords(config: Record<string, unknown>): string[] {
  const raw = config.keywords
  if (!Array.isArray(raw)) return [...DEFAULT_AI_KEYWORDS]
  return raw
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k !== '')
}

/** `config.keywords` 用这个值表示「用共享的默认 AI 词表」 */
export const DEFAULT_KEYWORDS_SENTINEL = 'default'

/**
 * 读**订阅类源**（RSS）的白名单——**按需开启**，没配就不过滤。
 *
 * ## 为什么不能复用 `readKeywords`
 *
 * 两者的「没配」含义**正好相反**，这不是风格差异，是实测出来的：
 *
 * - 榜单源（百度/B站）是**全站**内容，没配当然要用默认 AI 词表兜底，
 *   否则每轮往雷达盘灌几十条社会新闻。
 * - 订阅源是用户自己挑的，默认应当是「全都想要」。若把 `readKeywords`
 *   那套「没配 → 默认词表」套到 RSS 上，**会静默开始过滤所有订阅源**，
 *   而实测这会误杀真 AI 内容：
 *
 *   ```
 *   《[AINews] Claude Fable/Mythos 5.1: new SOTA model, 75% cache price cut》  不命中
 *   《[AINews] DeepSeek v4.1-Flash: 763B-P8B-D16B novel causal …》           不命中
 *   《Quoting Boris Cherny》（正文讲 Claude 写的生产代码）                     不命中
 *   ```
 *
 *   前两条不命中是因为 `ai` 带字母数字边界，`[AINews]` 后面紧跟的 `N`
 *   把它挡住了；`model` 这种光杆写法也不在词表里（只有 `大模型` 那几组）。
 *   Latent Space 与 Simon Willison 都是 AI 专源，被这样过滤掉大半是纯损失。
 *
 * ## `'default'` 这个哨兵值
 *
 * 想让某个源用共享的 AI 词表（综合科技源就是这种情况，如 Solidot 奇客），
 * 就在 config 里写 `keywords: 'default'`。**不要**把那份词表抄进 config：
 * 抄一份就有两份口径，`ai/prefilter.ts` 开头警告的「两层口径漂移」会立刻成立。
 *
 * ## 语义表（与 `readKeywords` 对照着看）
 *
 * | config.keywords | 这里（订阅源） | `readKeywords`（榜单源） |
 * |---|---|---|
 * | 没配 | **不过滤** | 默认 AI 词表 |
 * | `'default'` | 默认 AI 词表 | 不支持 |
 * | `['a','b']` | 用这两个词 | 用这两个词 |
 * | `[]` | 不过滤 | 不过滤 |
 *
 * 落地都用 `passesTitleFilter`，所以「只看标题」这条口径是共用的。
 */
export function readOptInKeywords(config: Record<string, unknown>): string[] {
  const raw = config.keywords
  // 没配 = 订阅源保持原样全收。**这是本函数存在的全部理由**，别改成回默认词表
  if (raw === undefined || raw === null) return []
  if (raw === DEFAULT_KEYWORDS_SENTINEL) return [...DEFAULT_AI_KEYWORDS]
  if (!Array.isArray(raw)) return []
  return raw
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k !== '')
}

/**
 * **标题**是否命中白名单。`keywords` 为空 = 不过滤，一律算命中。
 *
 * ## 为什么只看标题，不看摘要（这是实测调出来的，不是洁癖）
 *
 * 收摘要进来会让误报率翻倍。实测某一刻的百度热搜 7 条里，**4 条只在摘要
 * 命中、标题完全不沾边**，全部是误报：
 *
 * | 条目 | 摘要里命中的部分 | 靠哪个词 |
 * |---|---|---|
 * | 网传「外卖员向餐食吐口水」系摆拍 | 封签**代理**商 | `智能体` 展开出的 `代理` |
 * | 义乌开始卖飞碟了 | 能下水的**自动驾驶**飞碟 | `自动驾驶` |
 * | 周鸿祎：不会再投资新能源车 | 建议创业者掌握 **AI Agent** | `ai` / `智能体` |
 * | 微信 三折叠 | 灰测 **AI Agent**「小微」 | `ai` / `智能体` |
 *
 * 这四条有个共同点：摘要里那句话都不是这条内容的主题，而是顺带一提
 * （「外卖员」那条的 `代理` 甚至根本不是同一个词义）。标题才是
 * 「这条内容在讲什么」的唯一可靠信号。B站 同理——热门榜里
 * 《三年之期已到…【第9集】》的摘要写的是「AI生成视频，非真实事件」，
 * 那是免责声明，不是内容。
 *
 * ## 为什么参数就叫 `title` 而不是 `text`
 *
 * 这个策略唯一的失效方式，是有人热心地在这里加回摘要。把参数名写成
 * `text` 就是在邀请这件事发生，所以名字直接写明它收什么。
 * 要放开就得先改签名，那一步会逼着人回来看这段注释。
 *
 * 注意这与 L0 预筛（`ai/prefilter.ts`）的口径**故意不一致**：预筛那边
 * 必须连摘要一起看（宁松勿紧，漏报比误报难发现，见那里的说明）。
 * 这里是在入库前做取舍，取向相反，所以不能共用同一个入口函数。
 */
export function passesTitleFilter(title: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true
  return matchesAnyKeyword(title, keywords).length > 0
}
