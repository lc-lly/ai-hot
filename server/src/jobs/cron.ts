/**
 * 极小的 cron 表达式解析 / 下一次触发时间计算 —— 纯函数，无 IO、无时钟依赖。
 *
 * 为什么自己写而不问 `node-cron`：契约 §4 要求 `GET /api/jobs` 返回
 * `nextRunAt`，而 `node-cron@3` 不导出「下一次触发时刻」这个能力
 * （`ScheduledTask` 上只有 `now()` / `start()` / `stop()`）。
 * 与其去戳它的私有字段，不如把标准五段式解析清楚——几十行，可单测。
 *
 * 语义对齐 Vixie cron：
 * - 五段：`分 时 日 月 周`；
 * - 通配符、步长（星号斜杠 n）、单值 `a`、区间 `a-b`、区间步长 `a-b/n`、逗号列表；
 * - 月 / 周支持三字母英文名（`JAN` / `MON`）；
 * - 周里 `7` 等同 `0`（周日）；
 * - **日与周都受限时取「或」**（这是 cron 的历史怪癖，也是不写清楚最容易踩的坑）。
 */

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

interface Bound {
  min: number
  max: number
  names?: Record<string, number>
}

const BOUNDS: readonly Bound[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DOW_NAMES },
]

/** 扫描上限：一年零一天，够覆盖「2 月 29 日」这类低频表达式。 */
const MAX_SCAN_DAYS = 367

export interface CronFields {
  minute: ReadonlySet<number>
  hour: ReadonlySet<number>
  dayOfMonth: ReadonlySet<number>
  month: ReadonlySet<number>
  dayOfWeek: ReadonlySet<number>
  /** 日字段是否受限（非 `*`）——决定与周字段是「与」还是「或」 */
  domRestricted: boolean
  dowRestricted: boolean
}

function parseValue(token: string, bound: Bound, field: string): number {
  const named = bound.names?.[token.toLowerCase()]
  const value = named ?? Number(token)
  if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
    throw new Error(`cron: ${field} 字段取值非法: "${token}"`)
  }
  // 周里的 7 归一成 0
  if (field === 'dow' && value === 7) return 0
  return value
}

function parseField(raw: string, bound: Bound, field: string): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>()
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error(`cron: ${field} 字段为空`)

  // `5/15` 这种写法在 Vixie cron 里等价于 `5-59/15`（从 5 起步），需要补出上界
  const segments = trimmed.split(',')
  for (const segment of segments) {
    if (segment === '') throw new Error(`cron: ${field} 字段含空项: "${raw}"`)

    const [rangePart, stepPart, ...rest] = segment.split('/')
    if (rest.length > 0 || rangePart === undefined) {
      throw new Error(`cron: ${field} 字段格式非法: "${segment}"`)
    }

    let step = 1
    if (stepPart !== undefined) {
      step = Number(stepPart)
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`cron: ${field} 步长非法: "${segment}"`)
      }
    }

    let from: number
    let to: number
    if (rangePart === '*') {
      from = bound.min
      to = bound.max
    } else if (rangePart.includes('-')) {
      const [a, b, ...extra] = rangePart.split('-')
      if (extra.length > 0 || a === undefined || b === undefined) {
        throw new Error(`cron: ${field} 区间非法: "${segment}"`)
      }
      from = parseValue(a, bound, field)
      to = parseValue(b, bound, field)
      if (from > to) throw new Error(`cron: ${field} 区间倒置: "${segment}"`)
    } else {
      from = parseValue(rangePart, bound, field)
      to = stepPart === undefined ? from : bound.max
    }

    for (let v = from; v <= to; v += step) values.add(v)
  }

  return { values, restricted: trimmed !== '*' }
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron: 需要 5 段（分 时 日 月 周），收到 ${parts.length} 段: "${expression}"`)
  }

  const fields = parts.map((part, i) => {
    const bound = BOUNDS[i]
    if (!bound) throw new Error(`cron: 内部错误，缺少第 ${i} 段的边界`)
    return parseField(part, bound, ['minute', 'hour', 'dom', 'month', 'dow'][i] ?? String(i))
  })

  const [minute, hour, dom, month, dow] = fields
  if (!minute || !hour || !dom || !month || !dow) {
    throw new Error(`cron: 解析结果不完整: "${expression}"`)
  }

  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dom.values,
    month: month.values,
    dayOfWeek: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  }
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression)
    return true
  } catch {
    return false
  }
}

function dayMatches(fields: CronFields, date: Date): boolean {
  if (!fields.month.has(date.getMonth() + 1)) return false

  const domOk = fields.dayOfMonth.has(date.getDate())
  const dowOk = fields.dayOfWeek.has(date.getDay())

  // Vixie cron 的怪癖：两个都受限时取「或」，只限一个时就是那个
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk
  if (fields.domRestricted) return domOk
  if (fields.dowRestricted) return dowOk
  return true
}

export interface NextRunOptions {
  /** 扫描上限（天），默认 367 */
  maxScanDays?: number
}

/**
 * 下一次触发时刻（本地时区，与 `node-cron` 一致）。
 *
 * 从 `from` 之后的那一分钟开始找，找不到就抛——
 * 抛而不是返回 `null`，是因为「配了个永远不会触发的 cron」属于配置错误，
 * 静默返回 null 会让 `nextRunAt` 在界面上变成空白，反而更难排查。
 */
export function nextRunAt(expression: string, from: Date, options: NextRunOptions = {}): Date {
  const fields = parseCron(expression)
  const maxScanDays = options.maxScanDays ?? MAX_SCAN_DAYS

  const start = new Date(from.getTime())
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  const year = start.getFullYear()
  const month = start.getMonth()
  const day = start.getDate()
  const startMs = start.getTime()

  const hours = [...fields.hour].sort((a, b) => a - b)
  const minutes = [...fields.minute].sort((a, b) => a - b)

  for (let offset = 0; offset <= maxScanDays; offset += 1) {
    // 用 Date 构造器做日期进位，跨月 / 跨年 / 闰年都不用自己算
    const probe = new Date(year, month, day + offset)
    if (!dayMatches(fields, probe)) continue

    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(year, month, day + offset, hour, minute, 0, 0)
        if (candidate.getTime() >= startMs) return candidate
      }
    }
  }

  throw new Error(`cron: 从 ${from.toISOString()} 起 ${maxScanDays} 天内找不到触发时刻: "${expression}"`)
}
