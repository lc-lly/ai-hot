import type { PrismaClient } from '@prisma/client'
import type { Env } from '../env.js'

/**
 * 真伪标签（spec §4 的 L2 输出）。
 * 这六个标签是**冻结口径**——契约 §3.1 的 `ItemDTO.flags` 直接透传给前端，
 * 增删都必须先改契约。
 */
export type AiFlag = 'clickbait' | 'ai_generated' | 'rumor' | 'stale' | 'ad' | 'unverified'

export const AI_FLAGS: readonly AiFlag[] = [
  'clickbait',
  'ai_generated',
  'rumor',
  'stale',
  'ad',
  'unverified',
] as const

export function isAiFlag(value: unknown): value is AiFlag {
  return typeof value === 'string' && (AI_FLAGS as readonly string[]).includes(value)
}

/**
 * 把 AI 返回值或数据库里的 JSON 字符串收敛成合法标签数组。
 * 模型偶尔会吐出不在枚举里的词（"misleading" 之类），
 * 直接原样落库会让前端的图标映射拿到空值——所以这里只保留认识的那几个。
 */
export function normalizeFlags(input: unknown): AiFlag[] {
  const raw: unknown[] =
    typeof input === 'string'
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(input)
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })()
      : Array.isArray(input)
        ? input
        : []

  const out: AiFlag[] = []
  for (const v of raw) {
    if (isAiFlag(v) && !out.includes(v)) out.push(v)
  }
  return out
}

/** spec §4.1 / 契约 §3.5 的分流档位 */
export type Tier = 'push' | 'pending' | 'filtered'

/** 契约 §3.1 的 `ItemScore`，原样实现，不得改名 */
export interface ItemScore {
  relevance: number
  authenticity: number
  confidence: number
  flags: string[]
  reasoning: string
  tier: Tier
}

/** `HotItem.aiState` 的四个取值（与 schema 注释一致） */
export type AiState = 'pending' | 'done' | 'skipped' | 'failed'

// ---------------------------------------------------------------- 日志

export type AiLogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * AI 层往外发的日志事件。形状对齐契约 §2.1 的 WS `log` 消息
 * （`id` / `ts` 由阶段 3 的实时层补齐，AI 层不关心）。
 */
export interface AiLogEvent {
  level: AiLogLevel
  channel: 'ai'
  message: string
  meta?: Record<string, unknown>
}

export type AiLogger = (event: AiLogEvent) => void

export function consoleAiLogger(event: AiLogEvent): void {
  const line = `[ai] ${event.message}`
  if (event.level === 'error') console.error(line, event.meta ?? '')
  else if (event.level === 'warn') console.warn(line, event.meta ?? '')
  else console.log(line, event.meta ?? '')
}

/** 测试用：吞掉一切日志，保持输出干净 */
export const silentAiLogger: AiLogger = () => {}

// ---------------------------------------------------------------- 依赖

export interface AiDeps {
  env: Env
  prisma: PrismaClient
  /** 注入 fetch，测试可传假实现；AI 层永远不直接碰 globalThis.fetch */
  fetch?: typeof globalThis.fetch
  logger?: AiLogger
  now?: () => Date
}

// ---------------------------------------------------------------- 成本面板

export interface UsageTotals {
  calls: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

/** `GET /api/ai/stats` 的响应体，契约 §4 冻结 */
export interface AiStats {
  today: UsageTotals
  byModel: Array<UsageTotals & { model: string }>
  budget: {
    /** `AI_DAILY_TOKEN_BUDGET` */
    limit: number
    /** 今日已用 token（in + out） */
    used: number
    /** 已达上限 → 本轮只跑 L0 + L1（spec §4.4） */
    degraded: boolean
  }
}

// ---------------------------------------------------------------- 工具

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** 保留三位小数。浮点噪声会让 0.8 变成 0.7999999，分流时卡在阈值上。 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
