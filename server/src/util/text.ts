const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  '#47': '/',
  // 中文源（百度热搜、搜狗微信）大量使用排版类实体。不补这几项的话，
  // 标题会原样带出 `&mdash;&mdash;`、`&ldquo;` 这种字样——
  // 抓搜狗实测第一条的标题就是「…用的人却少了&mdash;&mdash;AI时代…」。
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  times: '×',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  permil: '‰',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
}

/** 把 `&#8212;` / `&#x2014;` 这类数字实体解成真正的字符。解析不出来返回原样。 */
function decodeNumericEntity(name: string): string | null {
  if (!name.startsWith('#')) return null
  const body = name.slice(1)
  const code = /^[xX]/.test(body)
    ? Number.parseInt(body.slice(1), 16)
    : Number.parseInt(body, 10)

  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null
  // 代理区码点不是合法字符，fromCodePoint 会抛
  if (code >= 0xd800 && code <= 0xdfff) return null
  return String.fromCodePoint(code)
}

/**
 * 去掉**行内**标签（`<em>` / `<b>` / `<span>` 这类），**不插入分隔空格**。
 *
 * ## 与 `stripHtml` 的区别，以及为什么两个都要有
 *
 * `stripHtml` 把每个标签替换成**空格**——那是对的，它面向的是**块级** HTML：
 * `<p>第一段</p><p>第二段</p>` 必须变成 `第一段 第二段`，直接删标签会粘成
 * 「第一段第二段」。
 *
 * 但搜索引擎返回的**行内高亮标记**正好相反：标签包在词中间，
 * 补空格会把词切断。B站 搜索接口实测返回的标题是
 *
 * ```
 * 【全748集】目前B站最全最细的AI<em class="keyword">大模型</em>零基础全套教程
 * ```
 *
 * 用 `stripHtml` 清洗会得到「…AI 大模型 零基础…」——多出来的两个空格
 * 把「AI大模型」拆成了三个词，卡片上很显眼，而且会让关键词匹配失准。
 * 删标签则得到「…AI大模型零基础…」，才是原文。
 *
 * 注意它**不解码实体**。B站 这类 JSON 接口给的标签是字面量，
 * 不存在实体转义；需要解码场景（RSS、抓来的 HTML）走 `stripHtml`。
 */
export function stripInlineTags(input: string): string {
  return input.replace(/<\/?[a-zA-Z][^>]*>/g, '')
}

/** 去掉 HTML 标签、解码常见实体、压缩连续空白。 */
export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) =>
      // 先查表，再试数字实体，都不行就原样留着。
      // 留原样而不是删掉：`&foo;` 里的 foo 可能是有意义的正文，
      // 悄悄吃掉比显示出一个奇怪的转义序列更难排查。
      ENTITIES[name] ?? decodeNumericEntity(name) ?? whole,
    )
    .replace(/\s+/g, ' ')
    .trim()
}

/** 截断到 max 个字符，超出时以省略号结尾（省略号追加在 max 个字符之后）。 */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input
  if (max <= 0) return ''
  return `${input.slice(0, max)}…`
}
