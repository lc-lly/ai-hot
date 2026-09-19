/**
 * 标题归一化与分词 —— 纯函数，零依赖、零 IO。
 *
 * 目标是**确定性**：同样的标题永远得到同样的 key 与同样的 token 集合，
 * 与调用顺序、进程、时区无关。聚类每 15 分钟跑一次且不允许烧 AI 的钱，
 * 所以这里刻意只用字符串运算，不引入任何模型或随机数。
 */

// 覆盖汉字（含扩展 A）、假名、谚文。写成 \u 转义而不是字面量，
// 免得被编辑器 / 工具链的编码处理改坏。
const CJK_RANGES = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af'

/** CJK 判定（非全局，可安全复用）。 */
const HAS_CJK = new RegExp(`[${CJK_RANGES}]`)

/** CJK 连续段。全局正则，**只能**用于 `String.match`，不得复用 lastIndex。 */
const CJK_RUN = new RegExp(`[${CJK_RANGES}]+`, 'g')

/**
 * 参与相似度计算的英文停用词。
 * 只收「几乎不携带事件信息」的词——`new` / `launch` 这类刻意保留，
 * 它们恰恰是区分「同一事件」和「同主体不同事件」的关键。
 */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'for',
  'and',
  'on',
  'with',
  'is',
  'are',
  'was',
  'were',
  'at',
  'by',
  'from',
  'as',
  'it',
  'its',
  'this',
  'that',
  'be',
  'been',
  'via',
])

/**
 * 归一化标题：NFKC → 小写 → 去标签 / URL / 标点 → 折叠空白。
 *
 * NFKC 很关键：中文源常常用全角括号、全角字母（如 `ＡＩ`），
 * 不归一的话 `ＡＩ` 与 `AI` 会被当成两个完全不同的词。
 */
export function normalizeTitle(title: string | null | undefined): string {
  if (typeof title !== 'string') return ''
  let s = title.normalize('NFKC').toLowerCase()
  s = s.replace(/<[^>]*>/g, ' ')
  s = s.replace(/https?:\/\/\S+/g, ' ')
  // 只保留字母与数字（\p{L} 含 CJK，所以中文不会被删掉），其余一律当分隔符
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 分词：拉丁词 + CJK 双字组（bigram）。
 *
 * 中文没有空格，按词切需要词典，按字切则区分度太低。
 * bigram（「大模型」→ `大模` / `模型`）是中文文本相似度里的经典做法：
 * 不需要词典，对错别字和语序变化都不敏感。
 * 单字 CJK 段直接丢弃——「新」「的」这类单字在所有中文标题里都出现，只会制造噪声。
 */
export function tokenize(normalized: string): string[] {
  const out: string[] = []
  if (!normalized) return out

  for (const word of normalized.split(' ')) {
    if (!word) continue

    if (!HAS_CJK.test(word)) {
      if ((word.length >= 2 || /[0-9]/.test(word)) && !STOPWORDS.has(word)) out.push(word)
      continue
    }

    // 混排词（如 `ai编程`）：拉丁部分单独成词，CJK 部分切 bigram
    const latin = word.replace(CJK_RUN, ' ').trim()
    if (latin) {
      for (const w of latin.split(/\s+/)) {
        if (w && (w.length >= 2 || /[0-9]/.test(w)) && !STOPWORDS.has(w)) out.push(w)
      }
    }

    for (const run of word.match(CJK_RUN) ?? []) {
      for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
    }
  }

  return [...new Set(out)]
}

/** 标题的规范化字符串，用作精确匹配的 key。 */
export function titleKey(title: string | null | undefined): string {
  return normalizeTitle(title)
}

/** 常见的二级域名后缀，用于把 `news.bbc.co.uk` 收敛到 `bbc.co.uk`。 */
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'com.au',
  'net.au',
  'com.hk',
  'com.tw',
  'com.br',
  'com.sg',
])

/**
 * 注册域：主机名去掉 `www.` 后保留「域名 + 后缀」。
 * 解析不了（非法 URL）时返回空串——调用方据此跳过域名比对，而不是当成「同域」。
 */
export function registrableDomain(rawUrl: string | null | undefined): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return ''
  let host: string
  try {
    host = new URL(rawUrl.trim()).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
  if (host === '' || /^\d+(\.\d+){3}$/.test(host)) return host

  const parts = host.split('.')
  if (parts.length <= 2) return host

  const lastTwo = parts.slice(-2).join('.')
  if (TWO_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.')
  }
  return lastTwo
}

/** URL 归一化，用于「同一篇文章被两个源贴了同一个链接」的精确命中。 */
export function normalizeUrlKey(rawUrl: string | null | undefined): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return ''
  try {
    const url = new URL(rawUrl.trim())
    url.hash = ''
    // 与 `pipeline/dedupe.ts` 的 normalizeUrl 对齐：协议统一成 https，
    // 否则同一篇文章的 http / https 两个链接会被当成两条不同的证据
    url.protocol = 'https:'
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }
    return url.toString()
  } catch {
    return ''
  }
}
