import { cn } from '../../lib/cn.js'

/**
 * Aceternity UI `Spotlight` —— 从左上打下来的一束柔光。
 *
 * 来源：https://ui.aceternity.com/components/spotlight
 * 改动：只把 `@/lib/utils` 的 import 换成本仓库的 `lib/cn`。其余原样。
 *
 * ## 为什么这个组件值得 vendor
 *
 * 它是一段**静态 SVG + 一次 CSS 入场动画**（`animate-spotlight`，跑一次就停 2s）。
 * 没有 JS 逐帧、没有 canvas、没有监听器。对「背景要有氛围但不能拖慢加载」
 * 这条要求来说，这是最便宜的一档。
 *
 * ## 依赖一个容易被删掉的令牌
 *
 * 下面那个 `animate-spotlight` 工具类要求 `styles.css` 的 `@theme` 里存在
 * `--animate-spotlight`。**没有它，Tailwind 不生成这个类，而元素上还挂着
 * `opacity-0`——整束光就永久不可见，且不报任何错。**（这不是假设：
 * 这个令牌曾经被当成「多余的」删掉过，光就真的没亮过。）
 * Tailwind v4 会摇掉 `@theme` 里没被按名引用的 `@keyframes`，
 * 所以「关键帧在那儿」并不等于「动画能用」。
 *
 * ## 只用一个实例
 *
 * SVG 里的 `filter` id 是**硬编码**的 `"filter"`。同一个页面上放两个，
 * 第二个会引用到第一个的滤镜——不是崩溃，是渲染结果难以预测。
 * 页面背景层只需要一束光，所以这里不做去重。
 */
export function Spotlight({ className, fill }: { className?: string; fill?: string }) {
  return (
    <svg
      className={cn(
        'animate-spotlight pointer-events-none absolute z-[1] h-[169%] w-[138%] opacity-0 lg:w-[84%]',
        className,
      )}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 3787 2842"
      fill="none"
      aria-hidden="true"
    >
      <g filter="url(#filter)">
        <ellipse
          cx="1924.71"
          cy="273.501"
          rx="1924.71"
          ry="273.501"
          transform="matrix(-0.822377 -0.568943 -0.568943 0.822377 3631.88 2291.09)"
          fill={fill ?? 'white'}
          fillOpacity="0.21"
        />
      </g>
      <defs>
        <filter
          id="filter"
          x="0.860352"
          y="0.838989"
          width="3785.16"
          height="2840.26"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="151" result="effect1_foregroundBlur_1065_8" />
        </filter>
      </defs>
    </svg>
  )
}
