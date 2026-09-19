/**
 * L0 —— 预筛（纯代码，零 AI 成本）。
 *
 * 职责（spec §4 表格第一行）：
 *   1. 关键词正则命中，含中英同义词
 *   2. URL / 内容哈希去重
 *   3. 排除词过滤
 *
 * 这一层决定「哪些条目值得花钱送 AI」，所以它的取向是**宁松勿紧**：
 * 误放进去的代价是一次便宜的 L1 调用，误挡掉的代价是漏掉一条热点，
 * 而 spec §4.2 明确说漏报比误报更难被发现。
 */

/** 中英同义词组。同一组内的词在匹配时互相等价。 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['大模型', '大語言模型', 'large language model', 'llm', 'foundation model', '基础模型'],
  ['开源', 'open source', 'opensource', 'oss', '开放源代码'],
  ['开源模型', 'open weights', '开放权重', 'open-weight'],
  ['编程', '编程工具', '写代码', 'coding', 'programming', 'developer', '开发工具', 'ide', '编辑器', 'editor'],
  ['代码', 'code', '源码', 'source code', '仓库', 'repository'],
  ['智能体', 'agent', 'agents', 'ai agent', '代理'],
  ['提示词', 'prompt', 'prompts', '提示工程', 'prompt engineering'],
  ['推理', 'reasoning', '思维链', 'chain of thought', 'cot', '推理模型'],
  ['微调', 'fine-tune', 'finetune', 'fine tuning', '微調', '训练'],
  ['算力', 'gpu', '显卡', '芯片', 'chip', 'nvidia', 'tpu', 'accelerator'],
  ['融资', 'funding', '投资', 'investment', '估值', 'valuation', 'ipo'],
  ['发布', 'release', 'released', '上线', 'launch', '更新', 'update', '正式版', 'ga'],
  ['模型', 'model', 'models'],
  ['语言模型', 'language model', 'lm'],
  ['人工智能', 'artificial intelligence', 'ai'],
  ['基准测试', 'benchmark', '评测', '榜单', 'leaderboard'],
  ['招聘', 'hiring', 'job', 'jobs', 'we are hiring'],
]

const normalizeTerm = (term: string): string => term.trim().toLowerCase()

/** 关键词 → 同义词展开表，进程级构建一次 */
const SYNONYM_INDEX: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>()
  for (const group of SYNONYM_GROUPS) {
    const members = [...new Set(group.map(normalizeTerm))].filter(Boolean)
    for (const member of members) {
      const existing = index.get(member) ?? []
      index.set(member, [...new Set([...existing, ...members])])
    }
  }
  return index
})()

const ASCII_ONLY = /^[\x20-\x7e]+$/

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把一个词编译成匹配正则。
 *
 * 纯 ASCII 的词加**字母数字边界**：否则关键词 `rust` 会命中 `trust`、
 * `ai` 会命中 `said`、`train` 会命中 `training` 之外的无数噪音。
 * 中文没有词边界概念，加了反而永远匹配不上，所以只做子串匹配。
 */
function compileTerm(term: string): RegExp | null {
  const trimmed = term.trim()
  if (!trimmed) return null
  const escaped = escapeRegExp(trimmed)
  if (ASCII_ONLY.test(trimmed)) {
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
  }
  return new RegExp(escaped, 'i')
}

function compileAll(terms: readonly string[]): RegExp[] {
  const out: RegExp[] = []
  for (const term of terms) {
    const re = compileTerm(term)
    if (re) out.push(re)
  }
  return out
}

/** 关键词展开成「自身 + 同义词组」的正则列表。返回的正则与输入顺序一一对应。 */
export function expandKeyword(keyword: string): string[] {
  const key = normalizeTerm(keyword)
  if (!key) return []
  const synonyms = SYNONYM_INDEX.get(key) ?? []
  return [...new Set([key, ...synonyms])].filter(Boolean)
}

/**
 * 文本命中了哪些关键词（含同义词）。返回命中的**原始写法**，空数组 = 一个没中。
 *
 * ## 为什么单独导出，而不是把这段留在 `prefilterItem` 里
 *
 * 有两层需要「命中关键词」这个判断，而且**两层必须给出同一个答案**：
 *
 * 1. **采集入口**（`sources/baidu-hot.ts` / `sources/bilibili.ts`）用它在入库前
 *    丢掉不相关的内容。百度热搜 51 条里只有约 3 条与 AI 有关，不过滤就等于
 *    往雷达盘灌 48 条社会新闻。
 * 2. **L0 预筛**（`prefilterItem`）用同一批关键词决定「哪条值得花钱送 AI」。
 *
 * 两层口径一旦漂移，就会出现最难查的一类脏数据：**条目收进来了、
 * 却永远过不了预筛**——它占着雷达盘的位置，AI 状态永远停在 `pending`，
 * 而任何一个环节都不报错。所以判定只留这一份实现。
 */
export function matchesAnyKeyword(text: string, keywords: readonly string[]): string[] {
  const matched: string[] = []
  for (const keyword of keywords) {
    if (!keyword.trim()) continue
    const res = compileAll(expandKeyword(keyword))
    if (res.some((re) => re.test(text))) matched.push(keyword)
  }
  return matched
}

export interface PrefilterCriteria {
  /** 命中任一即算候选。空数组 = 不做关键词筛选（全部放行） */
  keywords: readonly string[]
  /** 命中任一直丢弃 */
  exclude: readonly string[]
}

export interface PrefilterItem {
  url: string
  title: string
  summary?: string | null
  contentHash?: string | null
}

export type PrefilterRejectReason = 'duplicate' | 'excluded' | 'empty' | 'too_short'

export type PrefilterDecision =
  | {
      action: 'accept'
      /** 命中的关键词（原始写法，非同义词） */
      matchedKeywords: string[]
      /** 命中比例 0..1；未配置关键词时为 0 */
      keywordScore: number
    }
  | { action: 'reject'; reason: PrefilterRejectReason; detail: string }

/** 标题 + 摘要拼成待匹配文本；顺带折掉大小写差异。 */
export function matchTextOf(item: PrefilterItem): string {
  return `${item.title}\n${item.summary ?? ''}`
}

/** contentHash 缺失时退化成 URL 本身，保证去重键一定存在。 */
export function dedupeKeyOf(item: PrefilterItem): string {
  if (item.contentHash && item.contentHash.trim()) return `h:${item.contentHash.trim()}`
  return `u:${item.url.trim().toLowerCase()}`
}

const MIN_CONTENT_CHARS = 8

export interface PrefilterOptions {
  /** 已见过的去重键，调用方可跨批次复用 */
  seen?: Iterable<string>
}

export interface PrefilterResult {
  decision: PrefilterDecision
  /** 本条的去重键 */
  dedupeKey: string
}

/**
 * L0 单条判定。纯函数（去重状态从 `options.seen` 读写，由调用方持有）。
 */
export function prefilterItem(
  item: PrefilterItem,
  criteria: PrefilterCriteria,
  options: PrefilterOptions = {},
): PrefilterResult {
  const dedupeKey = dedupeKeyOf(item)
  const seen = options.seen

  // 1) 去重：最便宜的一步，先做
  if (seen && [...seen].includes(dedupeKey)) {
    return {
      decision: { action: 'reject', reason: 'duplicate', detail: `重复条目: ${dedupeKey}` },
      dedupeKey,
    }
  }

  // 2) 空内容：没有可判的东西，别浪费 token
  const text = matchTextOf(item)
  if (!item.title.trim() || text.replace(/\s+/g, '').length < MIN_CONTENT_CHARS) {
    return {
      decision: { action: 'reject', reason: 'too_short', detail: '标题与摘要过短，不足以判定' },
      dedupeKey,
    }
  }

  // 3) 排除词
  const excludeRes = compileAll(criteria.exclude)
  for (const re of excludeRes) {
    const hit = text.match(re)
    if (hit) {
      return {
        decision: { action: 'reject', reason: 'excluded', detail: `命中排除词: ${hit[0]}` },
        dedupeKey,
      }
    }
  }

  // 4) 关键词（含同义词）
  const keywords = criteria.keywords.filter((k) => k.trim().length > 0)
  if (keywords.length === 0) {
    // 没有配置关键词时不做筛选——空配置不是「全部挡掉」的意思
    return { decision: { action: 'accept', matchedKeywords: [], keywordScore: 0 }, dedupeKey }
  }

  const matched = matchesAnyKeyword(text, keywords)

  if (matched.length === 0) {
    return {
      decision: { action: 'reject', reason: 'excluded', detail: '未命中任何关键词' },
      dedupeKey,
    }
  }

  return {
    decision: {
      action: 'accept',
      matchedKeywords: matched,
      keywordScore: matched.length / keywords.length,
    },
    dedupeKey,
  }
}

/**
 * 一次 triage 运行内的去重状态。
 * 跨运行的去重靠两件事：ingest 的 `@@unique([sourceId, externalId])`，
 * 以及 triage 用 `loadKnownHashes` 查已处理条目的 contentHash。
 */
export class PrefilterState {
  private readonly seen = new Set<string>()

  /** 判定并把放行/拒绝的键都记入已见集合 */
  consider(item: PrefilterItem, criteria: PrefilterCriteria): PrefilterDecision {
    const { decision, dedupeKey } = prefilterItem(item, criteria, { seen: this.seen })
    this.seen.add(dedupeKey)
    return decision
  }

  add(key: string): void {
    this.seen.add(key)
  }

  get size(): number {
    return this.seen.size
  }

  reset(): void {
    this.seen.clear()
  }
}
