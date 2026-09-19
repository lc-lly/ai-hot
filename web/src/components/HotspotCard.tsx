import {
  ArrowUp,
  Eye,
  Heart,
  MessageCircle,
  Quote,
  Repeat2,
  Sparkles,
  Star,
  TrendingUp,
} from 'lucide-react'
import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import { agoOf, compactNum, hostOf, isFresh, orderedMetrics } from '../lib/format.js'
import { usePointerFine, usePrefersReducedMotion } from '../state/useMediaQuery.js'
import type { ItemDTO } from '../types.js'
import { BorderBeam } from './aceternity/BorderBeam.js'
import { FlagChips, ImportanceBadge, MatchBadge, MetaBadge, TruthBadge } from './ui/Badge.js'
import { GlassCard } from './ui/Card.js'

/**
 * `CardSpotlight` 懒加载。理由同 `StatCards.tsx` 里那段注释：
 * 它是全站仅有的两个 `motion/react` 入口之一，静态 import 会让
 * 45KB gz 的 `motion` 一直留在首屏关键路径上。
 *
 * `BorderBeam` 则**不需要**懒加载——它是纯 CSS 动画，不 import `motion`。
 */
const LazyCardSpotlight = lazy(() =>
  import('./aceternity/CardSpotlight.js').then((m) => ({ default: m.CardSpotlight })),
)

const METRIC_ICON: Record<string, typeof ArrowUp> = {
  'arrow-up': ArrowUp,
  star: Star,
  heart: Heart,
  'message-circle': MessageCircle,
  'repeat-2': Repeat2,
  quote: Quote,
  eye: Eye,
  users: TrendingUp,
}

/**
 * 热点卡片。
 *
 * ## 三种「不知道」，三种不同的渲染方式
 *
 * 这张卡片是整份需求里最容易做错的地方，因为后端有三个字段**可以合法地为空**，
 * 而每一个为空的含义都不是「零」：
 *
 * | 字段 | 为空时的含义 | 错误渲染 | 正确渲染 |
 * |---|---|---|---|
 * | `match` | 还没跑过三层过滤 | 显示「相关度 0%」 | **整个相关度区域不渲染** |
 * | `match.isAbout` | AI 没判「主旨是否是它」 | 显示「间接相关」 | **徽章不渲染** |
 * | `authenticity` | AI 还没评过真伪 | 显示「已核实」 | 显示「未评估」 |
 * | `metrics` 缺某键 | 这个源不提供该指标 | 显示「0」 | **那个指标不渲染** |
 *
 * 把「我们的沉默」渲染成一个具体的值，是本项目最容易犯也最难被发现的错误：
 * 界面上看起来一切正常，只是每一句话都在轻微地撒谎。
 *
 * ## 还有第四种错法：把 A 的理由说成 B 的
 *
 * `match.reasoning` 是**条目级**的真伪理由，不是「为什么和监控词相关」的理由
 * （L1 不产出后者）。它是唯一一个**有值但会被误读**的字段——值本身没错，
 * 错的是我们给它配的标签。理由一律从 `item.reasoning` 读。
 *
 * ## 重要度现在由**卡片结构**表达，不只靠徽章
 *
 * 上一版所有卡片长得一模一样，紧急和次要的差别只有一个 12px 高的徽章。
 * 现在重要度体现在卡片的**物理形态**上：左轨的颜色与有无、底色的极淡晕染、
 * 以及只有紧急卡才有的流光（`BorderBeam`）。徽章退回去只负责给文字标签。
 *
 * ## 入场动画：**没有**
 *
 * 上一版每张卡挂 `animate-fade-up` + `index * 30ms` 的延迟（封顶 12 张，
 * 即最多 360ms）。对一个「想第一时间发现热点」的人来说，这是把页面做慢了：
 * 内容明明已经到了，却还在慢慢浮现。
 *
 * 现在卡片**立即出现**。加载中的骨架屏已经提供了「正在取数」的反馈，
 * 内容到达后再叠一层入场动画，是没有信息量的装饰。翻页同理——
 * 立即换掉比淡入更符合「我在快速扫」的使用状态。
 */
export function HotspotCard({ item, variant = 'full' }: { item: ItemDTO; variant?: 'full' | 'light' }) {
  const metrics = orderedMetrics(item.metrics)
  const host = hostOf(item.url)
  const published = item.publishedAt ?? item.fetchedAt
  const time = agoOf(published)
  // 时间戳是不是要「响」一点。见 `isFresh` 的注释：判据是发布时刻。
  const fresh = isFresh(published)
  const urgent = item.importance === 'urgent'

  if (variant === 'light') {
    return (
      <GlassCard hover tone={item.importance} className="p-3.5">
        <div className="flex items-center gap-2">
          <ImportanceBadge value={item.importance} />
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200 hover:text-accent-soft"
          >
            {item.title}
          </a>
          <TimeStamp time={time} fresh={fresh} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>{item.source?.name ?? host}</span>
          {metrics.slice(0, 3).map((m) => (
            <Metric key={m.key} icon={m.icon} label={m.label} value={m.value} />
          ))}
        </div>
      </GlassCard>
    )
  }

  return (
    <SpotlightShell>
      <GlassCard hover tone={item.importance} className="p-5">
        {/* 只有紧急卡跑光。全都在跑 = 没有一张在跑 */}
        {urgent && <BorderBeam duration={9} colorFrom="#f43f5e" colorTo="#f59e0b" />}

        {/* 徽章行 */}
        <div className="flex flex-wrap items-center gap-2">
          <ImportanceBadge value={item.importance} />
          <TruthBadge authenticity={item.authenticity} flags={item.flags} />
          <MatchBadge match={item.match} />
          <FlagChips flags={item.flags} />
          <MetaBadge>{item.domain}</MetaBadge>

          <TimeStamp time={time} fresh={fresh} className="ml-auto" />
        </div>

        {/* 标题 */}
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(
            'mt-3 block text-base leading-snug font-semibold text-zinc-100 transition-colors hover:text-accent-soft',
            // 紧急卡标题用 Space Grotesk 并加大字号差，让它在整列里「跳出来」。
            // 只加粗、只换颜色都不够——扫视时先被感知的是**尺寸**。
            urgent && 'font-display text-[17px]',
          )}
        >
          {item.title}
        </a>

        {/* 摘要 */}
        {item.summary && (
          <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-zinc-400">{item.summary}</p>
        )}

        {/*
          AI 的判定理由。两条规矩，缺一不可。

          **一、只在 `aiState === 'done'` 时渲染。**
          `reasoning` 这个字段在不同状态下装的是不同的东西：`done` 时是 AI 写的
          判定理由，`skipped` 时装的是**机器给的原因**（「未命中任何关键词」
          「重复条目: h:…」），`failed` 时装的是错误信息。不加这个判断的话，
          九成卡片上会挂着一行带星标的「AI 判定理由 · 未命中任何关键词」——
          那是 L0 正则挡住它时写下的，压根没有 AI 参与过。

          **二、读条目级字段 `item.reasoning`，不是 `match.reasoning`。**
          后端把 `Match.reasoning` 明确标成「条目级；与关键词无关」（见
          `server/src/triage/index.ts` 的 `MatchDraft`）——L1 只产出每个关键词的
          `relevance` 与 `isAbout`，**不产出理由**，所以写 Match 时只能借用 L2 的
          真伪理由。这里曾读 `match.reasoning` 并冠以「关于「监控词」·」，
          于是「仅标题无正文，链接非 HN 官方域名」被显示成**它和监控词相关的
          理由**——答的是「这条内容真不真」，被读成「这条为什么和 AI 编程有关」。
        */}
        {item.aiState === 'done' && item.reasoning && (
          <div className="mt-3 flex gap-2 rounded-lg bg-white/[0.03] p-2.5 text-xs leading-relaxed text-zinc-400 ring-1 ring-white/5">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent/70" />
            <span>
              <span className="text-zinc-500">AI 判定理由 · </span>
              {item.reasoning}
            </span>
          </div>
        )}

        {/* 底栏：互动数 + 来源 + 相关度 */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500">
          {item.author && <span className="truncate">{item.author}</span>}

          {metrics.map((m) => (
            <Metric key={m.key} icon={m.icon} label={m.label} value={m.value} />
          ))}

          {/* 互动数据一个都没有时（rss 类源），至少把域名说清楚 */}
          {metrics.length === 0 && item.author === null && <span>{host}</span>}

          <span className="ml-auto flex items-center gap-3">
            <span className="text-zinc-600">{item.source?.name ?? host}</span>

            {/*
              相关度。**0..1 存、×100 显示。**
              `relevance === null`（或整个 match 为 null）时整块不渲染——
              显示 0% 会被读成「AI 认真评估后认为无关」，
              而事实是「根本没评估」。
            */}
            {item.match?.relevance !== null && item.match?.relevance !== undefined && (
              <span className="flex items-center gap-1.5">
                <span className="text-zinc-600">相关度</span>
                <span className="tabular font-medium text-accent-soft">
                  {(item.match.relevance * 100).toFixed(0)}%
                </span>
              </span>
            )}
          </span>
        </div>
      </GlassCard>
    </SpotlightShell>
  )
}

/**
 * 动效门。它决定两件事，一件是策略、一件是省钱。
 *
 * **策略。** 触屏没有 hover 语义，`prefers-reduced-motion` 的用户明确要求
 * 别动。这两种情况下 `CardSpotlight` 本来就不会画出任何东西——它内部
 * 对 reduced-motion 会直接返回一个不含高光层的空壳，而对触屏设备来说
 * 那个高光层永远等不到鼠标。所以跳过它**不损失任何视觉**。
 *
 * **省钱。** 这才是把它拦在这里而不是拦在 `CardSpotlight` 里面的原因。
 * 组件内部的判断只拦得住「画不画」，拦不住「下不下载」：只要
 * `<LazyCardSpotlight>` 被渲染，`import()` 就会发出去，45KB gz 照下不误，
 * 而这两种用户一个字节都用不上。拦在这里，触屏和 reduced-motion 用户
 * **完全不下载 `motion`**。
 *
 * ## 降级和兜底渲染的是同一个盒子
 *
 * 三处（跳过、Suspense fallback、真正挂载）的根元素都是同一个
 * `<div class="relative">`——它就是 `CardSpotlight` 自己的根（外加一个
 * `group/spotlight`，只影响后代选择器）。所以动效迟到或不来，
 * 布局都**完全一致**，不会抖一下。
 */
function SpotlightShell({ children }: { children: ReactNode }) {
  const pointerFine = usePointerFine()
  const reducedMotion = usePrefersReducedMotion()

  if (!pointerFine || reducedMotion) return <div className="relative">{children}</div>

  return (
    <Suspense fallback={<div className="relative">{children}</div>}>
      <LazyCardSpotlight>{children}</LazyCardSpotlight>
    </Suspense>
  )
}

/**
 * 时间戳。**一小时内的时间会「响」。**
 *
 * 「想第一时间发现热点」这个诉求，落到卡片上就是：**多久之前发生**应该是
 * 全卡片最容易被扫到的信息之一，而现在它和「相关度」「来源」一样是灰色的
 * 小字。一小时内给天色 + 一个脉冲点，一小时外保持安静——
 * 如果所有时间都很响，就没有时间会响。
 */
function TimeStamp({ time, fresh, className }: { time: string; fresh: boolean; className?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-xs', className)}>
      {fresh && (
        <span aria-hidden="true" className="animate-pulse-ring relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-accent" />
        </span>
      )}
      <span className={fresh ? 'font-medium text-accent-soft' : 'text-zinc-500'}>{time}</span>
    </span>
  )
}

function Metric({ icon, label, value }: { icon: string; label: string; value: number }) {
  const Icon = METRIC_ICON[icon] ?? ArrowUp
  return (
    <span className="flex items-center gap-1" title={label}>
      <Icon className="h-3.5 w-3.5" />
      <span className="tabular">{compactNum(value)}</span>
    </span>
  )
}

/**
 * 卡片骨架。形状对齐上面的完整版，用在首屏加载。
 * 单独导出是因为搜索结果页要用轻量版的骨架。
 *
 * `index` 的错峰延迟**去掉了**：骨架屏是一闪而过的占位，
 * 让它按 40ms 递增依次浮现，只会让「正在加载」看起来比实际更久。
 */
export function CardSkeletonRow() {
  return (
    <GlassCard className="animate-pulse p-5">
      <div className="flex gap-2">
        <span className="h-5 w-12 rounded-md bg-white/5" />
        <span className="h-5 w-16 rounded-md bg-white/5" />
        <span className="h-5 w-14 rounded-md bg-white/5" />
      </div>
      <span className="mt-3 block h-5 w-3/4 rounded-md bg-white/5" />
      <span className="mt-2.5 block h-4 w-full rounded-md bg-white/5" />
      <span className="mt-1.5 block h-4 w-2/3 rounded-md bg-white/5" />
      <div className="mt-4 flex gap-4">
        <span className="h-3.5 w-16 rounded-md bg-white/5" />
        <span className="h-3.5 w-12 rounded-md bg-white/5" />
      </div>
    </GlassCard>
  )
}
