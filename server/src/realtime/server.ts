import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  isLogChannel,
  isLogLevel,
  logBus as defaultLogBus,
  LogBus,
  toLogData,
  type LogEntry,
  type LogInput,
} from './logbus.js'
import { SERVER_VERSION, type Envelope, type HelloData } from './types.js'

/**
 * 实时层：一个挂在既有 `http.Server` 上的 WS 服务端 + 一个进程级广播器。
 *
 * 契约 §1：**必须挂在同一个 server 实例上**（`{ server, path }`），不另起端口。
 * 契约 §5.1：本模块只导出 `attachRealtime(server, deps)`，由控制者在 `index.ts` 里调用。
 *
 * 模块边界：这里**不 import Express、不 import Prisma**，
 * 阶段 2（AI）/ 4（通知）/ 5（定时）可以放心 `import { broadcast, log }`，不会成环。
 */

export interface RealtimeDeps {
  /** WS 路径，默认 `/ws`（契约 §2） */
  path?: string
  /** `hello` 里的版本号，默认 `SERVER_VERSION` */
  version?: string
  /** 心跳间隔（ms），默认 30s；超过一个周期没收到 pong / 任何消息的连接会被 terminate */
  heartbeatIntervalMs?: number
  /** 覆盖默认的进程级 logBus（测试用） */
  logBus?: LogBus
  /** 注入时钟（测试用） */
  now?: () => Date
  /**
   * 新连接建立后（`hello` 之后）补发的一次性快照，返回 `[type, data]` 列表。
   *
   * 解决的是「连上以后要等一个广播周期才有数」——统计卡会空 15 秒。
   * 让 `index.ts` 在这里注入 `[['stats', await computeStats(prisma)]]`，
   * 本模块就不需要认识 Prisma，边界保持不变。
   *
   * 抛错只吞掉：快照失败不该让连接建不起来（前端还有 HTTP 兜底）。
   */
  snapshot?: () => Promise<ReadonlyArray<readonly [string, unknown]>>
  /**
   * 控制者从 `index.ts` 传进来的其它 deps（`env` / `prisma` 等）本模块不读，
   * 但接受，避免 `attachRealtime(server, { prisma })` 触发 TS 的多余属性检查。
   */
  [key: string]: unknown
}

export interface RealtimeHandle {
  readonly path: string
  readonly wss: WebSocketServer
  readonly logBus: LogBus
  /** 当前 OPEN 的客户端数（不含已判定死亡的）。 */
  clientCount(): number
  /** 向所有 OPEN 的客户端广播一条信封消息，返回实际发出的连接数。 */
  broadcast(type: string, data: unknown): number
  /** 写一条日志：入环形缓冲 + 广播。返回写入的 entry。 */
  log(input: LogInput): LogEntry
  /** 停心跳、断开全部客户端、摘掉 `upgrade` 监听。不关底层的 http.Server。 */
  close(): Promise<void>
}

interface Hub {
  sockets: Set<WebSocket>
  logBus: LogBus
  sendAll: (type: string, data: unknown) => number
  handle: RealtimeHandle
}

/** 当前挂载的 hub。同一进程只应挂一个（契约 §1：一个 server，一个端口）。 */
let activeHub: Hub | null = null

/** 进程级广播。没有客户端 / 没有挂载时是安全的 no-op，返回发出的连接数。 */
export function broadcast(type: string, data: unknown): number {
  const hub = activeHub
  // `broadcast('log', ...)` 也要进环形缓冲——调用方不该为了「别忘了存日志」而踩坑
  if (type === 'log') {
    if (hub === null) {
      defaultLogBus.log(normalizeLogInput(toRecord(data)))
      return 0
    }
    return broadcastLogVia(hub.logBus, hub.sendAll, data)
  }
  return hub === null ? 0 : hub.sendAll(type, data)
}

/** 进程级写日志：**一次调用，两个效果**（入环形缓冲 + WS 广播）。 */
export function log(input: LogInput): LogEntry {
  const hub = activeHub
  const entry = (hub?.logBus ?? defaultLogBus).log(input)
  hub?.sendAll('log', toLogData(entry))
  return entry
}

/** 进程级连接数。 */
export function clientCount(): number {
  return activeHub === null ? 0 : activeHub.sockets.size
}

/**
 * 挂在既有 http.Server 上。返回的 handle 自带 broadcast / log / close，便于测试与优雅退出。
 */
export function attachRealtime(server: HttpServer, deps: RealtimeDeps = {}): RealtimeHandle {
  const path = typeof deps.path === 'string' ? deps.path : '/ws'
  const version = typeof deps.version === 'string' ? deps.version : SERVER_VERSION
  const bus = deps.logBus instanceof LogBus ? deps.logBus : defaultLogBus
  const now = typeof deps.now === 'function' ? deps.now : (): Date => new Date()
  const snapshot = typeof deps.snapshot === 'function' ? deps.snapshot : null
  const heartbeatMs =
    typeof deps.heartbeatIntervalMs === 'number' && deps.heartbeatIntervalMs > 0
      ? deps.heartbeatIntervalMs
      : 30_000

  const sockets = new Set<WebSocket>()
  const alive = new Map<WebSocket, boolean>()
  const wss = new WebSocketServer({ server, path })

  const drop = (ws: WebSocket): void => {
    sockets.delete(ws)
    alive.delete(ws)
  }

  const envelope = <T>(type: string, data: T): Envelope<T> => ({
    type,
    ts: now().toISOString(),
    data,
  })

  const sendTo = (ws: WebSocket, type: string, data: unknown): boolean => {
    if (ws.readyState !== WebSocket.OPEN) {
      drop(ws)
      return false
    }
    try {
      ws.send(JSON.stringify(envelope(type, data)))
      return true
    } catch {
      drop(ws)
      try {
        ws.terminate()
      } catch {
        /* 已断开，忽略 */
      }
      return false
    }
  }

  const sendAll = (type: string, data: unknown): number => {
    // 先快照：send 失败时会从 sockets 里删元素
    const targets = [...sockets]
    if (targets.length === 0) return 0

    const payload = JSON.stringify(envelope(type, data))
    let sent = 0
    for (const ws of targets) {
      if (ws.readyState !== WebSocket.OPEN) {
        drop(ws)
        continue
      }
      try {
        ws.send(payload)
        sent += 1
      } catch {
        drop(ws)
        try {
          ws.terminate()
        } catch {
          /* 已断开，忽略 */
        }
      }
    }
    return sent
  }

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    sockets.add(ws)
    alive.set(ws, true)

    const hello: HelloData = { serverTime: now().toISOString(), version }
    sendTo(ws, 'hello', hello)

    // 补发快照。刻意不 await：连接建立不该等一次数据库查询，
    // 而且 sendTo 自己会检查 readyState，客户端提前断开也只是发不出去而已。
    if (snapshot) {
      void snapshot()
        .then((entries) => {
          for (const [type, data] of entries) sendTo(ws, type, data)
        })
        .catch(() => {
          /* 快照失败：前端还有 HTTP 兜底，不是致命问题 */
        })
    }

    ws.on('pong', () => {
      alive.set(ws, true)
    })

    ws.on('message', (raw: RawData) => {
      alive.set(ws, true)
      if (parseClientMessage(raw) === 'ping') sendTo(ws, 'pong', {})
    })

    ws.on('close', () => drop(ws))
    ws.on('error', () => {
      drop(ws)
      try {
        ws.terminate()
      } catch {
        /* 已断开，忽略 */
      }
    })
  })

  // 心跳：一个周期内既没收到 pong 也没收到任何应用层消息，就认定是半开连接
  const timer = setInterval(() => {
    for (const [ws, isAlive] of [...alive]) {
      if (!isAlive) {
        drop(ws)
        try {
          ws.terminate()
        } catch {
          /* 已断开，忽略 */
        }
        continue
      }
      alive.set(ws, false)
      try {
        ws.ping()
      } catch {
        drop(ws)
      }
    }
  }, heartbeatMs)
  // 别让心跳把进程钉住（测试 / CLI 场景）
  timer.unref()

  const handle: RealtimeHandle = {
    path,
    wss,
    logBus: bus,
    clientCount: () => sockets.size,
    broadcast: (type, data) =>
      type === 'log' ? broadcastLogVia(bus, sendAll, data) : sendAll(type, data),
    log: (input) => {
      const entry = bus.log(input)
      sendAll('log', toLogData(entry))
      return entry
    },
    close: async () => {
      clearInterval(timer)
      for (const ws of [...sockets]) {
        try {
          ws.terminate()
        } catch {
          /* 已断开，忽略 */
        }
      }
      sockets.clear()
      alive.clear()
      if (activeHub !== null && activeHub.handle === handle) activeHub = null
      await new Promise<void>((resolve) => {
        try {
          wss.close(() => resolve())
        } catch {
          resolve()
        }
      })
    },
  }

  activeHub = {
    sockets,
    logBus: bus,
    sendAll,
    handle,
  }

  return handle
}

/** `broadcast('log', ...)` 的实现：先保证入缓冲，再转发。 */
function broadcastLogVia(
  bus: LogBus,
  sendAll: (type: string, data: unknown) => number,
  data: unknown,
): number {
  const obj = toRecord(data)

  // 已经是缓冲里的一条（例如先 log() 拿 entry 再 broadcast）：只转发，不重复入缓冲
  const id = obj?.['id']
  if (typeof id === 'string') {
    const existing = bus.get(id)
    if (existing !== undefined) return sendAll('log', toLogData(existing))
  }

  return sendAll('log', toLogData(bus.log(normalizeLogInput(obj))))
}

function toRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/** 把 `broadcast('log', {...})` 的入参掰成合法 `LogInput`，脏值降级而不是抛。 */
function normalizeLogInput(obj: Record<string, unknown> | null): LogInput {
  const level = obj?.['level']
  const channel = obj?.['channel']
  const message = obj?.['message']
  const meta = toRecord(obj?.['meta'])

  const input: LogInput = {
    channel: isLogChannel(channel) ? channel : 'system',
    message: typeof message === 'string' ? message : message === undefined ? '' : String(message),
    level: isLogLevel(level) ? level : 'info',
  }
  if (meta !== null) input.meta = meta
  return input
}

/** 客户端 → 服务端只有 `ping`（契约 §2.2）；解析不出来一律忽略，不报错。 */
function parseClientMessage(raw: RawData): string | null {
  let text: string
  if (typeof raw === 'string') text = raw
  else if (Buffer.isBuffer(raw)) text = raw.toString('utf8')
  else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8')
  else text = Buffer.from(raw).toString('utf8')

  try {
    const parsed: unknown = JSON.parse(text)
    const type = toRecord(parsed)?.['type']
    return typeof type === 'string' ? type : null
  } catch {
    return null
  }
}
