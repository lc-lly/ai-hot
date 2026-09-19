import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn.js'

/**
 * Aceternity UI `BorderBeam` —— 沿元素周界跑一圈的光点。
 *
 * 来源：https://ui.aceternity.com/components/border-beam
 *
 * 改动：
 * - `after:animate-border-beam`（依赖 tailwind.config 里的 `animation` 键，
 *   v4 没有那个配置）改成任意值形式的 `animation` 简写，**顺带让 `duration`
 *   逐实例可配**——紧急卡上的流光要比按钮上的慢，快了像故障。
 * - 去掉 v3 语法的 `!` 前缀（v4 的 important 是后缀且这里并不需要）。
 *
 * ## 它为什么值得用
 *
 * 这是一束**沿边框运动**的光，而不是整块发光。区别很重要：整块发光是
 * 「这张卡很重要」，沿边框流动是「这条**正在**发生」。对「想第一时间
 * 发现热点」这个诉求，后者才是对的语言。
 *
 * 全站只有紧急卡挂它——如果每张卡都在跑光，等于没有一张在跑。
 *
 * ## 降级
 *
 * 纯 CSS 动画。`prefers-reduced-motion` 的全局规则会把时长压到 0.01ms
 * 并只跑一次，光点直接落到 `offset-distance: 100%` 即终点，表现为**不可见**。
 * 这正是期望结果，不需要额外的 JS 判断。
 */
export function BorderBeam({
  className,
  size = 180,
  duration = 8,
  anchor = 90,
  borderWidth = 1,
  colorFrom = '#f43f5e',
  colorTo = '#f59e0b',
  delay = 0,
}: {
  className?: string
  /** 光点自身的尺寸（px）。同时决定 `offset-path` 的圆角半径 */
  size?: number
  /** 跑完一圈的秒数 */
  duration?: number
  /** 光点在路径上的锚点（百分比） */
  anchor?: number
  borderWidth?: number
  colorFrom?: string
  colorTo?: string
  /** 负延迟，用来错开同屏多个光束的相位 */
  delay?: number
}) {
  return (
    <div
      aria-hidden="true"
      style={
        {
          '--size': size,
          '--duration': duration,
          '--anchor': anchor,
          '--border-width': borderWidth,
          '--color-from': colorFrom,
          '--color-to': colorTo,
          '--delay': `-${delay}s`,
        } as CSSProperties
      }
      className={cn(
        // 边框本身是透明的，只用来「挖出」一圈可以显示渐变的区域
        'pointer-events-none absolute inset-0 rounded-[inherit] [border:calc(var(--border-width)*1px)_solid_transparent]',
        /*
         * 两层 mask 相交：只保留边框那一圈，内部被裁掉。
         *
         * **这里必须是 `mask-image` 长写，不能写 `mask` 简写。**
         *
         * `mask` 是简写属性，它会把 `mask-composite` / `mask-clip` 一起**重置
         * 回初始值**。而 Tailwind 对 arbitrary property（`[a:b]`）之间的先后
         * 顺序**不作任何保证**——实测产物里 `[mask:…]` 被排在
         * `[mask-composite:intersect]` **之后 13.7KB**，两者选择器权重又相同
         * （都是单类），于是后面的简写赢，`mask-composite` 被重置成 `add`。
         *
         * 结果不是「效果差一点」，是**遮罩彻底失效**：两层从「相交」变成
         * 「并集」，等于整块不透明，那个 180px 的渐变方块会原样露在卡片上，
         * 糊住大约四成卡面。而计算样式里 `animation-name` / 渐变 / 时长
         * 全都报「正常」——只有真的看图才发现得了。
         *
         * 长写之间互不干扰，顺序就无所谓了。
         */
        '[mask-image:linear-gradient(transparent,transparent),linear-gradient(white,white)] [mask-clip:padding-box,border-box] [mask-composite:intersect]',
        // 光点：一个方形元素沿圆角矩形路径移动，经过之处点亮边框
        'after:absolute after:aspect-square after:w-[calc(var(--size)*1px)]',
        'after:[animation:border-beam_calc(var(--duration)*1s)_infinite_linear] after:[animation-delay:var(--delay)]',
        'after:[background:linear-gradient(to_left,var(--color-from),var(--color-to),transparent)]',
        'after:[offset-anchor:calc(var(--anchor)*1%)_50%]',
        'after:[offset-path:rect(0_auto_auto_0_round_calc(var(--size)*1px))]',
        className,
      )}
    />
  )
}
