import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn.js'
import { Button } from './Button.js'

/**
 * 页码控件。
 *
 * ## 为什么用「上一页 / 页码 / 下一页」而不是无限滚动
 *
 * 无限滚动与「按热度排序」是冲突的：用户往下滚了很久，然后切一次排序，
 * 整份内容会重排——他刚才读到的位置没有任何意义了。带页码的分页至少
 * 让位置是可复述的（「第 4 页那条」）。
 *
 * 页码列表最多显示 7 个，中间用省略号，保证宽度不会随总页数增长。
 */
export function Pagination({
  page,
  totalPages,
  total,
  disabled = false,
  onChange,
  className,
}: {
  page: number
  totalPages: number
  total: number
  disabled?: boolean
  onChange: (page: number) => void
  className?: string
}) {
  if (totalPages <= 1) {
    return (
      <p className={cn('pt-3 text-center text-xs text-zinc-600', className)}>共 {total} 条</p>
    )
  }

  const pages: Array<number | '…'> = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i += 1) pages.push(i)
  } else {
    pages.push(1)
    if (page > 3) pages.push('…')
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i += 1) {
      pages.push(i)
    }
    if (page < totalPages - 2) pages.push('…')
    pages.push(totalPages)
  }

  return (
    <div className={cn('flex items-center justify-center gap-2 pt-3', className)}>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || page <= 1}
        onClick={() => onChange(page - 1)}
        icon={<ChevronLeft className="h-4 w-4" />}
        aria-label="上一页"
      />

      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-zinc-600">
            …
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onChange(p)}
            disabled={disabled}
            aria-current={p === page ? 'page' : undefined}
            className={cn(
              'tabular h-8 min-w-8 cursor-pointer rounded-lg px-2 text-xs font-medium transition-colors',
              p === page
                ? 'bg-accent/20 text-accent-soft ring-1 ring-accent/40'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {p}
          </button>
        ),
      )}

      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || page >= totalPages}
        onClick={() => onChange(page + 1)}
        icon={<ChevronRight className="h-4 w-4" />}
        aria-label="下一页"
      />

      <span className="ml-2 text-xs text-zinc-600">共 {total} 条</span>
    </div>
  )
}
