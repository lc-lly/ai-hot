/**
 * 「最近 N 小时」的滚动时间窗。
 *
 * ## 为什么不用「今天 00:00」
 *
 * SQLite 存的是 UTC，服务器时区、浏览器时区、数据库时区是三个可以各不相同的东西。
 * 「今天 00:00」这三个字在跨时区时是**没有确定含义**的，而且它会让数字在
 * 午夜零点整突变——用户刷新一下，统计卡从 47 掉到 0。
 * 滚动窗口在任何时区下都是同一个含义，也不会跳变。UI 上写「近 24 小时」。
 *
 * ## 为什么 `publishedAt` 为空时回落到 `fetchedAt`
 *
 * rss 类源的 `publishedAt` 经常缺失，只用它会把整批条目筛没；
 * 只用 `fetchedAt` 又会让「三天前发布、刚被抓到」的旧闻混进「最近 1 小时」。
 * 所以以 `publishedAt` 为准，缺了才退回抓取时间。
 *
 * **`/api/items` 与 `/api/stats` 必须共用这一个函数**，否则
 * 「统计卡说今日新增 12 条」和「筛选今日只显示 9 条」会互相打架，
 * 而这种不一致极难归因。
 */

export const HOUR_MS = 60 * 60 * 1000

export function rollingWindowSince(hours: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - hours * HOUR_MS)
}

/** 直接可塞进 Prisma `where` 的时间窗条件。 */
export function rollingWindowFilter(hours: number, now: Date = new Date()): Record<string, unknown> {
  const since = rollingWindowSince(hours, now)
  return {
    OR: [{ publishedAt: { gte: since } }, { publishedAt: null, fetchedAt: { gte: since } }],
  }
}

/** 统计卡的「今日」= 滚动 24 小时。改这个值会同时改掉卡片文案的含义。 */
export const TODAY_WINDOW_HOURS = 24
