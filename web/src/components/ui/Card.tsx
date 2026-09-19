import type { CSSProperties, ReactNode } from 'react'
import { cn } from '../../lib/cn.js'
import type { Importance } from '../../types.js'

/**
 * 面板。全站只有这一种卡片底。
 *
 * `hover` 只在**真的是可点的时候**才开——一张不可点的卡片却在悬停时
 * 浮起、边框发亮，会让人以为点了会有反应，是明确的可用性谎言。
 *
 * ## 底色从玻璃改成实底
 *
 * 上一版用 `.glass`（半透明白 + `backdrop-filter: blur(8px)`）。模糊滤镜
 * 每个元素都要独立合成一层，一页 20 张卡就是 20 次；而且半透明会透出
 * 背景的光斑，卡片边缘发脏。现在用 `.panel` 实底，零合成成本。
 * 玻璃仍留给页头、实时条这类真正「浮在内容之上」的少数元素。
 *
 * ## 配色规则（贯穿全站）
 *
 * - **中性灰**走 Tailwind 的 `zinc` 阶。它和 `--color-base` 是同一族的中性色，
 *   用它不会引入色偏，也不需要为每一档灰再造一个 token。
 * - **语义色**一律走 token（`urgent` / `high` / `medium` / `accent` / `true` / `fake`），
 *   绝不写 `rose-300` 这类色阶名——上一版就是那么写的，结果同一套含义
 *   在 `styles.css` 和组件里各存了一份，改一处另一处必然漂移。
 */

export type CardTone = Importance | 'plain'

/**
 * **全站的默认卡面。** 除了 `urgent` / `high`（它们有自己的晕），
 * 每一档都挂这一条。
 *
 * ## 为什么卡片需要一层青
 *
 * 它们原先什么背景都没有，只拿到 `.panel` 那一层 `--color-elevated`
 * （`#1b1b1f`）。在密集的雷达列表里那是「一块底」，但一屏 20 张**同样**
 * 的黑块连成一片，整页就读成了「黑底上用灰线画的框」——用户的原话是
 * 「背景色是黑的，我觉得不好看」。它先是报了热点流，接着又报了监控词卡
 * ——**这不是某一档的问题，是所有卡共有的问题**，所以修在共有的这一层。
 *
 * 色相、走向、`to-accent/0` 的收尾都跟统计卡（`StatCards.tsx`）同源，
 * 只有**浓度**不同：统计卡是 `from-accent/[0.24]`（一张卡上只有两个字符
 * 加一个图标，卡面完全裸露，淡了读不出来），这里减到一半以下
 * （卡片密集，每条都浓就糊成一片青）。
 *
 * ## 为什么这不违反「饱和度只留给重要度」
 *
 * 因为它用的是 `accent`（青），而 accent 是**全站通用色**——页头、Tab、
 * 焦点环、链接、相关度都在用——它表达的是「可交互 / 这是本应用的一部分」，
 * 不是「这条有多重要」。真正的信号色（`urgent` 玫红、`high` 琥珀）仍然
 * 只属于那两档：其余卡片拿到的是**所有卡片共有的底色**，而不是一个
 * **只有它有的标记**。这是「多一档就能盖过紧急卡」和「大家都有就等于
 * 没有」的分界。
 *
 * ## `surface` 而不是 `wash`
 *
 * `wash` 会被渲染成一个 `absolute inset-0` 的**覆盖层**，压在文字上；
 * 那是给 `urgent` / `high` 的纯色晕用的（7% 的平铺，压不压看不出差别）。
 * 渐变有方向，压在文字上会让上半张的字也偏青。所以这里走 `surface`：
 * 直接进根节点的 `className`，成为**卡片自己的 `background-image`**，
 * 自然落在内容下面。
 *
 * 它和 `.panel` 的 `background-color` 不打架：两者是不同的属性，
 * 渐变画在底色之上，末端 `to-accent/0` 又把下半张还给 `.panel`。
 *
 * 导出是因为下拉面板（`ui/Field.tsx` 的 `Select`）也要它——那个浮层
 * 原来是纯 `.panel`，一块孤零零的黑。**必须是同一份常量**：抄一遍的话，
 * 以后调卡片浓度就只调得动卡片，下拉框会悄悄停在旧值上。
 */
export const CARD_SURFACE = 'bg-gradient-to-b from-accent/[0.11] via-accent/[0.035] to-accent/0'

/**
 * 卡面那一圈边框。和上面的渐变是一套，见 `CARD_SURFACE`。
 *
 * `medium` 曾经短暂地用过 `border-medium/20`（天蓝），后来被撤掉了，
 * 理由写的是「一圈孤零零的亮线让普通卡比紧急卡还显眼」——**那条推理是对的，
 * 但它证的是「孤零零」有错，不是「有色」有错**。当时 `medium` 没有底色晕，
 * 全身唯一的彩色就落在轮廓上，而轮廓是卡片上最长的那个形状，于是它比有轨、
 * 有晕、有流光的紧急卡还响。
 *
 * 现在两种颜色是**一起**来的：有底就有边，边框只是这块青色卡面收口的地方，
 * 读起来是「卡片的边界」而不是「卡片在发光」。浓度也刻意压到 15%——比
 * `.panel` 的 `white/6%` 只高一点，够把边界说清楚，不够跟 `urgent` 的
 * `border-urgent/30` 抢。
 */
const CARD_BORDER = 'border-accent/15'
const CARD_HOVER_BORDER = 'hover:border-accent/35'

/**
 * 重要度的视觉分级。
 *
 * 关键判断：**low 档没有左轨、没有底色晕**。四档不是四个颜色，是
 * 「有信号 / 没信号」——给每一档都上色，等于每一档都不突出。
 *
 * `medium` 只有一条细轨、没有底色晕，所以它比 `high` 安静但仍有痕迹；
 * `low` 连轨都没有。**这两档的区别只有那条 2px 左轨**——所以它们的
 * `surface` / `border` / `hoverBorder` 三项**必须逐字相同**（所以抽成
 * 上面几个常量而不是各写一遍）：一旦哪一项不同，「等级只由轨道表达」
 * 这条规则就被悄悄破坏了，而破坏的表现只是「次要卡好像比普通卡淡一点」，
 * 没人会当 bug 报。
 *
 * `urgent` / `high` 的 `surface` 是空的、改用 `wash`——它们的卡面要表达
 * 「这一条有情况」，那层纯色晕和左轨、边框是同一个信号的三个面，
 * 不该再叠一层中性的青。
 */
const TONE: Record<
  CardTone,
  { rail: string | null; surface: string; wash: string; border: string; hoverBorder: string }
> = {
  urgent: {
    rail: 'var(--color-urgent)',
    surface: '',
    wash: 'bg-urgent/[0.07]',
    border: 'border-urgent/30',
    hoverBorder: 'hover:border-urgent/50',
  },
  high: {
    rail: 'var(--color-high)',
    surface: '',
    wash: 'bg-high/[0.05]',
    border: 'border-high/25',
    hoverBorder: 'hover:border-high/45',
  },
  medium: {
    rail: 'var(--color-medium)',
    surface: CARD_SURFACE,
    wash: '',
    border: CARD_BORDER,
    hoverBorder: CARD_HOVER_BORDER,
  },
  low: {
    rail: null,
    surface: CARD_SURFACE,
    wash: '',
    border: CARD_BORDER,
    hoverBorder: CARD_HOVER_BORDER,
  },
  /**
   * 不属于任何重要度档的普通面板——**也就是全站的默认卡面**：筛选栏、
   * 监控词卡、搜索表单、骨架屏、统计卡都落在这一档。
   *
   * 统计卡要在默认渐变**之上**再浓一倍，那个更浓的值写在它自己的调用处
   * （`StatCards.tsx` 的 `className`）。两处都写 `from-accent/*` 不会打架：
   * `cn` 里的 twMerge 按**属性组**去重，同组只留最后一个，而 `className`
   * 永远排在最后——调用处赢。
   *
   * （上一版这里写的是「两处都写会撞成同一个 `--tw-gradient-from`，谁赢
   * 取决于 CSS 生成顺序」——那个顾虑只在两个类**都留在 class 列表里**时
   * 才成立，而它们根本到不了那一步。已用 `twMerge` 实测核对过。）
   */
  plain: {
    rail: null,
    surface: CARD_SURFACE,
    wash: '',
    border: CARD_BORDER,
    hoverBorder: CARD_HOVER_BORDER,
  },
}

export function GlassCard({
  children,
  className,
  style,
  hover = false,
  glow = false,
  tone = 'plain',
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
  hover?: boolean
  /** 顶部一道青渐变高光。留给「当前选中」这类需要突出的卡片 */
  glow?: boolean
  /** 重要度分级。决定左轨颜色与底色晕，见 `TONE` */
  tone?: CardTone
}) {
  const t = TONE[tone]
  // `--rail` 由 `.signal-rail::before` 读取。用内联变量而不是生成
  // `before:bg-urgent` 这种动态类名——Tailwind 的类名是静态扫描出来的，
  // 拼出来的字符串它扫不到，会在生产构建里静默丢失。
  const merged: CSSProperties = t.rail === null ? { ...style } : { ...style, ['--rail' as string]: t.rail }

  return (
    <div
      style={merged}
      className={cn(
        'panel relative overflow-hidden rounded-2xl transition-colors duration-200',
        t.rail !== null && 'signal-rail',
        t.surface,
        t.border,
        hover && t.hoverBorder,
        className,
      )}
    >
      {t.wash !== '' && (
        <span aria-hidden="true" className={cn('pointer-events-none absolute inset-0', t.wash)} />
      )}
      {glow && (
        <span
          aria-hidden="true"
          className="absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-accent to-transparent"
        />
      )}
      {children}
    </div>
  )
}

/** 区块标题。左侧一道短渐变竖条 + 标题 + 可选右侧操作。 */
export function SectionTitle({
  children,
  right,
  className,
}: {
  children: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <h2 className="font-display flex items-center gap-2.5 text-base font-semibold text-zinc-100">
        <span
          aria-hidden="true"
          className="h-4 w-1 rounded-full bg-gradient-to-b from-accent to-accent-soft"
        />
        {children}
      </h2>
      {right}
    </div>
  )
}
