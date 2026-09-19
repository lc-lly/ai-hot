import { useMotionValue, useReducedMotion, useSpring } from 'motion/react'
import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn.js'
import { groupNum } from '../../lib/format.js'

/**
 * Aceternity UI `NumberTicker` 的改造版 —— 数字变化时滚动到新值。
 *
 * 来源：https://ui.aceternity.com/components/number-ticker
 * 机制沿用官方（`useSpring` 驱动 `motionValue`，在 `change` 回调里写
 * `textContent`，全程不触发 React 重渲染）。**触发时机改了两处**，都是为了
 * 修一个会静默出错的缺陷：
 *
 * ## 缺陷一：动画没跑的时候，数字是**空的**
 *
 * 官方实现的 `<span>` **没有子节点**：
 *
 * ```tsx
 * return <span ref={ref} className={...} />   // 里面什么都没有
 * ```
 *
 * 数字**只**在 `springValue.on("change")` 回调里被写进去。于是只要动画没跑
 * ——元素不在视口（`useInView` 没触发）、`prefers-reduced-motion`、或者
 * 时序上回调没来——用户看到的就是一个**空白**。
 *
 * 在一个「宁可显示『未评估』也不显示假的 0」的项目里，空白比错数字更糟：
 * 它既不是数据也不是「没有数据」，是一个看起来像渲染失败的洞。
 *
 * **修法**：把真实值作为 `children` 渲染出来，动画只是**覆盖**它。
 * 任何情况下首帧都已经是正确的数字。
 *
 * ## 缺陷二：从 0 滚上来，会让「没变」看起来像「变了」
 *
 * 官方在挂载时从 0 滚到目标值。但统计卡在页面顶部、挂载即在视口内，
 * 于是每次刷新页面、每次切 Tab 回来，四个数字都从 0 滚一遍——
 * 而它们**根本没有变化**。在一个要「第一时间发现热点」的界面上，
 * 把没有变化演成变化，正好稀释掉真正的变化。
 *
 * **修法**：只有 `value` **真的变了**才滚动。这样数字跳动是一个**信号**
 * ——「紧急热点刚刚 +1」——而不是每次进页面都要看一遍的开场动画。
 *
 * ## 降级
 *
 * `prefers-reduced-motion` 下完全不动，直接显示最终值。
 * 这条必须由 JS 判断：全局那条 CSS `!important` 拦不住 motion 的逐帧写入。
 */
export function NumberTicker({
  value,
  className,
  /** 千分位等格式化。默认 `lib/format.ts` 的 `groupNum` */
  format = groupNum,
}: {
  value: number
  className?: string
  format?: (n: number) => string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const prefersReduced = useReducedMotion()

  // 初值就是真实值——首帧不会闪 0，也不会空
  const motionValue = useMotionValue(value)
  const spring = useSpring(motionValue, { damping: 40, stiffness: 110 })
  const formatRef = useRef(format)
  formatRef.current = format

  useEffect(() => {
    if (prefersReduced === true) return
    spring.on('change', (latest) => {
      if (ref.current === null) return
      ref.current.textContent = formatRef.current(Math.round(latest))
    })
  }, [spring, prefersReduced])

  // 只有值真的变了才启动弹簧。首帧 `value === motionValue.get()`，不触发。
  // 降级时完全不碰 motionValue——没有订阅者，它写到哪里都不会到达 DOM。
  useEffect(() => {
    if (prefersReduced === true) return
    motionValue.set(value)
  }, [value, motionValue, prefersReduced])

  /*
   * 降级时把 DOM 文本显式同步回真实值。
   *
   * 正常路径下这个 effect 什么都不做：弹簧跑完停在目标值上，写着的内容
   * 和 `format(value)` 一致，React 和弹簧两边是吻合的。
   *
   * 但如果用户**中途**改了系统设置（false → true），弹簧可能已经往 DOM 里
   * 写过一帧中间值然后停下，而 React 因为 `format(value)` 没变**不会重写**
   * 那个文本节点——页面上就会永久停在一个不是真实值的数字上。
   * 这里补一刀，保证降级后显示的一定是真值。
   */
  useEffect(() => {
    if (prefersReduced !== true) return
    if (ref.current !== null) ref.current.textContent = format(value)
  }, [prefersReduced, value, format])

  return (
    <span ref={ref} className={cn('font-display tabular', className)}>
      {format(value)}
    </span>
  )
}
