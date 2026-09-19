import { Router } from 'express'
import { logBus as defaultLogBus, type LogBus, type LogEntry } from '../realtime/logbus.js'

/**
 * `GET /api/logs?limit=200` —— 契约 §4 的「最近日志（内存环形缓冲）」。
 *
 * 它是 WS 断开时的**轮询兜底**：前端在 WS 活着时用推送，断了就用这里补齐，
 * 所以返回的每条都带 `ts`（WS 的 `log.data` 不带，时间在信封里）。
 *
 * 签名遵循契约 §5.1：`xxxRoutes(deps): Router`。
 */
export interface LogRoutesDeps {
  /** 默认用进程级单例；测试可注入独立实例 */
  logBus?: LogBus
}

export const LOGS_DEFAULT_LIMIT = 200
export const LOGS_MAX_LIMIT = 1000

function parseLimit(raw: unknown): number {
  const n = Number(raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) {
    return LOGS_DEFAULT_LIMIT
  }
  return Math.min(Math.max(Math.floor(n), 1), LOGS_MAX_LIMIT)
}

export interface LogsResponse {
  count: number
  logs: LogEntry[]
}

export function logRoutes(deps: LogRoutesDeps = {}): Router {
  const router = Router()
  const bus = deps.logBus ?? defaultLogBus

  router.get('/logs', (req, res) => {
    const limit = parseLimit(req.query.limit)
    const logs = bus.recent(limit)
    const body: LogsResponse = { count: logs.length, logs }
    res.json(body)
  })

  return router
}
