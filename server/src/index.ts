import { createApp } from './app.js'
import { createPrisma } from './db.js'
import { loadEnv } from './env.js'
import { startJobs } from './jobs/index.js'
import { attachRealtime, broadcast, clientCount } from './realtime/index.js'
import { registerBuiltinAdapters } from './sources/index.js'
import { seedDefaultSources } from './sources/seed.js'
import { computeStats, startStatsBroadcast } from './stats.js'

// 见 Task 3 Step 7 的说明
try {
  process.loadEnvFile()
} catch {
  // 没有 .env 文件是合法情况
}

const env = loadEnv()

// 必须在 createApp 之前：注册表是进程级 Map，首次请求打进来时它必须已经填好
registerBuiltinAdapters()

const prisma = createPrisma(env.DATABASE_URL)

// 补齐默认数据源（幂等，每次启动都跑；已存在的源配置不会被覆盖）。
// 放在 createApp 之前：首屏就要读 Source 列表，晚于 listen 会出现「明明配了却是空信息流」的窗口。
// 失败只记日志、不阻止启动——数据库暂时不可用（比如还没 migrate）时，
// 服务仍应起来并在 `/api/health` 上如实报告，而不是整个进程挂掉。
try {
  const seeded = await seedDefaultSources(prisma)
  console.log(`[ai-hot] 默认数据源已就绪：新增 ${seeded.created}，已存在 ${seeded.existing}`)
} catch (e) {
  console.error('[ai-hot] 写入默认数据源失败（不影响启动，稍后可在前端手动补）：', e)
}

// 定时任务必须在 createApp 之前起：`/api/jobs/:name/run` 要复用同一个实例，
// 否则手动触发跑在一个调度器上、cron 跑在另一个上，`running` 状态各算各的。
const jobs = startJobs({ prisma, env })

const app = createApp({ env, prisma, jobs })

const server = app.listen(env.PORT, () => {
  console.log(`[ai-hot] server listening on http://localhost:${env.PORT}`)
})

// 挂在同一个 http.Server 上——另起端口会让 Vite 代理要配两条，生产也多一个端口。
const realtime = attachRealtime(server, {
  env,
  prisma,
  // 新连接立刻拿到一次统计，否则统计卡要空等到第一个广播周期（15s）。
  // 实时层因此不需要认识 Prisma，边界不变。
  snapshot: async () => [['stats', await computeStats(prisma)] as const],
})

// 周期性广播统计。WS 断线时前端还有 `GET /api/stats` 兜底，
// 两条路径共用 `computeStats`，不会给出不同的数。
// 手动扫描（`POST /api/jobs/:name/run`）跑完之后前端会自己重新拉一次
// `/api/stats`——它知道自己的请求什么时候返回，比在这里加钩子更直接。
const statsBroadcast = startStatsBroadcast({ prisma, broadcast, clientCount })

async function shutdown(signal: string) {
  console.log(`[ai-hot] ${signal} received, shutting down`)
  // 顺序有讲究：先停会产生新数据的东西，再关传输层，最后断数据库。
  // 反过来的话，正在跑的任务会在 prisma 断开后写库并抛错。
  jobs.stop()
  statsBroadcast.stop()
  await realtime.close()
  server.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
