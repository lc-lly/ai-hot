import { cn } from '../../lib/cn.js'
import { Meteors } from '../aceternity/Meteors.js'
import { Spotlight } from '../aceternity/Spotlight.js'

/**
 * 背景氛围层：一束顶光 + 一组流星 + 几道呼吸光束。
 *
 * ## 这里曾经写着「为什么不用 Aceternity」
 *
 * 上一版这段注释的理由有两条，现在**两条都要推翻或修正**，留着会误导人：
 *
 * 1. ~~「参考项目是付费课程项目，仓库无 LICENSE」~~ —— 这条顾虑指向的是
 *    **从无 LICENSE 的仓库抄代码**。Aceternity UI 的免费组件本来就是
 *    设计成「复制进你的项目」来分发的，vendor 是它的预期用法。
 *    授权性质完全不同，这条不成立。
 * 2. 「省掉 framer-motion 约 40KB gz」—— 这条**是真的**，但用户明确要求
 *    采用 Aceternity，所以这笔开销是知情的取舍。对应的工程动作是：
 *    `motion` 在 `vite.config.ts` 里单独切块 + 动效层延迟挂载，
 *    不让它占首屏关键路径（见 `App.tsx` 的 `EffectsLayer`）。
 *
 * ## 为什么光斑和光束**没有**换成 Aceternity 的 `BackgroundBeams`
 *
 * `BackgroundBeams` 是给 hero 区设计的**定尺寸 SVG**（一组写死的路径，
 * 适配某个宽高比），铺在一个高度不定的滚动页面上会拉伸变形。
 * 原来这几道 CSS 光束是按「百分比定位 + 呼吸动画」写的，任何尺寸下都成立，
 * 而且比 SVG 便宜得多。**这里保留自研版本是权衡的结果，不是遗漏。**
 *
 * 流星则换成了 Aceternity 的 `Meteors`——原来手写的那几条已经被它取代，
 * 两套流星同时存在只会显得杂乱（而且我们改过 `@keyframes meteor` 的定义，
 * 旧的那几条早就动不起来了）。
 *
 * ## 使用约束
 *
 * **必须是 `position: fixed` 且 `pointer-events: none`**，并且放在
 * 页面根的**第一个**子元素。它是背景，不该参与布局，也不该接住点击。
 * 内容层需要 `relative z-10` 才能盖住它。
 */
export function Backdrop({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none fixed inset-0 z-0 overflow-hidden', className)}
    >
      {/*
        光斑：左上、右下各一团。**色值走 token，不写字面 rgba。**
        上一版这里硬编码了 rgba(59,130,246) 和 rgba(6,182,212)——正是
        accent/cyan 的复制品，于是改设计令牌时背景纹丝不动，
        整页只有背景还是旧的蓝紫色。现在改成从 token 派生。
      */}
      <div
        className="absolute -top-40 -left-40 h-[42rem] w-[42rem] rounded-full blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, color-mix(in srgb, var(--color-accent) 20%, transparent), transparent 70%)',
        }}
      />
      <div
        className="absolute -right-40 -bottom-40 h-[38rem] w-[38rem] rounded-full blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, color-mix(in srgb, var(--color-accent-soft) 14%, transparent), transparent 70%)',
        }}
      />

      {/* 顶光。Aceternity `Spotlight`，纯 SVG + 一次性 CSS 入场，零运行时成本 */}
      <Spotlight className="-top-40 left-0 md:-top-20 md:left-60" fill="var(--color-accent-soft)" />

      {/*
        光束：从顶部斜射下来的一组细线，靠呼吸动画产生纵深。
        skew 让它们统一倾斜，看起来像同一束光的边缘而不是随机线条。
      */}
      <div className="absolute inset-x-0 top-0 h-[60vh] opacity-40 [transform:skewY(-12deg)] [transform-origin:top_left]">
        {[12, 28, 46, 63, 81].map((left, i) => (
          <div
            key={left}
            className="animate-beam absolute top-0 h-full w-px"
            style={{
              left: `${left}%`,
              // 每根错开相位，否则五根一起亮灭像在闪
              animationDelay: `${i * 1.6}s`,
              background:
                'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--color-accent-soft) 50%, transparent), transparent)',
            }}
          />
        ))}
      </div>

      {/*
        流星。只占页面顶部一条带——Aceternity 的 `Meteors` 把流星起点固定在
        容器垂直中央，铺满整页的话它们会集中在屏幕中间横穿内容。
      */}
      <Meteors number={8} className="absolute inset-x-0 top-0 h-[60vh]" />
    </div>
  )
}
