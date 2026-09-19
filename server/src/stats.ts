import type { PrismaClient } from '@prisma/client'
import type { StatsData } from './realtime/types.js'
import { TODAY_WINDOW_HOURS, rollingWindowFilter } from './window.js'

/**
 * 四张统计卡的数据。
 *
 * ## 为什么必须有 HTTP 端点，不能只靠 WS 广播
 *
 * 原来 `stats` 只有 WS 一个写入源。WS 一断（切网络、休眠唤醒、代理掐连接）
 * 统计卡就永久冻在最后一次收到的数字上，而页面上没有任何迹象表明它已经不新鲜了。
 * 广播是「变化时更快」，HTTP 是「任何时候都能问一次」。两者都要有。
 *
 * ## `total` 与 `/api/items` 的 `pagination.total` 是两回事
 *
 * 这里的 `total` 恒为**全库**，不受任何筛选影响；`/api/items` 的
 * `pagination.total` 是**筛选后**的条数。语义分开，否则
 * 「统计卡说 62 条、下面写着第 1/3 页共 20 条」看起来像 bug。
 */
export type StatsSnapshot = StatsData

/**
 * 算一次统计。
 *
 * 五个 count 并发跑——串行在 SQLite 上也要 5 个来回，
 * 而这是每 15 秒 + 每次连上 WS 都会走的路径。
 */
export async function computeStats(prisma: PrismaClient, now: Date = new Date()): Promise<StatsSnapshot> {
  const [total, today, urgent, topicCount, unread] = await Promise.all([
    prisma.hotItem.count(),
    prisma.hotItem.count({ where: rollingWindowFilter(TODAY_WINDOW_HOURS, now) }),
    // 「紧急」用的是物化列。它由 `importanceOf(heat, flags)` 算出，
    // 零 AI 依赖——所以 AI key 还没配的时候这张卡也是有数的。
    prisma.hotItem.count({ where: { importance: 'urgent' } }),
    // 只数**启用中**的监控词：这张卡回答的是「我现在在盯几个词」。
    // 停用的词仍然在监控词页里可见可编辑，只是不算进这张卡。
    prisma.topic.count({ where: { enabled: true } }),
    prisma.notification.count({ where: { read: false } }),
  ])

  return { total, today, urgent, topicCount, unread }
}

export interface StatsBroadcastHandle {
  stop(): void
  /** 立刻算一次并广播（任务跑完、批量导入之后手动戳一下用） */
  push(): Promise<void>
}

/**
 * 周期性广播统计。
 *
 * **没有客户端时直接跳过**——不过是几个 count，但一个没人看的服务
 * 不该每 15 秒醒一次去查库。
 *
 * 前端拿到之后既不闪烁也不跳动：数字没变时 WS 发的是同样的值，
 * 而 React 对相同数字的重渲染代价是一次浅比较。
 */
export function startStatsBroadcast(deps: {
  prisma: PrismaClient
  /** 广播函数，注入以便测试；默认用 `realtime` 的进程级 `broadcast` */
  broadcast: (type: string, data: unknown) => number
  /** 当前连接数，注入以便测试 */
  clientCount: () => number
  intervalMs?: number
}): StatsBroadcastHandle {
  const intervalMs = deps.intervalMs ?? 15_000
  let stopped = false

  async function push(): Promise<void> {
    if (stopped) return
    try {
      const stats = await computeStats(deps.prisma)
      if (stopped) return
      deps.broadcast('stats', stats)
    } catch {
      // 一次统计失败不该让定时器死掉，也不该把错误抛进 unhandledRejection
    }
  }

  const timer = setInterval(() => {
    if (deps.clientCount() <= 0) return
    void push()
  }, intervalMs)
  // 这个定时器不该吊住进程退出
  timer.unref?.()

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    push,
  }
}
