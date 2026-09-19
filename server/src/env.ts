import { z } from 'zod'

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === '1' || v.toLowerCase() === 'true'))

const optionalString = () =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v))

/**
 * 先归一空串再转数字。不能直接 `z.coerce.number().default(n)`——
 * `.default()` 只对 `undefined` 生效，`.env` 里写 `KEY=` 会硬失败。
 */
const optionalNumber = (def: number) =>
  optionalString().pipe(z.coerce.number().int().positive().default(def))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().min(1).default('file:./dev.db'),
  DEEPSEEK_API_KEY: optionalString(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL_FAST: z.string().min(1).default('deepseek-flash'),
  DEEPSEEK_MODEL_SMART: z.string().min(1).default('deepseek-v4-pro'),
  AI_MOCK: bool(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /// 阶段 2：每日 token 预算上限，超出后自动降级为只跑 L0 + L1（spec §4.4）
  AI_DAILY_TOKEN_BUDGET: optionalNumber(200_000),

  /// 阶段 8：Agent API 的 Bearer Token。为空则 /api/agent/* 整个禁用
  AI_HOT_TOKEN: optionalString(),

  /// 阶段 4：三个可选通知渠道。为空则对应渠道自动禁用，不影响启动（spec §12）
  SMTP_URL: optionalString(),
  VAPID_PUBLIC_KEY: optionalString(),
  VAPID_PRIVATE_KEY: optionalString(),

  /// 阶段 6：可选的付费数据源。为空则对应源不出现在可用列表里
  TWITTERAPI_IO_KEY: optionalString(),
  FIRECRAWL_API_KEY: optionalString(),
})

export type Env = z.infer<typeof schema>

export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(src)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`环境变量校验失败 -> ${detail}`)
  }
  return parsed.data
}
