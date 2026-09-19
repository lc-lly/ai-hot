import { motion, useMotionTemplate, useMotionValue, useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { cn } from '../../lib/cn.js'

/**
 * Aceternity UI `CardSpotlight` —— 跟随鼠标的径向高光。
 *
 * 来源：https://ui.aceternity.com/components/card-spotlight
 *
 * ## 改动一：删掉 `CanvasRevealEffect`（官方默认带的那层）
 *
 * 官方版本在悬停时挂载 `<CanvasRevealEffect>`，那是一个 **WebGL canvas**
 * （点阵溶解效果）。一个卡片一个 canvas，一页 20 张卡就是 20 个 WebGL
 * 上下文——浏览器的上限通常在 8~16 个，超了会**静默丢弃最早的上下文**，
 * 表现为「滚着滚着某些卡片的背景黑了」，而且不报错。
 *
 * 剩下的部分（径向遮罩跟随鼠标）纯 CSS，视觉上已经足够表达「这张卡是活的」。
 *
 * ## 改动二：不用 `useState` 跟踪悬停
 *
 * 官方版本用 `isHovering` state 控制显隐，鼠标进出各触发一次整卡重渲染。
 * 但显隐**本来就该是 CSS 的事**——`group-hover` 一行搞定，零重渲染。
 * 官方那个 state 只服务于 canvas 的挂载（合理），canvas 删了它就没有理由了。
 *
 * ## 改动三：坐标不进 React
 *
 * 位置存在 `useMotionValue` 里，由 motion 直接写进 style，**不触发重渲染**。
 * 放进 state 的话鼠标每动一下就重渲染整张卡。
 *
 * ## 什么时候不挂
 *
 * 触屏（无悬停语义）和 `prefers-reduced-motion` 下都不渲染高光层。
 * 卡片的 hover 边框仍然在，可用性不受影响。
 */
export function CardSpotlight({
  children,
  radius = 320,
  color = 'rgba(6, 182, 212, 0.08)',
  className,
  disabled = false,
}: {
  children: ReactNode
  radius?: number
  color?: string
  className?: string
  disabled?: boolean
}) {
  const prefersReduced = useReducedMotion()
  const mouseX = useMotionValue(-9999)
  const mouseY = useMotionValue(-9999)
  // 模板在渲染期构造一次，motion 会在鼠标移动时直接更新底层的 CSS 变量，
  // 整条路径不经过 React
  const background = useMotionTemplate`radial-gradient(${radius}px circle at ${mouseX}px ${mouseY}px, ${color}, transparent 80%)`

  /*
   * 位置每帧最多算一次。
   *
   * `getBoundingClientRect()` 会强制同步布局，而 `pointermove` 的触发频率
   * 跟**设备**有关，不跟屏幕刷新率有关：游戏鼠标能到 1000Hz，
   * 而屏幕最多重绘 60/120 次。不节流的话，每秒钟有上千次读取是白做的。
   *
   * 用 rAF 而不是定时器：它天然对齐重绘节奏，且页面隐藏时会自动暂停。
   */
  const frame = useRef(0)
  const pending = useRef<{ el: HTMLDivElement; x: number; y: number } | null>(null)

  const flush = useCallback(() => {
    frame.current = 0
    const next = pending.current
    pending.current = null
    if (next === null) return
    const { left, top } = next.el.getBoundingClientRect()
    mouseX.set(next.x - left)
    mouseY.set(next.y - top)
  }, [mouseX, mouseY])

  useEffect(() => {
    return () => {
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
    }
  }, [])

  // 初始坐标放在卡片外（-9999），这样高光在鼠标进入前是「不可见」的，
  // 而不是停在左上角闪一下
  function handleMouseMove(e: ReactMouseEvent<HTMLDivElement>): void {
    pending.current = { el: e.currentTarget, x: e.clientX, y: e.clientY }
    if (frame.current === 0) frame.current = requestAnimationFrame(flush)
  }

  const off = disabled || prefersReduced === true

  return (
    <div
      className={cn('group/spotlight relative', className)}
      onMouseMove={off ? undefined : handleMouseMove}
    >
      {children}
      {/*
        高光层放在**子节点之后**。

        官方的顺序是反的（层在前、children 在后），在它自己的 demo 里没问题
        是因为那层带了 canvas；但我们的卡片是 `.panel` **实底**，先渲染的层
        会被卡片整个盖住——效果完全消失，而且不报错、不看图发现不了。

        层因此在内容之上。它 `pointer-events-none`，色值也刻意压到很低的
        alpha，覆盖在文字上只会让那一小块微微提亮，不影响可读性
        （正文 `zinc-400` 在 `#17171a` 上约 7:1，叠一层 8% 的青几乎不动这个数）。
      */}
      {off ? null : (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300 group-hover/spotlight:opacity-100"
          style={{ background }}
        />
      )}
    </div>
  )
}
