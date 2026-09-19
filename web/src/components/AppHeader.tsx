import { useEffect, useState } from 'react'
import { Activity, Radar, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { cn } from '../lib/cn.js'
import type { ScanStatus } from '../state/useDashboard.js'
import type { RealtimeState } from '../net/useRealtime.js'
import { Button } from './ui/Button.js'
import { NotificationBell } from './NotificationBell.js'

/**
 * 顶栏：logo + 连接状态 + 心跳 + 立即扫描 + 通知铃铛。
 *
 * 连接状态放在 logo 旁边而不是角落：WS 断线时用户看到的第一个异常
 * 往往是「数据不动了」，把原因放在视线起点能省掉一轮排查。
 *
 * ## 它**自己不吸顶**
 *
 * 上一版这里是 `sticky top-0`。现在吸顶交给了 `App.tsx` 的一层外壳——
 * 因为实时热点条要贴在页头**正下方**并且跟着一起吸顶（见 `LiveTicker`
 * 的注释），而两个各自 `sticky` 的元素需要写死配套的 `top-16` 偏移量，
 * 页头高度一改就会错位。一个外壳管两行，高度是同一个事实。
 */
export function AppHeader({
  scanStatus,
  onScan,
  realtime,
  unread,
  onNotificationsRead,
}: {
  scanStatus: ScanStatus
  onScan: () => void
  realtime: RealtimeState
  unread: number | null
  /** 铃铛里标记已读后回调，让上层重拉一次统计（角标数字来自 `/api/stats`） */
  onNotificationsRead: () => void
}) {
  const running = scanStatus.state === 'running'

  return (
    /*
      `relative z-40` 不是装饰，是修掉一个真 bug。

      `backdrop-blur-xl` 让这个 header 成为一个 `z-index: auto` 的层叠上下文。
      `z-index: auto` 的层叠上下文**按 DOM 顺序绘制**，而实时条是它的下一个
      兄弟、也带 `backdrop-blur`——于是实时条压住了页头。页头里那些
      `absolute z-40` 的下拉（通知面板）被困在页头的层叠上下文里，那个 40
      是相对页头算的，**永远翻不出去**。

      实测的后果不只是被盖住：面板顶部 36px 上的鼠标按下会落到实时条的
      `<a>` 上，于是既关掉了面板、又开始导航到那条热点。

      值取多少不重要，**正数**才重要（正 z-index 的定位元素一定画在
      `auto`/`0` 之后，与 DOM 顺序无关）。不要动外壳那个 `z-30`：它是让整个
      外壳待在下 `ToastStack`（`z-50`）下面的东西。
    */
    <header className="relative z-40 border-b border-white/5 bg-base/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-6">
        {/* logo */}
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-soft shadow-lg shadow-accent/20">
            <Radar className="h-5 w-5 text-white" />
          </span>
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold text-zinc-100">AI 热点雷达</h1>
            <p className="text-[11px] text-zinc-500">实时追踪 · AI 识别真伪</p>
          </div>
        </div>

        <ConnectionChip realtime={realtime} />
        <Heartbeat since={realtime.lastMessageAt} />

        <div className="ml-auto flex items-center gap-2">
          {/* 扫描状态一句话。失败与跳过不自动消失，所以这里可能长期有内容 */}
          {scanStatus.message && (
            <span
              className={cn(
                'hidden text-xs sm:inline',
                scanStatus.state === 'failed' && 'text-urgent',
                scanStatus.state === 'skipped' && 'text-high',
                scanStatus.state === 'done' && 'text-true',
                scanStatus.state === 'running' && 'text-zinc-400',
              )}
            >
              {scanStatus.message}
            </span>
          )}

          <Button
            variant="primary"
            loading={running}
            onClick={onScan}
            icon={<RefreshCw className="h-4 w-4" />}
          >
            {running ? '扫描中' : '立即扫描'}
          </Button>

          <NotificationBell unread={unread} onRead={onNotificationsRead} />
        </div>
      </div>
    </header>
  )
}

/**
 * 连接状态。
 *
 * 只在**不是 open** 时才显眼。连接正常是默认状态，不需要一个常年
 * 发着绿光的图标去报告「一切正常」——那只会稀释真正的异常。
 */
function ConnectionChip({ realtime }: { realtime: RealtimeState }) {
  const open = realtime.status === 'open'

  if (open) {
    return (
      <span
        className="flex items-center gap-1.5 text-[11px] text-zinc-600"
        title={`实时通道已连接${realtime.serverVersion ? ` · 服务端 v${realtime.serverVersion}` : ''}`}
      >
        <Wifi className="h-3.5 w-3.5" />
        <span className="hidden md:inline">实时</span>
      </span>
    )
  }

  const retryIn =
    realtime.nextRetryMs !== null ? ` · ${Math.ceil(realtime.nextRetryMs / 1000)}s 后重连` : ''

  return (
    <span
      className="flex items-center gap-1.5 rounded-md bg-high/10 px-2 py-1 text-[11px] text-high ring-1 ring-high/20"
      title={`实时通道未连接，数据仍在轮询更新${retryIn}`}
    >
      <WifiOff className="h-3.5 w-3.5" />
      {realtime.status === 'connecting' ? '连接中' : `已断开${retryIn}`}
    </span>
  )
}

/**
 * 心跳时钟：距上一条服务端消息多少秒，每秒自己 +1。
 *
 * ## 它数的**不是**「页面刷新了没有」
 *
 * 数的是 `realtime.lastMessageAt`，也就是**上一条服务端业务消息**的时刻。
 * 客户端每 30s 发一次 ping、服务端回一次 pong，但 `useRealtime` 刻意
 * **不为 pong 更新这个 state**（`useRealtime.ts:175`）——否则这个数字会
 * 永远卡在 30s 以内，不管后端实际上有没有动静，变成一个只证明「网线没断」
 * 的装饰品。
 *
 * 所以它反映的是**内容的新鲜度**：一分钟内 = 有东西进来（`accent-soft` 高亮），
 * 五分钟 = 后端确实安静了五分钟。这在「想第一时间发现热点」的语境下
 * 才是有信息量的读数——它和连接状态芯片是两件事，断线时后者会说「已断开」，
 * 而这个数字继续诚实地往上走。
 *
 * ## 为什么单独一个组件
 *
 * 它每秒钟 `setState` 一次。放在 `AppHeader` 里等于每秒重渲染整个页头
 * （连带通知铃铛和它的内部状态）。拆成一个只含一个 `<span>` 的叶子组件，
 * 每秒重渲染的代价就只剩这一个节点。
 *
 * ## 没有动画
 *
 * 只在 <60s 时把颜色换成 `accent-soft`，不加脉冲、不加呼吸。
 * 页面上常驻的动画是有预算的（见方案里的 G1），实时条那条走马灯
 * 才是这个预算该花的地方。
 */
function Heartbeat({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  const active = since !== null

  // 还没有过任何消息时不挂定时器——省掉一个每秒空转的 interval
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  if (since === null) return null

  // 时钟偏差可能让年龄算成负数，夹到 0——不显示「-3s」
  const age = Math.max(0, now - since)
  const label = shortAge(age)

  return (
    <span
      className={cn(
        'flex items-center gap-1 text-[11px]',
        age < 60_000 ? 'text-accent-soft' : 'text-zinc-600',
      )}
      title={`距上一条服务端消息 ${label}（每 30s 的心跳应答不计入）`}
    >
      <Activity className="h-3.5 w-3.5" />
      {label}
    </span>
  )
}

/** `45s` / `12m` / `3h`。短单位是有意的——它在页头只有几十像素的位置 */
function shortAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
