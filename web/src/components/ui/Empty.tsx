import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.js'

/**
 * 空态。
 *
 * **`hint` 是这里最重要的参数，不是可选的装饰。** 「暂无数据」四个字
 * 会让用户以为功能坏了；真正有用的是告诉他**为什么**没有、以及**怎么才有**。
 * 所以每个调用点都应该想清楚 hint 写什么，而不是留空。
 */
export function Empty({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  hint?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      {icon && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-zinc-500">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {hint && <div className="mt-1.5 max-w-md text-xs leading-relaxed text-zinc-500">{hint}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/**
 * 骨架屏。
 *
 * 用骨架而不是转圈：列表的形状是已知的，先把形状画出来能让页面
 * 在数据到达前后**不发生跳动**。转圈会让整块内容在加载完成的瞬间
 * 把下面的东西全部推下去。
 *
 * 卡片的骨架形状由 `components/HotspotCard.tsx` 提供（它必须与真卡片
 * 同步演进），这里只有最基础的方块。
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-white/5', className)} />
}
