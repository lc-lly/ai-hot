import type { ItemDTO } from '../score/types.js'
import type { LogData } from './logbus.js'

/**
 * 契约 §2 冻结的 WS 消息类型。
 *
 * 所有服务端 → 客户端的消息统一信封 `{ type, ts, data }`（`ts` 为 ISO 8601），
 * 包括心跳应答 `pong`。
 */

export const SERVER_VERSION = '0.1.0'

/** 契约 §2.1 的消息类型（`pong` 不在表里，仅为心跳应答）。 */
export type ServerMessageType =
  | 'hello'
  | 'log'
  | 'item'
  | 'notification'
  | 'source'
  | 'stats'
  | 'pong'

/** 客户端 → 服务端只实现 `ping`（契约 §2.2）。 */
export type ClientMessageType = 'ping'

export interface Envelope<T = unknown> {
  type: string
  /** ISO 8601 */
  ts: string
  data: T
}

/** `hello` 的 data。连接建立后立即发一次。 */
export interface HelloData {
  /** ISO 8601 */
  serverTime: string
  version: string
}

/** `source` 的 data：数据源健康状态变化。 */
export interface SourceHealthData {
  id: string
  name: string
  kind: string
  lastOk: boolean | null
  /** ISO 8601 */
  lastRunAt: string | null
  lastError: string | null
}

/**
 * `stats` 的 data：四张统计卡。
 *
 * 这五个字段与 `GET /api/stats` 的响应**是同一个形状**，
 * 计算也共用 `src/stats.ts` 的 `computeStats`——两条路径不会漂移。
 *
 * 旧版是 `{ pending, todayMatches, tokensToday }`，与卡片上的四个数字
 * 一个都对不上（那是为成本面板设计的，而成本面板没有做）。
 * 改这个形状要同步四处，漏掉 `web/src/lib/normalize.ts` 的 `normalizeStats`
 * 会让前端**静默丢弃**整个对象——不报错，只是卡片永远显示 0。
 */
export interface StatsData {
  /** 全库条目总数。**不受筛选影响**（筛选后的条数在 `/api/items` 的 pagination 里） */
  total: number
  /** 近 24 小时新增。滚动窗口，不是「今天 00:00」，理由见 `../window.js` */
  today: number
  /** `importance = 'urgent'` 的条数 */
  urgent: number
  /** **启用中**的监控词数 */
  topicCount: number
  /** 未读通知数 */
  unread: number
}

/** 契约 §3.2 冻结的 `NotificationDTO`，也是 `notification` 的 data。 */
export interface NotificationDTO {
  id: string
  /** ISO 8601 */
  createdAt: string
  title: string
  body: string
  level: 'push' | 'pending'
  read: boolean
  itemId: string | null
  topicId: string | null
  /** 实际投递成功的渠道：inapp | webpush | email */
  channels: string[]
}

export type HelloMessage = Envelope<HelloData>
export type LogMessage = Envelope<LogData>
export type ItemMessage = Envelope<ItemDTO>
export type NotificationMessage = Envelope<NotificationDTO>
export type SourceMessage = Envelope<SourceHealthData>
export type StatsMessage = Envelope<StatsData>
export type PongMessage = Envelope<Record<string, never>>
