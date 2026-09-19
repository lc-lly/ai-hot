/**
 * 实时层的公开面。阶段 2 / 4 / 5 从这里 import `broadcast` / `log`。
 *
 * 例：
 * ```ts
 * import { broadcast, log } from '../realtime/index.js'
 *
 * log({ channel: 'fetch', level: 'info', message: 'hackernews: 30 条', meta: { sourceId } })
 * broadcast('item', toItemDTO(row))
 * ```
 */
export {
  attachRealtime,
  broadcast,
  clientCount,
  log,
  type RealtimeDeps,
  type RealtimeHandle,
} from './server.js'

export {
  DEFAULT_LOG_CAPACITY,
  isLogChannel,
  isLogLevel,
  LogBus,
  logBus,
  LOG_CHANNELS,
  LOG_LEVELS,
  recentLogs,
  toLogData,
  type LogChannel,
  type LogData,
  type LogEntry,
  type LogInput,
  type LogLevel,
} from './logbus.js'

export { SERVER_VERSION } from './types.js'
export type {
  ClientMessageType,
  Envelope,
  HelloData,
  HelloMessage,
  ItemMessage,
  LogMessage,
  NotificationDTO,
  NotificationMessage,
  PongMessage,
  ServerMessageType,
  SourceHealthData,
  SourceMessage,
  StatsData,
  StatsMessage,
} from './types.js'
