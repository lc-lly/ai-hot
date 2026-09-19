import type { PrismaClient } from '@prisma/client'
import { loadEnv, type Env } from '../env.js'
import type { NotifyFn, NotifyInput, NotifyOutcome } from '../jobs/types.js'
import { broadcast, log as realtimeLog } from '../realtime/index.js'
import { EMAIL_SETTING_KEY, emailConfigOf, sendEmail, type EmailConfig } from './email.js'
import { sendWebPush, webpushConfigOf, type WebPushConfig } from './webpush.js'

/**
 * 通知门面 —— `jobs/seams.ts` 的 `loadNotifier()` 动态 import 的就是这里。
 *
 * ## 一行 `Notification` = 一条事件，不是一条渠道
 *
 * 同一件事同时走站内 + 邮件 + 浏览器推送时，**只写一行**，
 * 三个渠道记在它的 `channels` 列里。分开写会让「已读」状态在三个渠道之间分裂
 * ——用户在站内点了已读，邮件那条还是未读，铃铛上的角标就再也清不掉了。
 *
 * ## 三个渠道各自的可用性
 *
 * | 渠道 | 前置条件 | 缺了会怎样 |
 * |---|---|---|
 * | `inapp` | 无 | 恒可用，是**底线** |
 * | `email` | `SMTP_URL` + 收件地址 | 自动禁用 |
 * | `webpush` | `VAPID_*` + 至少一条订阅 | 自动禁用 |
 *
 * 「自动禁用」的意思是：调用方传了 `channels: ['inapp','email']` 而邮件没配，
 * 结果里的 `channels` 就只有 `['inapp']`——**报告实际发生了什么**，
 * 而不是把请求过的渠道原样回显。回显的话，通知行上会写着一个
 * 从来没发出去过的 `email`。
 */

export interface NotifierDeps {
  prisma: PrismaClient
  /** 缺省 `loadEnv()`。`seams.ts` 只传 prisma。 */
  env?: Env
}

export const CHANNELS = ['inapp', 'email', 'webpush'] as const
export type Channel = (typeof CHANNELS)[number]

export interface ChannelStatus {
  name: Channel
  enabled: boolean
  /** 禁用原因；启用时为 null。直接展示给用户，说明「为什么没收到邮件」 */
  reason: string | null
}

/** 查三个渠道此刻各自能不能用。给 `GET /api/notifications/channels` 用。 */
export async function channelStatus(deps: NotifierDeps): Promise<ChannelStatus[]> {
  const env = deps.env ?? loadEnv()
  const email = emailConfigOf(env, await readSetting(deps.prisma, EMAIL_SETTING_KEY))
  const push = webpushConfigOf(env, email?.to ?? null)
  const subscriptions = push === null ? 0 : await deps.prisma.pushSubscription.count()

  return [
    { name: 'inapp', enabled: true, reason: null },
    {
      name: 'email',
      enabled: email !== null,
      reason:
        email !== null
          ? null
          : env.SMTP_URL === undefined
            ? '未配置 SMTP_URL'
            : '无法确定收件人：请在设置里填写 notify.email',
    },
    {
      name: 'webpush',
      enabled: push !== null && subscriptions > 0,
      reason:
        push === null
          ? '未配置 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY'
          : subscriptions === 0
            ? '还没有浏览器订阅（需要在前端授权通知权限）'
            : null,
    },
  ]
}

async function readSetting(prisma: PrismaClient, key: string): Promise<string | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } })
    return row?.value ?? null
  } catch {
    return null
  }
}

/**
 * 建一个通知器。
 *
 * 每个渠道的失败都是**局部**的：邮件服务器不通不该让站内消息也发不出去。
 * 所以逐个 `try/catch`，把失败写进 `Notification.error`，其余照常投递。
 */
export function createNotifier(deps: NotifierDeps): NotifyFn {
  return async (input: NotifyInput): Promise<NotifyOutcome> => {
    const env = deps.env ?? loadEnv()
    const emailCfg = emailConfigOf(env, await readSetting(deps.prisma, EMAIL_SETTING_KEY))
    const pushCfg = webpushConfigOf(env, emailCfg?.to ?? null)

    const requested = normalizeRequested(input.channels)
    const errors: string[] = []

    // 先落一行：站内消息是**记录**，也是「这件事发生过」的唯一凭证。
    // 渠道成败随后回填，所以这里先写空数组。
    const row = await deps.prisma.notification.create({
      data: {
        level: input.level,
        title: input.title,
        body: input.body,
        payload: JSON.stringify(input.payload ?? {}),
        channels: '[]',
        itemId: input.itemId ?? null,
        topicId: input.topicId ?? null,
      },
    })

    const delivered: Channel[] = []

    if (requested.includes('inapp')) delivered.push('inapp')

    if (requested.includes('email')) {
      if (emailCfg === null) {
        // 不是错误：没配 SMTP 是正常状态。静默降级，不刷日志。
      } else {
        try {
          await sendEmail(emailCfg, input.title, bodyOf(input))
          delivered.push('email')
        } catch (e) {
          errors.push(`email: ${message(e)}`)
        }
      }
    }

    if (requested.includes('webpush')) {
      if (pushCfg === null) {
        // 同上，未配置不是故障
      } else {
        try {
          const count = await sendWebPush(pushCfg, deps.prisma, {
            title: input.title,
            body: input.body,
            level: input.level,
            itemId: input.itemId ?? null,
            topicId: input.topicId ?? null,
            notificationId: row.id,
          })
          if (count > 0) delivered.push('webpush')
        } catch (e) {
          errors.push(`webpush: ${message(e)}`)
        }
      }
    }

    const error = errors.length > 0 ? errors.join('; ') : null

    // 回填实际投递的渠道。**不包含**请求过但不可用的那些——
    // 通知行是事实记录，不是请求日志。
    const finalRow = await deps.prisma.notification.update({
      where: { id: row.id },
      data: { channels: JSON.stringify(delivered), error },
    })

    if (error !== null) {
      realtimeLog({
        level: 'warn',
        channel: 'notify',
        message: `部分渠道投递失败：${error}`,
        meta: { notificationId: row.id, delivered },
      })
    }

    // 契约 §3.2：一行 = 一条站内消息。只推给浏览器，不回写数据库。
    broadcast('notification', {
      id: finalRow.id,
      createdAt: finalRow.sentAt.toISOString(),
      title: finalRow.title,
      body: finalRow.body,
      level: finalRow.level === 'push' ? 'push' : 'pending',
      read: finalRow.read,
      itemId: finalRow.itemId,
      topicId: finalRow.topicId,
      channels: delivered,
    })

    return { channels: delivered, notificationId: row.id }
  }
}

/**
 * 进程级默认通知器（`digest` / `discover` 的推送走它）。
 *
 * **按 prisma 实例缓存**，理由与 `triage/index.ts` 的 `aiLayerFor` 相同：
 * 每次新建都会重新读一遍 Setting、重新解析一遍 env。
 */
let defaultNotifier: NotifyFn | null = null
let defaultPrisma: PrismaClient | null = null

export function defaultNotify(prisma: PrismaClient): NotifyFn {
  if (defaultNotifier === null || defaultPrisma !== prisma) {
    defaultNotifier = createNotifier({ prisma })
    defaultPrisma = prisma
  }
  return defaultNotifier
}

function normalizeRequested(channels: readonly string[] | undefined): Channel[] {
  const list = channels ?? ['inapp']
  const out: Channel[] = []
  for (const raw of list) {
    if ((CHANNELS as readonly string[]).includes(raw) && !out.includes(raw as Channel)) {
      out.push(raw as Channel)
    }
  }
  // 请求了一个都不认识的值时兜底到站内：宁可多一条站内消息，
  // 也不要把一条通知彻底丢掉。
  return out.length > 0 ? out : ['inapp']
}

function bodyOf(input: NotifyInput): string {
  const lines = [input.body]
  const url = input.payload?.['url']
  if (typeof url === 'string' && url !== '') lines.push('', url)
  return lines.join('\n')
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export type { NotifyFn, NotifyInput, NotifyOutcome }
