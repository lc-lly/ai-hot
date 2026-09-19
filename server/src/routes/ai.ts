import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import { loadEnv, type Env } from '../env.js'
import { HttpError } from '../errors.js'
import {
  AiUnavailableError,
  type AiLayer,
  type AiLogger,
  type VerifyInput,
} from '../ai/index.js'
import { aiLayerFor } from '../triage/index.js'

/**
 * 阶段 2 的两个 AI 端点（契约 §4，冻结）：
 *
 *   GET  /api/ai/stats   成本面板
 *   POST /api/ai/verify  单条真伪判定，返回 `ItemScore`（供 Agent Skill 的 verify 用）
 *
 * 挂载方式（契约 §5.1）：
 *   app.use('/api', aiRoutes({ prisma, env }))
 *
 * `env` 可省：省了就从 process.env 兜底加载；连加载都失败（环境变量脏）时
 * 用一份「AI 关闭」的安全默认，宁可 AI 不可用也不能让整个 app 起不来
 * （spec §12：缺可选依赖不影响启动）。
 */

export interface AiRoutesDeps {
  prisma: PrismaClient
  env?: Env
  fetch?: typeof globalThis.fetch
  logger?: AiLogger
  now?: () => Date
  /** 测试注入；不传则自行 createAiLayer */
  ai?: AiLayer
}

/** 环境变量脏到 loadEnv 都过不去时的兜底：AI 全关，进程照常 */
function fallbackEnv(): Env {
  try {
    return loadEnv()
  } catch {
    return loadEnv({
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      DEEPSEEK_API_KEY: '',
      AI_MOCK: '0',
      AI_DAILY_TOKEN_BUDGET: '200000',
    })
  }
}

export function aiRoutes(deps: AiRoutesDeps): Router {
  const router = Router()
  const env = deps.env ?? fallbackEnv()

  // 在 createApp 期间就把层建起来：模型探测是 createAiLayer 内部发起的
  // fire-and-forget（无 key / AI_MOCK=1 时根本不发请求），
  // 所以这一步既满足 spec §4.3「启动时探 /models」，又不需要改 index.ts。
  //
  // **走 `aiLayerFor` 而不是 `createAiLayer`**：定时任务（`src/triage/**`）
  // 用的是同一个工厂。各建各的会让 `AI_DAILY_TOKEN_BUDGET` 被两条路径
  // 各自算一遍，实际花掉两倍——而两边都显示「还没超预算」。
  // 传了注入项时 `aiLayerFor` 不缓存，测试的假 fetch 不会漏给真实调用方。
  const layer: AiLayer =
    deps.ai ??
    aiLayerFor(deps.prisma, env, { fetch: deps.fetch, logger: deps.logger, now: deps.now })

  router.get('/ai/stats', async (_req, res) => {
    const now = deps.now ? deps.now() : new Date()
    res.json(await layer.stats(now))
  })

  router.post('/ai/verify', async (req, res) => {
    const body = (req.body ?? {}) as { url?: unknown; text?: unknown; topic?: unknown }

    const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined
    const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : undefined
    if (!url && !text) {
      throw new HttpError(400, 'BAD_REQUEST', 'url 与 text 至少提供一个')
    }

    const input: VerifyInput = {
      url,
      text,
      topic: typeof body.topic === 'string' && body.topic.trim() ? body.topic.trim() : undefined,
    }

    try {
      const score = await layer.verify(input)
      res.json(score)
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        // 没配 key 是「能力不可用」，不是服务端 bug——503 而不是 500，
        // 让 Agent Skill 那边能区分「稍后重试」和「请求写错了」
        throw new HttpError(503, e.code, e.message)
      }
      if (e instanceof Error && e.message.includes('至少需要一个')) {
        throw new HttpError(400, 'BAD_REQUEST', e.message)
      }
      throw e
    }
  })

  return router
}
