import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn.js'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-gradient-to-r from-accent to-accent-soft text-white shadow-lg shadow-accent/20 hover:brightness-110',
  ghost: 'text-zinc-300 hover:bg-white/5 hover:text-zinc-100',
  outline: 'glass text-zinc-200 hover:border-white/20 hover:bg-white/[0.06]',
  danger: 'bg-urgent/15 text-urgent ring-1 ring-urgent/30 hover:bg-urgent/25',
}

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** 转圈并把按钮锁住。**不是纯装饰**：见下方注释 */
  loading?: boolean
  icon?: ReactNode
}

/**
 * 按钮。
 *
 * `loading` 会**同时禁用点击**，这一点是刻意的：
 * 「立即扫描」是分钟级的操作，如果只是画个圈而按钮仍可点，
 * 用户会连点五次，服务端会返回五次 `{skipped:true}`，
 * 用户看到的现象是「点了没反应」。禁用 + 转圈才是诚实的反馈。
 */
export function Button({
  variant = 'outline',
  size = 'md',
  loading = false,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center rounded-lg font-medium transition-all duration-150',
        'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    >
      {loading ? <Loader2 className="animate-spin-slow h-4 w-4" /> : icon}
      {children}
    </button>
  )
}
