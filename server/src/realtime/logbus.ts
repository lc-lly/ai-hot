import { randomUUID } from 'node:crypto'

/**
 * 内存日志环形缓冲。
 *
 * 契约 §4：`GET /api/logs?limit=200` 是 WS 断开时的轮询兜底，
 * 所以缓冲至少要装下几百条。默认 500 条，超出后**覆盖最旧的**——
 * 有界，进程跑多久都不会涨内存。
 *
 * 这个模块不 import Express、不 import Prisma，任何模块都可以安全地引用它，
 * 不会形成 import 环。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 契约 §2.1：前端日志流按 channel 着色。 */
export type LogChannel = 'fetch' | 'ai' | 'notify' | 'system'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
export const LOG_CHANNELS: readonly LogChannel[] = ['fetch', 'ai', 'notify', 'system']

/** 契约 §2.1 的 `log.data`，外加一个 `ts`（HTTP 轮询兜底需要它为每条日志排序）。 */
export interface LogEntry {
  id: string
  /** ISO 8601 */
  ts: string
  level: LogLevel
  channel: LogChannel
  message: string
  meta?: Record<string, unknown>
}

/** 写日志时的入参。只有 `channel` 与 `message` 必填。 */
export interface LogInput {
  channel: LogChannel
  message: string
  /** 默认 `info` */
  level?: LogLevel
  meta?: Record<string, unknown>
}

/** 默认容量。契约 §4 要求「至少几百条」，500 是安全值。 */
export const DEFAULT_LOG_CAPACITY = 500

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v)
}

export function isLogChannel(v: unknown): v is LogChannel {
  return typeof v === 'string' && (LOG_CHANNELS as readonly string[]).includes(v)
}

/**
 * 定长环形缓冲：`#items` 长度固定，`#next` 指向下一个待写槽位，
 * 写满后自动覆盖最旧的一条。append / recent 都是 O(1) / O(n)。
 */
export class LogBus {
  readonly #items: Array<LogEntry | undefined>
  readonly #now: () => Date
  #next = 0
  #size = 0

  constructor(opts: { capacity?: number; now?: () => Date } = {}) {
    const capacity = Math.max(1, Math.floor(opts.capacity ?? DEFAULT_LOG_CAPACITY))
    this.#items = new Array<LogEntry | undefined>(capacity).fill(undefined)
    this.#now = opts.now ?? (() => new Date())
  }

  get capacity(): number {
    return this.#items.length
  }

  /** 当前实际存了多少条（≤ capacity）。 */
  get size(): number {
    return this.#size
  }

  /** 造一条 entry 但不入缓冲（需要先拿到 id 再决定是否写入时用）。 */
  create(input: LogInput): LogEntry {
    const entry: LogEntry = {
      id: randomUUID(),
      ts: this.#now().toISOString(),
      level: input.level ?? 'info',
      channel: input.channel,
      message: input.message,
    }
    if (input.meta !== undefined) entry.meta = input.meta
    return entry
  }

  /** 写入缓冲，超出容量则覆盖最旧的一条。返回写入的 entry。 */
  append(entry: LogEntry): LogEntry {
    this.#items[this.#next] = entry
    this.#next = (this.#next + 1) % this.#items.length
    if (this.#size < this.#items.length) this.#size += 1
    return entry
  }

  /** 造一条 + 写入缓冲。**不含** WS 广播——广播是 `realtime/server.ts` 的 `log()` 的职责。 */
  log(input: LogInput): LogEntry {
    return this.append(this.create(input))
  }

  /** 从新到旧返回最多 `limit` 条。默认全部。 */
  recent(limit?: number): LogEntry[] {
    const wanted = Number.isFinite(limit) ? Math.floor(limit as number) : this.#size
    const n = Math.max(0, Math.min(wanted, this.#size))
    const out: LogEntry[] = []
    const cap = this.#items.length
    for (let i = 0; i < n; i += 1) {
      // #next-1 是最新的一条；i < size ≤ cap，所以加一次 cap 后必为正
      const idx = (this.#next - 1 - i + cap) % cap
      const entry = this.#items[idx]
      if (entry !== undefined) out.push(entry)
    }
    return out
  }

  get(id: string): LogEntry | undefined {
    const cap = this.#items.length
    for (let i = 0; i < this.#size; i += 1) {
      const entry = this.#items[(this.#next - 1 - i + cap) % cap]
      if (entry !== undefined && entry.id === id) return entry
    }
    return undefined
  }

  has(id: string): boolean {
    return this.get(id) !== undefined
  }

  clear(): void {
    this.#items.fill(undefined)
    this.#next = 0
    this.#size = 0
  }
}

/** 契约 §2.1 的 `log` 消息 data 形状：不含 `ts`（信封里已有）。 */
export interface LogData {
  id: string
  level: LogLevel
  channel: LogChannel
  message: string
  meta?: Record<string, unknown>
}

/** `LogEntry` → WS `log` 消息的 `data`。多出来的 `ts` 被剥掉，严格对齐契约 §2.1。 */
export function toLogData(entry: LogEntry): LogData {
  const out: LogData = {
    id: entry.id,
    level: entry.level,
    channel: entry.channel,
    message: entry.message,
  }
  if (entry.meta !== undefined) out.meta = entry.meta
  return out
}

/**
 * 进程级单例。`/api/logs` 读它，`realtime/server.ts` 往它写并广播。
 *
 * 刻意放在模块作用域（而不是挂在 app 上）：阶段 2/4/5 的模块只 `import { log }`,
 * 不必拿到 app 实例。
 */
export const logBus = new LogBus()

/** 读单例缓冲：从新到旧最多 `limit` 条。`GET /api/logs` 走这里。 */
export function recentLogs(limit?: number): LogEntry[] {
  return logBus.recent(limit)
}
