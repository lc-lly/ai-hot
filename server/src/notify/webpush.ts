import type { PrismaClient } from '@prisma/client'
import webpush from 'web-push'
import type { Env } from '../env.js'

/**
 * Web Push（浏览器通知）渠道。
 *
 * ## 三个前置条件，缺一个就整个渠道禁用
 *
 * 1. `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` —— 没有密钥对，推送服务端
 *    根本不接受请求。密钥用 `npx web-push generate-vapid-keys` 生成。
 * 2. `VAPID_SUBJECT` —— 一个 `mailto:` 或 `https:` 地址，规范要求必填，
 *    推送服务用它联系「发送方」是谁。缺省用收件邮箱拼一个。
 * 3. **至少一条 `PushSubscription`** —— 用户得先在浏览器里授权。
 *    没有订阅时，即使密钥配好了也不该出现在「已投递渠道」里，
 *    否则通知行上会写着一个什么都没发生的 `webpush`。
 */

export interface WebPushConfig {
  publicKey: string
  privateKey: string
  subject: string
}

export function webpushConfigOf(env: Env, subjectFallback: string | null): WebPushConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY
  const privateKey = env.VAPID_PRIVATE_KEY
  if (publicKey === undefined || privateKey === undefined) return null

  const subject = subjectFallback?.trim() ? `mailto:${subjectFallback.trim()}` : 'mailto:ai-hot@localhost'
  return { publicKey, privateKey, subject }
}

/**
 * 往所有订阅端点发一轮。返回**成功送达的条数**。
 *
 * ## 失效订阅必须删掉
 *
 * 推送服务对已经卸载/清了数据的浏览器返回 404 或 410，这是**永久失效**，
 * 重试多少次都一样。不删的话，每个订阅端点每一轮都要打一次必失败的请求，
 * 而 `failCount` 涨到再高也不会自己变小。
 */
export async function sendWebPush(
  cfg: WebPushConfig,
  prisma: PrismaClient,
  payload: Record<string, unknown>,
): Promise<number> {
  const subs = await prisma.pushSubscription.findMany()
  if (subs.length === 0) return 0

  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey)
  const body = JSON.stringify(payload)

  let delivered = 0
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        )
        delivered += 1
        if (sub.failCount !== 0) {
          await prisma.pushSubscription.update({ where: { id: sub.id }, data: { failCount: 0 } })
        }
      } catch (e) {
        const status = statusOf(e)
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {})
          return
        }
        await prisma.pushSubscription
          .update({ where: { id: sub.id }, data: { failCount: { increment: 1 } } })
          .catch(() => {})
      }
    }),
  )

  return delivered
}

function statusOf(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null
  const status = (e as { statusCode?: unknown }).statusCode
  return typeof status === 'number' ? status : null
}
