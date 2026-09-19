import { createHash } from 'node:crypto'

/** 需要剔除的追踪参数，剔除后同一篇文章的不同投放链接会收敛到同一个 URL */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source',
  'spm',
]

/**
 * 规范化 URL，用于精确去重。
 * 无法解析时抛错——调用方应当捕获并跳过该条目，而不是静默保留脏数据。
 */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim())

  url.hash = ''
  url.protocol = 'https:'
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')

  for (const key of TRACKING_PARAMS) url.searchParams.delete(key)
  url.searchParams.sort()

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1)
  }

  return url.toString()
}

/** 标题 + 规范化 URL 的 SHA-256。标题做大小写与空白归一。 */
export function contentHash(title: string, url: string): string {
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256')
    .update(`${normalizedTitle}\n${normalizeUrl(url)}`)
    .digest('hex')
}
