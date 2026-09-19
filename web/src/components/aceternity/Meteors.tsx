import { useMemo } from 'react'
import { cn } from '../../lib/cn.js'

/**
 * Aceternity UI `Meteors` —— 斜向划过的流星。
 *
 * 来源：https://ui.aceternity.com/components/meteors
 *
 * 两处改动，都是为了同一类问题：**官方实现在 render 里调 `Math.random()`**。
 *
 * ## 1. 位置改成一次算好、之后固定（`useMemo`）
 *
 * ```tsx
 * // 官方写法
 * style={{ top: 0, left: Math.floor(Math.random() * 800 - 400) + "px",
 *          animationDelay: Math.random() * 0.6 + 0.2 + "s" }}
 * ```
 *
 * 每次 render 都重新摇一次，于是：父组件任何一次重渲染（轮询、WS 消息、
 * 敲一个字符）都会让所有流星**瞬移**。开发模式下 `StrictMode` 的双渲染
 * 更是必然触发。位置本来就不该随渲染变化——它只跟序号有关。
 *
 * ## 2. 用确定性的伪随机，不用 `Math.random()`
 *
 * 这样一来同样的 `number` 永远得到同样的构图，截图可复现（否则视觉回归
 * 测试每次都「有差异」），也避免了服务端渲染时的 hydration 不匹配。
 *
 * ## 降级
 *
 * 纯 CSS 动画，`prefers-reduced-motion` 那条全局 `!important` 会把时长压到
 * 0.01ms、迭代压到 1 次，流星直接落到终态（`opacity: 0`）——即不可见。
 * 这里**不需要**额外的 JS 判断，全局规则正好给出正确结果。
 */

/**
 * mulberry32：32 位确定性伪随机。
 *
 * 不用 `Math.sin(seed)` 那类取巧写法，它的分布有肉眼可见的规律（位置会成串）。
 * 这个算法体积只有几行，分布质量足够画流星。
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface MeteorStyle {
  left: string
  animationDelay: string
  animationDuration: string
}

export function Meteors({
  number = 20,
  className,
  seed = 20260916,
}: {
  number?: number
  className?: string
  seed?: number
}) {
  return (
    <div className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden="true">
      <MeteorField number={number} seed={seed} />
    </div>
  )
}

function MeteorField({ number, seed }: { number: number; seed: number }) {
  const meteors = useMemo<MeteorStyle[]>(() => {
    const rand = seededRandom(seed)
    return Array.from({ length: number }, () => ({
      left: `${Math.floor(rand() * 800 - 400)}px`,
      // 延迟 0.2~1.0s、周期 2~12s：错开相位，避免整屏一起划
      animationDelay: `${(rand() * 0.8 + 0.2).toFixed(2)}s`,
      animationDuration: `${Math.floor(rand() * 10 + 2)}s`,
    }))
  }, [number, seed])

  return (
    <>
      {meteors.map((style, idx) => (
        <span
          key={idx}
          className={cn(
            'animate-meteor absolute top-1/2 left-1/2 h-0.5 w-0.5 rotate-[215deg] rounded-full bg-faint',
            "before:absolute before:top-1/2 before:h-px before:w-[50px] before:-translate-y-1/2 before:bg-gradient-to-r before:from-faint before:to-transparent before:content-['']",
          )}
          style={style}
        />
      ))}
    </>
  )
}
