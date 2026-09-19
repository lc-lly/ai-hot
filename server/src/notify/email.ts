import nodemailer, { type Transporter } from 'nodemailer'
import type { Env } from '../env.js'

/**
 * 邮件渠道。
 *
 * ## 为什么「缺配置就自动禁用」而不是「缺配置就报错」
 *
 * spec §12：可选依赖缺失不能让服务起不来。`SMTP_URL` 没配是完全正常的状态
 * ——绝大多数人不会为了收热点通知去配一个 SMTP。此时这个渠道**不出现**，
 * 站内消息照常工作，而不是每次 triage 都往日志里刷一条「邮件发送失败」，
 * 把真正的错误淹掉。
 */

export interface EmailConfig {
  /** `smtp://user:pass@smtp.example.com:465` 这种连接串 */
  url: string
  from: string
  to: string
}

/**
 * 收件人从哪来。
 *
 * `SMTP_URL` 里只有发信凭据，没有收件人——这是单用户应用，不需要用户表，
 * 所以约定用一个 `Setting` 行存收件地址。读不到时**退化到连接串里的用户名**：
 * `smtp://me@qq.com:授权码@smtp.qq.com` 这种写法里，用户名通常就是自己的邮箱，
 * 「给自己发通知」正是这个场景下唯一合理的默认值。
 *
 * 两者都拿不到就返回 null —— 不猜，也不发到某个硬编码的地址去。
 */
export const EMAIL_SETTING_KEY = 'notify.email'

export function emailConfigOf(env: Env, settingValue: string | null): EmailConfig | null {
  const url = env.SMTP_URL
  if (url === undefined) return null

  const fallback = usernameOf(url)
  const to = (settingValue ?? '').trim() || fallback
  if (!to) return null

  // from 必须是一个完整地址；用用户名拼一个，总比让 SMTP 服务端拒绝强
  const from = looksLikeEmail(fallback) ? fallback : `ai-hot <${to}>`
  return { url, from, to }
}

function usernameOf(url: string): string {
  try {
    const parsed = new URL(url)
    return decodeURIComponent(parsed.username)
  } catch {
    return ''
  }
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/**
 * transporter 按连接串缓存。
 *
 * `nodemailer.createTransport` 会建一个连接池，每次发信都新建一个的话，
 * 一小时一轮的定时任务会攒下一堆不回收的 socket。
 */
const transports = new Map<string, Transporter>()

function transportFor(url: string): Transporter {
  const cached = transports.get(url)
  if (cached) return cached
  const made = nodemailer.createTransport(url)
  transports.set(url, made)
  return made
}

export async function sendEmail(cfg: EmailConfig, subject: string, text: string): Promise<void> {
  await transportFor(cfg.url).sendMail({
    from: cfg.from,
    to: cfg.to,
    subject,
    text,
  })
}
