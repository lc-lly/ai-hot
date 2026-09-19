import { AlertTriangle, Hash, Layers, TrendingUp } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { cn } from '../lib/cn.js'
import { groupNum } from '../lib/format.js'
import { usePrefersReducedMotion } from '../state/useMediaQuery.js'
import { GlassCard } from './ui/Card.js'
import { Skeleton } from './ui/Empty.js'
import type { StatsDTO } from '../types.js'

/**
 * `NumberTicker` **必须**懒加载，否则前面所有分包工作都是白做的。
 *
 * 它是全站仅有的两个 `motion/react` 入口之一（另一个是 `CardSpotlight`）。
 * 只要这里写成静态 import，`motion`（45KB gz）就仍然躺在首屏关键路径上——
 * `vite.config.ts` 里那个 `manualChunks` 只是把它切成**单独一个文件**，
 * 并没有让它**晚点下载**。切割和延迟是两件事，只有 `import()` 才做第二件。
 *
 * 数字是页面上最先该被看见的东西之一，所以「晚点出」听起来像是反的。
 * 但这里晚的只是**滚动动画**，不是数字本身：下面的 fallback 渲染的
 * 就是同一个数字、同一套 class。用户看到的是「数字直接在」，然后
 * 值变化时它才会滚——而这本来就是 `NumberTicker` 的既定行为
 * （见 `NumberTicker.tsx`：只有值真的变了才动）。
 */
const LazyNumberTicker = lazy(() =>
  import('./aceternity/NumberTicker.js').then((m) => ({ default: m.NumberTicker })),
)

/**
 * 数字本身的排版。降级、fallback、`NumberTicker` 三处共用，必须完全一致
 * ——否则数字会在 chunk 到达、或用户切换系统设置的那一刻跳一下。
 *
 * `block` 不能删：这三处渲染的都是 `<span>`，而行内元素上的 `mt-*` 不生效，
 * 去掉就会贴到上面的标签上。
 */
const NUM_CLASS = 'mt-1 block text-2xl leading-none font-semibold'

/**
 * 统计卡的数字。
 *
 * ## reduced-motion 下**连 chunk 都不下**
 *
 * `NumberTicker` 内部对 reduced-motion 的处理是「完全不动，直接显示最终值」。
 * 也就是说这类用户在 `motion` 里用到的功能是**零**——但只在组件内部判断的话，
 * `import()` 早就发出去了，45KB gz 照下不误。
 *
 * 判断挪到这里（`usePrefersReducedMotion` 走的是自己那份 `matchMedia` 订阅，
 * 不 import `motion`），这类用户就一个字节都不下载。
 *
 * ## 触屏**不拦**
 *
 * 这和 `HotspotCard` 的 `SpotlightShell` 不一样，是刻意的：数字滚动对触屏
 * 用户是**有效果的**（值变化时数字会跳），而对 reduced-motion 用户是空的。
 * 拦与不拦的分界是「这个用户到底用不用得上」，不是「他是不是移动端」。
 */
function StatValue({ value, tone }: { value: number; tone: string }) {
  const reducedMotion = usePrefersReducedMotion()
  const degraded = <span className={cn('font-display tabular', NUM_CLASS, tone)}>{groupNum(value)}</span>

  if (reducedMotion) return degraded

  return (
    <Suspense fallback={degraded}>
      <LazyNumberTicker value={value} className={cn(NUM_CLASS, tone)} />
    </Suspense>
  )
}

/**
 * 四张统计卡：总热点 / 近 24 小时 / 紧急热点 / 监控词。
 *
 * ## 两张「总数」卡片的语义必须分清
 *
 * 这里的 `total` 是**全库**，永远不受筛选影响；
 * 热点流下面的分页文案用的 `pagination.total` 是**筛选后**的条数。
 * 混用会让用户看到「统计卡说 62 条，下面写着共 20 条」——
 * 看起来像 bug，实际上是两个不同的数。
 *
 * ## 为什么「今日」写成「近 24 小时」
 *
 * 后端用的是滚动窗口而不是「今天 00:00」（理由见 `server/src/window.ts`：
 * SQLite 存 UTC，跨时区时「今天」没有确定含义）。文案必须与实现一致，
 * 否则用户会在午夜前后发现数字对不上。
 *
 * ## 四张卡里**只有一张有颜色**
 *
 * 上一版这四张各配了一个色：中性 / 青 / 玫红 / 天蓝，加上每张顶上那团
 * `blur-2xl` 的彩光，四个数字四个颜色。那正好抵消了「饱和度只留给重要度」
 * 这条规则——满屏都在发光的时候，`紧急热点` 就不亮眼了。
 *
 * 现在：**只有「紧急热点」拿重要度色（`--color-urgent`），其余三张中性灰。**
 * 于是这一行的视觉重心自然落在唯一需要马上行动的数字上，
 * 扫一眼就知道「今天有没有值得立刻发的东西」。
 *
 * ## 这个数字会「跳」
 *
 * 四个数走 `NumberTicker`。它不是进页面时从 0 滚一遍——那是把「没变化」
 * 演成「有变化」（理由见 `NumberTicker.tsx` 的注释）。**只有值真的变了才滚**，
 * 所以数字的跳动本身就是一个信号：「紧急热点刚刚 +1」。
 */
export function StatCards({ stats }: { stats: StatsDTO | null }) {
  /**
   * 入场动画**只放一次，放完就把 class 摘掉**。
   *
   * 上一版这四张卡一直挂着 `animate-fade-up`，于是每次从别的 Tab 切回
   * 热点雷达，四张卡都从 `opacity:0 / translateY(12px)` 重新浮上来一遍
   * ——看起来就是「页面在抖」。
   *
   * 这里踩到的坑是：**光把条件渲染改成 `hidden` 不管用**。切回来时
   * 元素从 `display:none` 变成有盒子，Chrome 会把它身上的 CSS 动画
   * **从头重跑**，动画仍然每次都播。所以必须让 class 本身消失：
   * 只留最初那一次，之后元素上没有任何动画可重播。
   *
   * 摘掉 class 不会有视觉变化：`fade-up` 的 `fill-mode` 是 `both`，
   * 结束状态就是元素的自然状态（`opacity:1`、无位移）。
   *
   * 700ms = 最后一张卡的 120ms 错峰延迟 + 400ms 时长，再留一点余量。
   * 用定时器而不是 `onAnimationEnd`：事件会冒泡到 `GlassCard` 的根节点上，
   * 而它不接这个 prop；在四张卡上各挂一次又要在回调里数到第四张才算完。
   *
   * **这条依赖「雷达页常驻挂载」**（见 `App.tsx`）：组件一旦重新挂载，
   * `entrance` 就回到 `true`，动画会再放一遍。
   */
  const [entrance, setEntrance] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setEntrance(false), 700)
    return () => clearTimeout(t)
  }, [])

  /**
   * 中性那张卡的色调。三张中性卡共用，避免三份字面量各写一遍之后又漂移。
   */
  const NEUTRAL = { tone: 'text-zinc-300', ring: 'from-zinc-400/20' } as const

  const cards = [
    {
      key: 'total',
      label: '总热点',
      value: stats?.total,
      icon: Layers,
      ...NEUTRAL,
      hint: '库里累计抓到的条目',
    },
    {
      key: 'today',
      label: '近 24 小时',
      value: stats?.today,
      icon: TrendingUp,
      ...NEUTRAL,
      hint: '滚动 24 小时窗口内新增',
    },
    {
      key: 'urgent',
      label: '紧急热点',
      value: stats?.urgent,
      icon: AlertTriangle,
      // 唯一的信号色。见上方注释。
      tone: 'text-urgent',
      ring: 'from-urgent/20',
      hint: '热度高且没有可疑标记',
    },
    {
      key: 'topicCount',
      label: '监控词',
      value: stats?.topicCount,
      icon: Hash,
      ...NEUTRAL,
      hint: '启用中的监控词数量',
    },
  ]

  /*
   * 这一行比下面的内容卡**多一层自上而下的渐变**（`from-accent/[0.12]`）。
   *
   * 为什么只有这四张：它们是**大而空**的。热点流里的卡片密密麻麻挤着
   * 徽章、标题、摘要、底栏，卡面本身几乎看不见；统计卡一张上只有两个
   * 字符加一个图标，整块卡面是完全裸露的。同样一个 `#1b1b1f`，在密集处
   * 读起来是「一块底」，在空旷处读起来就是「一块黑」——用户说的
   * 「背景太黑、不协调」说的正是后者。
   *
   * ## 色相取自热点卡的 hover 高光
   *
   * 渐变走品牌青 `--color-accent`，和 `CardSpotlight` 那层跟随鼠标的
   * 径向高光（`rgba(6, 182, 212, 0.08)`）同色——页面上「卡面被照亮」
   * 这件事此前只有那一个出处，这里复用同一个色，两处才读起来是一套。
   *
   * 上一版这里写的是纯白渐变（`from-white/[0.055]`），理由是「只加光、
   * 不引入色相，以免破坏『饱和度只留给重要度』」。这条推理对了一半：
   * 5.5% 的白在 `#1b1b1f` 上根本读不出「被照亮」，只读得出「这块黑得
   * 不那么均匀」——用户看到的仍然是黑。而青是**全站通用色**（页头、
   * Tab、相关度、按钮都在用），不是重要度信号色；真正不能碰的是
   * `urgent` 那支玫红，它在这四张卡里仍然只属于「紧急热点」一张。
   *
   * 中段 `via-accent/[0.04]` 是为了让衰减更早、更匀：只有首尾两站的话，
   * 上半张卡亮、下半张卡是硬切。`to-accent/0` 而不是 `to-transparent`：
   * 后者的终点是 `#0000`，中间会经过一段发灰的过渡（旧浏览器尤其明显）。
   */
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c, i) => (
        <GlassCard
          key={c.key}
          className={cn(
            'overflow-hidden bg-gradient-to-b from-accent/[0.24] via-accent/[0.08] to-accent/0 p-4',
            entrance && 'animate-fade-up',
          )}
          // 依次入场，制造一点节奏；40ms 的间隔刚好能看出先后又不拖沓
          style={entrance ? { animationDelay: `${i * 40}ms` } : undefined}
        >
          <div
            aria-hidden
            className={cn('absolute inset-x-0 -top-16 h-24 bg-gradient-to-b to-transparent blur-2xl', c.ring)}
          />
          <div className="relative flex items-start justify-between">
            <div className="min-w-0">
              <p className="text-xs text-zinc-500" title={c.hint}>
                {c.label}
              </p>
              {c.value === undefined ? (
                <Skeleton className="mt-2 h-7 w-14" />
              ) : (
                <StatValue value={c.value} tone={c.tone} />
              )}
            </div>
            <c.icon className={cn('h-4 w-4 shrink-0', c.tone)} />
          </div>
        </GlassCard>
      ))}
    </div>
  )
}
