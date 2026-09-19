import { clamp01 } from '../score/index.js'
import { normalizeUrlKey, registrableDomain, titleKey, tokenize } from './normalize.js'
import { dice, toSet } from './similarity.js'

/**
 * 事件聚类 —— **纯函数**，输入一列条目，输出事件簇分组。
 *
 * 为什么需要它：契约里 `Cluster` 是 L3 交叉验证的基础（`sourceCount`），
 * 但没人负责填充，于是 `Cluster` 恒为空，L3 的三个维度有一个永远是
 * `sourceCount = 1`（`src/ai/crosscheck.ts` 的 `sourceFactorOf(1) = 0.5`）。
 * 这里把那一维接上。
 *
 * 为什么不用 AI：`collect` 每 15 分钟跑一次，一天 96 次。
 * 让模型参与聚类等于把「零成本的纯代码环节」变成持续烧钱的环节，
 * 与 spec「轻量工具、不过度工程化」的定位冲突。
 *
 * ## 算法（确定性）
 *
 * 1. 归一化标题（NFKC + 小写 + 去标点），切 token（拉丁词 + 中文 bigram）。
 * 2. 条目按 `(titleKey, id)` 全序排序后再贪心分配 ——
 *    贪心本身依赖处理顺序，**先排序**才能让结果只取决于输入集合本身，
 *    与调用方传进来的顺序无关（这也是它可被单测的前提）。
 * 3. 命中规则（任一成立即合并）：
 *    - 归一化标题完全相同 —— 同一篇文章被多个源转载，最常见的情形；
 *    - 归一化 URL 完全相同 —— 同一条链接被两个源同时收录；
 *    - Dice 相似度 ≥ `titleThreshold`（默认 0.62）—— 跨来源报道同一事件；
 *    - Dice 相似度 ≥ `sameDomainThreshold`（默认 0.45）**且**注册域相同 ——
 *      同一站点的跟进报道，标题会被改写，所以门槛放低。
 *
 * 跨来源报道（L3 要的正是这个）标题往往不同域，所以主信号必须是标题相似度；
 * 「同域」只是**降低门槛**的辅助信号，不是必需条件。
 * 反过来，两家不同媒体撞了一句通用标题（`AI 行业周报`）会被 0.62 挡住。
 *
 * ## 已知的 v1 简化
 *
 * - 组内相似度只与最多 5 条「锚点」比较，不是与全组比较 —— 控制 O(n·m) 成本。
 * - 一条新条目若同时匹配两个已有簇，只并入得分最高的那个，**不做簇合并**。
 *   簇合并会牵动 `Match.clusterId` 的外键，代价大于收益。
 * - 不引入 TF-IDF / 词向量 / 时间窗衰减。粗但确定，够 L3 用。
 */

/** 跨来源标题相似度门槛。 */
export const DEFAULT_TITLE_THRESHOLD = 0.62
/** 同域标题相似度门槛（更松）。 */
export const DEFAULT_SAME_DOMAIN_THRESHOLD = 0.45
/** 单簇最大条目数，防止一个泛化标题把整天的新闻吸成一个簇。 */
export const DEFAULT_MAX_GROUP_SIZE = 50
/** 每组参与相似度比较的锚点上限。 */
export const MAX_ANCHORS_PER_GROUP = 5

/** 聚类的输入条目：只取聚类需要的字段，便于单测直接构造。 */
export interface ClusterItem {
  id: string
  title: string
  url: string
  sourceId: string
  /** 发布时间（可能缺失） */
  publishedAt?: Date | null
  /** 抓取时间（我们「看到」它的时间） */
  fetchedAt?: Date | null
  /** 0..1 读时热度；缺省 0 */
  heat?: number
}

/** 上一轮已经形成的簇，作为锚点参与匹配，避免每轮重建。 */
export interface ExistingCluster {
  clusterId: string
  /** 该簇已有的最早出现时间，用于让 firstSeenAt 不因重建而后退 */
  firstSeenAt?: Date | null
  items: readonly ClusterItem[]
}

export interface ClusterGroup {
  /** 已存在簇的 id；新建的组为 null */
  clusterId: string | null
  /** 本次新并入的条目 id（已有锚点不算） */
  newItemIds: string[]
  /** 组内全部条目 id，已排序 */
  itemIds: string[]
  /** 代表标题：组内发布最早的那条的原始标题 */
  title: string
  /** 去重后的来源 id，已排序 */
  sourceIds: string[]
  firstSeenAt: Date
  lastSeenAt: Date
  heatScore: number
}

export interface ClusterOptions {
  titleThreshold?: number
  sameDomainThreshold?: number
  maxGroupSize?: number
  /** 历史簇锚点 */
  existing?: readonly ExistingCluster[]
}

interface TimeRange {
  first: Date | null
  last: Date | null
}

function observationTime(item: ClusterItem): Date | null {
  return item.fetchedAt ?? item.publishedAt ?? null
}

function publicationTime(item: ClusterItem): Date | null {
  return item.publishedAt ?? item.fetchedAt ?? null
}

/** 组内工作状态。 */
interface WorkGroup {
  clusterId: string | null
  /** 全部条目（锚点 + 新并入），保持插入顺序 */
  items: ClusterItem[]
  /** 本轮新并入的条目 id —— 只有这些需要写 `HotItem.clusterId` */
  freshIds: string[]
  /** 锚点的标题 key 集合 */
  keys: Set<string>
  /** 锚点的归一化 URL 集合 */
  urls: Set<string>
  /** 锚点的注册域集合 */
  domains: Set<string>
  /** 锚点的 token 集合（最多 MAX_ANCHORS_PER_GROUP 个） */
  tokenSets: Array<Set<string>>
  /** 已有 firstSeenAt（仅历史簇有） */
  seededFirstSeenAt: Date | null
}

function newGroup(clusterId: string | null, seededFirstSeenAt: Date | null): WorkGroup {
  return {
    clusterId,
    items: [],
    freshIds: [],
    keys: new Set(),
    urls: new Set(),
    domains: new Set(),
    tokenSets: [],
    seededFirstSeenAt,
  }
}

function addAnchor(group: WorkGroup, item: ClusterItem): void {
  if (group.tokenSets.length >= MAX_ANCHORS_PER_GROUP) return
  group.keys.add(titleKey(item.title))
  const urlKey = normalizeUrlKey(item.url)
  if (urlKey) group.urls.add(urlKey)
  const domain = registrableDomain(item.url)
  if (domain) group.domains.add(domain)
  group.tokenSets.push(toSet(tokenize(titleKey(item.title))))
}

/** 条目排序用的稳定全序：标题 key 优先，其次 id。 */
function compareItems(a: ClusterItem, b: ClusterItem): number {
  const ka = titleKey(a.title)
  const kb = titleKey(b.title)
  if (ka !== kb) return ka < kb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function aggregate(group: WorkGroup): ClusterGroup {
  const items = [...group.items].sort(compareItems)

  // 代表标题：发布时间最早的那条。发布时间缺失的排到最后，
  // 用「抓取时间最早」兜底，保证一定有确定的一条被选中。
  let representative: ClusterItem | null = null
  let bestKey = Number.POSITIVE_INFINITY
  for (const item of items) {
    const t = publicationTime(item)
    const key = t === null ? Number.POSITIVE_INFINITY : t.getTime()
    if (representative === null || key < bestKey || (key === bestKey && item.id < representative.id)) {
      representative = item
      bestKey = key
    }
  }

  let range: TimeRange = { first: null, last: null }
  for (const item of items) {
    const t = observationTime(item)
    if (t === null) continue
    if (range.first === null || t.getTime() < range.first.getTime()) range.first = t
    if (range.last === null || t.getTime() > range.last.getTime()) range.last = t
  }

  if (range.first !== null && group.seededFirstSeenAt !== null) {
    if (group.seededFirstSeenAt.getTime() < range.first.getTime()) range.first = group.seededFirstSeenAt
  } else if (range.first === null) {
    range.first = group.seededFirstSeenAt
  }

  const sourceIds = [...new Set(items.map((i) => i.sourceId))].sort()
  const maxHeat = items.reduce((max, i) => Math.max(max, i.heat ?? 0), 0)
  // 多来源互相印证 → 热度加成。每个额外来源 +0.1，封顶 1。
  const heatScore = clamp01(maxHeat + 0.1 * Math.max(0, sourceIds.length - 1))

  const fallback = range.first ?? range.last ?? new Date(0)

  return {
    clusterId: group.clusterId,
    newItemIds: [...group.freshIds].sort(),
    itemIds: items.map((i) => i.id).sort(),
    title: representative?.title ?? '',
    sourceIds,
    firstSeenAt: range.first ?? fallback,
    lastSeenAt: range.last ?? range.first ?? fallback,
    heatScore,
  }
}

/**
 * 把条目分组成事件簇。纯函数：无 IO、无时钟依赖（时间只从条目上读）。
 *
 * 返回的组按「是否有已有簇 id、再有簇 id / 首个条目 id」排序，保证顺序确定。
 */
export function clusterItems(
  items: readonly ClusterItem[],
  options: ClusterOptions = {},
): ClusterGroup[] {
  const titleThreshold = options.titleThreshold ?? DEFAULT_TITLE_THRESHOLD
  const sameDomainThreshold = options.sameDomainThreshold ?? DEFAULT_SAME_DOMAIN_THRESHOLD
  const maxGroupSize = options.maxGroupSize ?? DEFAULT_MAX_GROUP_SIZE

  const groups: WorkGroup[] = []

  // 历史簇先入组（索引靠前），且内部顺序按 clusterId 排定，保证确定性
  const existing = [...(options.existing ?? [])].sort((a, b) =>
    a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0,
  )
  for (const seed of existing) {
    const group = newGroup(seed.clusterId, seed.firstSeenAt ?? null)
    const anchors = [...seed.items].sort(compareItems)
    for (const item of anchors) {
      group.items.push(item)
      addAnchor(group, item)
    }
    groups.push(group)
  }

  const incoming = [...items].sort(compareItems)
  if (incoming.length === 0) return groups.map(aggregate)

  // 倒排索引：token / 标题 key / URL → 组下标。
  // 只为降低比较次数；正确性不依赖它（Dice > 0 必然共享至少一个 token）。
  const tokenIndex = new Map<string, Set<number>>()
  const keyIndex = new Map<string, Set<number>>()
  const urlIndex = new Map<string, Set<number>>()

  const index = (map: Map<string, Set<number>>, key: string, gi: number): void => {
    if (key === '') return
    const bucket = map.get(key)
    if (bucket) bucket.add(gi)
    else map.set(key, new Set([gi]))
  }

  const indexAnchor = (group: WorkGroup, gi: number): void => {
    for (const key of group.keys) index(keyIndex, key, gi)
    for (const url of group.urls) index(urlIndex, url, gi)
    for (const tokenSet of group.tokenSets) for (const token of tokenSet) index(tokenIndex, token, gi)
  }

  for (let gi = 0; gi < groups.length; gi += 1) {
    const group = groups[gi]
    if (group) indexAnchor(group, gi)
  }

  for (const item of incoming) {
    const key = titleKey(item.title)
    const urlKey = normalizeUrlKey(item.url)
    const domain = registrableDomain(item.url)
    const tokenSet = toSet(tokenize(key))

    const candidates = new Set<number>()
    for (const token of tokenSet) {
      const bucket = tokenIndex.get(token)
      if (bucket) for (const gi of bucket) candidates.add(gi)
    }
    const keyBucket = key === '' ? undefined : keyIndex.get(key)
    if (keyBucket) for (const gi of keyBucket) candidates.add(gi)
    const urlBucket = urlKey === '' ? undefined : urlIndex.get(urlKey)
    if (urlBucket) for (const gi of urlBucket) candidates.add(gi)

    // 升序遍历：同分时下标小的组先得，结果因此确定
    const ordered = [...candidates].sort((a, b) => a - b)

    let best = -1
    let bestScore = 0

    for (const gi of ordered) {
      const group = groups[gi]
      if (!group || group.items.length >= maxGroupSize) continue

      let sim = 0
      if (key !== '' && group.keys.has(key)) sim = 1
      else if (urlKey !== '' && group.urls.has(urlKey)) sim = 1
      else {
        for (const anchorTokens of group.tokenSets) {
          const s = dice(tokenSet, anchorTokens)
          if (s > sim) sim = s
        }
        const domainMatch = domain !== '' && group.domains.has(domain)
        const needed = domainMatch ? sameDomainThreshold : titleThreshold
        if (sim < needed) sim = 0
      }

      if (sim > bestScore) {
        bestScore = sim
        best = gi
      }
    }

    let group: WorkGroup
    if (best >= 0) {
      group = groups[best] as WorkGroup
    } else {
      group = newGroup(null, null)
      groups.push(group)
      best = groups.length - 1
    }

    group.items.push(item)
    group.freshIds.push(item.id)
    addAnchor(group, item)
    indexAnchor(group, best)
  }

  return groups.map(aggregate)
}

export { titleKey, normalizeTitle, tokenize, registrableDomain, normalizeUrlKey } from './normalize.js'
export { dice, diceOfTokens, toSet } from './similarity.js'
