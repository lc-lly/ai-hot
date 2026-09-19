import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import { HttpError } from '../errors.js'

/**
 * 键值配置（`Setting` 表）。
 *
 * ```
 * GET /api/settings           全部
 * GET /api/settings/:key      单条
 * PUT /api/settings/:key      写入（body: { value }）
 * ```
 *
 * ## 为什么是白名单而不是任意键
 *
 * `Setting` 是个没有约束的键值表，放任意键进来它立刻变成一堆没人清理的垃圾
 * ——而**没有任何地方会因此报错**，只是某个功能悄悄读不到它要的值。
 * 白名单让「写错键名」在请求的那一刻就变成 400，而不是三天后
 * 「为什么邮件一直发不出去」。
 *
 * ## 密钥不在这里
 *
 * `DEEPSEEK_API_KEY` / `SMTP_URL` / `VAPID_*` 是**环境变量**，不是 Setting。
 * 两条理由：一是它们不该被一个没有鉴权的 PUT 端点改写；二是 `.env` 是
 * 部署时确定的，运行时可改会让「换个环境跑」的行为无法预测。
 */

/** 允许通过 API 读写的键，值即用途说明（会出现在 400 的报错里）。 */
export const SETTING_KEYS: Readonly<Record<string, string>> = {
  /** 邮件通知的收件地址。`SMTP_URL` 里只有发信凭据，没有收件人。 */
  'notify.email': '通知邮件的收件地址',
  /** `discover` 的领域范围，也是 AI 判相关性时的默认主题（缺省「AI 编程」） */
  'discover.domain': '热点发现的领域主题',
}

/** 单值上限。Setting.value 是无长度约束的 TEXT，不设限等于允许写进一整本书。 */
const MAX_VALUE_CHARS = 2000

function assertKnownKey(key: string): void {
  if (!(key in SETTING_KEYS)) {
    throw new HttpError(
      400,
      'BAD_REQUEST',
      `未知的配置项「${key}」。可用：${Object.keys(SETTING_KEYS).join(' / ')}`,
    )
  }
}

export function settingRoutes(deps: { prisma: PrismaClient }): Router {
  const router = Router()
  const { prisma } = deps

  router.get('/settings', async (_req, res) => {
    const rows = await prisma.setting.findMany({ orderBy: { key: 'asc' } })
    res.json({
      data: rows.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
        // 界面上不必硬编码这些说明，读一次就够
        description: SETTING_KEYS[r.key] ?? null,
      })),
      // 从未被写过的键不会出现在上面的列表里，但 UI 需要知道它们存在
      known: Object.entries(SETTING_KEYS).map(([key, description]) => ({ key, description })),
    })
  })

  router.get('/settings/:key', async (req, res) => {
    const key = req.params.key
    assertKnownKey(key)
    const row = await prisma.setting.findUnique({ where: { key } })
    // 没写过不是 404：配置项的「未设置」是一个合法且常见的状态。
    // 返回空值让前端少写一个错误分支。
    res.json({
      data: {
        key,
        value: row?.value ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
        description: SETTING_KEYS[key] ?? null,
      },
    })
  })

  router.put('/settings/:key', async (req, res) => {
    const key = req.params.key
    assertKnownKey(key)

    const raw = (req.body as Record<string, unknown>)['value']
    if (typeof raw !== 'string') {
      throw new HttpError(400, 'BAD_REQUEST', 'value 必须是字符串（要清空请传空串）')
    }
    if (raw.length > MAX_VALUE_CHARS) {
      throw new HttpError(400, 'BAD_REQUEST', `value 最长 ${MAX_VALUE_CHARS} 字`)
    }

    const value = raw.trim()
    const row = await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    })

    res.json({
      data: {
        key: row.key,
        value: row.value,
        updatedAt: row.updatedAt.toISOString(),
        description: SETTING_KEYS[key] ?? null,
      },
    })
  })

  return router
}
