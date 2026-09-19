/**
 * 契约 §3.3 冻结的 `heat` 算法。
 *
 * 按源取原始互动量，归一化到 0..1：
 *
 * | kind              | 取什么                              | 基准 |
 * |-------------------|-------------------------------------|------|
 * | `hackernews`      | `raw.score`（缺失用 `raw.descendants`） | /500 |
 * | `reddit`          | `raw.score`                         | /1000 |
 * | `github-trending` | `raw.starsToday` 里的数字            | /500 |
 * | `bilibili`        | `raw.view`                          | /3,000,000 |
 * | `bilibili-search` | `raw.view`                          | /800,000 |
 * | `baidu-hot`       | `raw.hotScore`                      | /8,000,000 |
 * | 其他 / 取不到      | ——                                  | 0.3  |
 *
 * 取不到值时给 `0.3` 而不是 `0`——`0` 在雷达盘上是圆心，
 * 会让「无数据」看起来像「无热度」，误导用户。
 *
 * 纯函数，无 IO、无 DB 依赖，**读时计算**，不落库。
 */

/** 取不到原始互动量时的固定值。契约 §3.3 冻结，不要改。 */
export const HEAT_FALLBACK = 0.3

/**
 * 归一化基准。契约 §3.3 冻结，不要改。
 *
 * 后三个是**搜索类源**（阶段 4.2）。它们与前三行不是同一把尺子——
 * 但也不是同一批数据：搜索类的结果只在搜索页里出现，从不和信息流混排，
 * 所以「跨 kind 可比」这个要求对它们不成立。各自内部排序合理就够了。
 *
 * `github-search` 的基准比 `github-trending` 大得多，是因为两者取的
 * **不是同一个数**：trending 给的是「今日新增 star」，搜索给的是「总 star」。
 *
 * 这个 300,000 是量出来的，不是拍的。适配器固定 `sort=stars&order=desc`，
 * 取到的永远是幂律分布的顶端那一截——实测六个查询共 180 条结果，中位数
 * 66,522、p90 166,197、最高 455,512，**94% 超过 20,000**。原先定的 20,000
 * 低了整整一个数量级，后果是搜索页每张卡片都 `heat = 1.0`：徽章行全挂
 * 「紧急」，而排序在热度上完全打平后退化成 `url.localeCompare` 的字母序
 * （`abiosoft → alibaba → aquasecurity → authelia → bregman-arie`）。
 * 两个症状都不报错，只能靠眼睛看出来。
 *
 * 定在 300,000（约等于实测 p100）：中位数落到 0.22、p90 落到 0.55、
 * 只有真正顶层的仓库才会封顶，档位与排序就都有区分度了。
 */
export const HEAT_BASES: Readonly<Record<string, number>> = {
  hackernews: 500,
  reddit: 1000,
  'github-trending': 500,
  'hn-algolia': 500,
  'reddit-search': 1000,
  'github-search': 300_000,

  // ---- 下面三个同样是量出来的（2026-09-17，本机实跑）----
  //
  // `bilibili` 取 `view`。热门榜两页共 100 条的播放量分布：
  // 最低 42,633 / p50 448,692~779,358 / p90 1,962,747~3,136,328 / 最高 3,346,633。
  // 基准取 3,000,000（≈实测 p100，照 `github-search` 的先例）：
  // p50 落到 0.15~0.26、p90 落到 0.65~1.0。
  // 榜上全是高位视频，区分度天然比 GitHub 搜索小，这是这个源的属性不是取值的错。
  bilibili: 3_000_000,

  // `bilibili-search` 的播放量比热门榜低一个数量级。三个关键词各 20 条的实测：
  // p50 78,792~132,076 / p90 863,846~3,805,591 / 最高 2,819,172~3,809,591。
  // 基准取 800,000（约等于 p90），p50 落到 0.10~0.17。
  //
  // 与 `bilibili` 用**不同的尺子**是刻意的，和上面搜索类三个源同理：
  // 搜索结果只出现在搜索页、从不与信息流混排，「跨 kind 可比」对它不成立。
  'bilibili-search': 800_000,

  // 百度热搜的 `hotScore`。实测榜单 51 条的取值范围 3,332,807 ~ 7,904,781，
  // 基准取 8,000,000（略高于实测最大值），让榜首接近但不封顶。
  'baidu-hot': 8_000_000,
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * 把 `HotItem.raw` 解析成对象。
 *
 * DB 里它是 JSON 字符串；直接调用时可以已经是对象了。解析不出来返回 `null`。
 */
export function parseRawObject(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return null
    try {
      const parsed: unknown = JSON.parse(text)
      return isPlainObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isPlainObject(raw) ? raw : null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 数字或「看起来像数字的字符串」→ number；其余（含空串、`"1,234"`）→ null。 */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const text = v.trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/**
 * 从 `raw.starsToday` 里取出数字。
 *
 * github-trending adapter 存的是 trending 页面上那个 span 的文本，
 * 形如 `"1,234 stars today"` / `"1.2k stars today"`，所以要先剥掉非数字部分。
 */
export function digitsFrom(v: unknown): number | null {
  const direct = toNumber(v)
  if (direct !== null) return direct
  if (typeof v !== 'string') return null

  const m = /(\d[\d,]*(?:\.\d+)?)\s*([kK])?/.exec(v)
  const digits = m?.[1]
  if (digits === undefined) return null

  const base = Number(digits.replace(/,/g, ''))
  if (!Number.isFinite(base)) return null
  return m?.[2] === undefined ? base : base * 1000
}

/**
 * 按 kind 取原始互动量。取不到返回 `null`（调用方给 `HEAT_FALLBACK`）。
 * 明确为 0 是**取到了值**，返回 0。
 */
export function rawHeat(kind: string | null | undefined, raw: unknown): number | null {
  const payload = parseRawObject(raw)
  if (payload === null) return null

  switch (kind) {
    // 搜索类的三个各与自己的采集类同名源取同一个字段——
    // 适配器写 `raw` 时就按采集类的字段名对齐了（见 `sources/hn-algolia.ts` 头注释），
    // 这里顺着取即可，不需要第二套解析。
    case 'hackernews':
    case 'hn-algolia': {
      const score = toNumber(payload['score'])
      if (score !== null) return score
      return toNumber(payload['descendants'])
    }
    case 'reddit':
    case 'reddit-search':
      return toNumber(payload['score'])
    case 'github-trending':
      return digitsFrom(payload['starsToday'])
    case 'github-search':
      // 总 star 数，不是今日新增。基准也相应放大 40 倍，见 HEAT_BASES。
      return digitsFrom(payload['stars'])
    case 'bilibili':
    case 'bilibili-search':
      // 两个适配器都把播放量写进了 `view`（搜索接口原字段叫 `play`，
      // 见 `sources/bilibili-search.ts` 的字段映射说明），所以这里取同一个键。
      return toNumber(payload['view'])
    case 'baidu-hot':
      // 百度自己的热度值，不是互动计数。`metrics.ts` 刻意没把它暴露到卡片上，
      // 但拿它当热度用是合适的——它本来就是「有多少人在搜」。
      return digitsFrom(payload['hotScore'])
    default:
      return null
  }
}

/**
 * `heat = clamp(raw / 基准, 0, 1)`，取不到时 `0.3`。
 *
 * @param kind `Source.kind`
 * @param raw  `HotItem.raw`（JSON 字符串或已解析的对象）
 */
export function heat(kind: string | null | undefined, raw: unknown): number {
  const base = kind === null || kind === undefined ? undefined : HEAT_BASES[kind]
  if (base === undefined) return HEAT_FALLBACK

  const value = rawHeat(kind, raw)
  if (value === null) return HEAT_FALLBACK
  return clamp01(value / base)
}
