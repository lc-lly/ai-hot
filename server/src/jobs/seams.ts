import type { PrismaClient } from '@prisma/client'
import { broadcast, log as realtimeLog } from '../realtime/index.js'
import type { JobLogger, NotifyFn, NotifyInput, NotifyOutcome, RunTriageFn } from './types.js'

/**
 * 阶段 5 与并行模块之间的接缝。
 *
 * 阶段 5 的 `triage` 任务负责**编排**，三层过滤的逻辑与 `Match` 的落库
 * 属于 `src/triage/**`（并行 agent 所有）；`digest` / `discover` 要发通知，
 * 而三个通知渠道属于 `src/notify/**`（同上）。那两个目录在本模块开发时
 * 都还不存在，所以这里做两件事：
 *
 * 1. **动态加载**：模块一旦落地就自动接上，阶段 5 不需要改一行；
 * 2. **降级**：拿不到就记一条日志、返回空结果，绝不让定时任务把进程带崩
 *    （spec §12：缺可选依赖不影响启动）。
 *
 * 控制者也可以显式注入 `deps.runTriage` / `deps.notify` 直接绕过这里。
 */

/** 写成变量而不是字面量：这两个模块可能还不存在，
 *  字面量会让 `tsc` 在模块出现之前就报「找不到模块」。 */
const TRIAGE_MODULE = '../triage/index.js'
const NOTIFY_MODULE = '../notify/index.js'

/** 默认日志出口：走实时层（进环形缓冲 + WS 广播），与采集 / AI 的日志同一条流。 */
export const realtimeJobLogger: JobLogger = (event) => {
  realtimeLog(event)
}

/** 测试用：吞掉一切日志。 */
export const silentJobLogger: JobLogger = () => {}

/**
 * 尝试加载 `src/triage/**` 的入口。
 *
 * 期望的形状（控制者接线时请对齐）：
 * ```ts
 * export async function runTriage(deps: {
 *   prisma: PrismaClient
 *   env?: Env
 *   now: Date
 *   limit?: number
 *   retryFailed?: boolean
 * }): Promise<TriageResult>
 * ```
 * 找不到模块、或导出的不是函数时返回 `null`（调用方据此把本轮标记为降级）。
 */
export async function loadTriageRunner(): Promise<RunTriageFn | null> {
  try {
    const mod: unknown = await import(TRIAGE_MODULE)
    if (mod === null || typeof mod !== 'object') return null
    const fn = (mod as Record<string, unknown>)['runTriage']
    if (typeof fn !== 'function') return null
    return async (options) =>
      (fn as (o: unknown) => Promise<unknown>)({ ...options })
  } catch {
    return null
  }
}

interface NotifierFactoryDeps {
  prisma: PrismaClient
}

/**
 * 尝试加载 `src/notify/**` 的入口。
 *
 * 接受两种形状：
 * - `export function notify(input: NotifyInput): Promise<NotifyOutcome>`；
 * - `export function createNotifier(deps: { prisma }): NotifyFn`。
 */
export async function loadNotifier(deps: NotifierFactoryDeps): Promise<NotifyFn | null> {
  let mod: unknown
  try {
    mod = await import(NOTIFY_MODULE)
  } catch {
    return null
  }
  if (mod === null || typeof mod !== 'object') return null

  const bag = mod as Record<string, unknown>

  const create = bag['createNotifier']
  if (typeof create === 'function') {
    try {
      const made = (create as (d: unknown) => unknown)({ prisma: deps.prisma })
      if (typeof made === 'function') return made as NotifyFn
      const run = (made as Record<string, unknown> | null)?.['notify']
      if (typeof run === 'function') return run as NotifyFn
    } catch {
      // 工厂炸了就当没有，降级到站内
    }
  }

  const notify = bag['notify']
  if (typeof notify === 'function') return notify as NotifyFn
  return null
}

function normalizeOutcome(raw: unknown): NotifyOutcome {
  if (raw !== null && typeof raw === 'object') {
    const channels = (raw as Record<string, unknown>)['channels']
    const id = (raw as Record<string, unknown>)['notificationId']
    if (Array.isArray(channels)) {
      const list = channels.filter((c): c is string => typeof c === 'string')
      return typeof id === 'string' ? { channels: list, notificationId: id } : { channels: list }
    }
  }
  return { channels: [] }
}

/**
 * 缺省通知实现：**只做站内**（写 `Notification` 行 + WS 广播）。
 *
 * 这是「降级也仍然可用」的底线——`src/notify/**` 不到位时，
 * 日报和发现推送至少还能在站内消息中心看到，而不是彻底消失。
 * 邮件 / Web Push 需要 SMTP / VAPID 配置，属于并行模块的职责。
 */
export function createInappNotifier(prisma: PrismaClient): NotifyFn {
  return async (input: NotifyInput): Promise<NotifyOutcome> => {
    const channels = ['inapp']
    const row = await prisma.notification.create({
      data: {
        level: input.level,
        title: input.title,
        body: input.body,
        payload: JSON.stringify(input.payload ?? {}),
        channels: JSON.stringify(channels),
        itemId: input.itemId ?? null,
        topicId: input.topicId ?? null,
      },
    })

    // 契约 §3.2 的 NotificationDTO：一行 = 一条站内消息
    broadcast('notification', {
      id: row.id,
      createdAt: row.sentAt.toISOString(),
      title: row.title,
      body: row.body,
      level: row.level === 'push' ? 'push' : 'pending',
      read: row.read,
      itemId: row.itemId,
      topicId: row.topicId,
      channels,
    })

    return { channels, notificationId: row.id }
  }
}

/** 优先用外部通知模块，拿不到就用站内兜底。 */
export async function resolveNotifier(
  prisma: PrismaClient,
  injected: NotifyFn | undefined,
): Promise<{ notify: NotifyFn; source: 'injected' | 'module' | 'inapp' }> {
  if (injected) {
    return {
      notify: async (input) => normalizeOutcome(await injected(withDefaultChannels(input))),
      source: 'injected',
    }
  }
  const loaded = await loadNotifier({ prisma })
  if (loaded) {
    return {
      notify: async (input) => normalizeOutcome(await loaded(withDefaultChannels(input))),
      source: 'module',
    }
  }
  return { notify: createInappNotifier(prisma), source: 'inapp' }
}

function withDefaultChannels(input: NotifyInput): NotifyInput {
  return input.channels === undefined ? { ...input, channels: ['inapp'] } : input
}
