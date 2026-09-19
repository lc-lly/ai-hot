import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '../../lib/cn.js'

export type ToastTone = 'info' | 'success' | 'warn' | 'error'

export interface ToastItem {
  id: string
  tone: ToastTone
  title: string
  body?: string
  /** 有链接时整条可点，点了新窗口打开并自动消失 */
  href?: string
}

const TONE_STYLE: Record<ToastTone, { ring: string; icon: string; Icon: typeof Info }> = {
  info: { ring: 'ring-white/10', icon: 'text-accent-soft', Icon: Info },
  success: { ring: 'ring-true/25', icon: 'text-true', Icon: CheckCircle2 },
  warn: { ring: 'ring-high/25', icon: 'text-high', Icon: AlertTriangle },
  error: { ring: 'ring-urgent/25', icon: 'text-urgent', Icon: XCircle },
}

/** 成功/信息类 5 秒、警告/错误 9 秒。出错的信息用户需要更多时间读完。 */
const TTL: Record<ToastTone, number> = { info: 5000, success: 5000, warn: 9000, error: 9000 }

/**
 * 轻量 toast。
 *
 * ## 什么时候**不该**用它
 *
 * 「立即扫描」的状态**不用 toast**，它显示在顶栏里——因为扫描是分钟级的，
 * 而 toast 最多活 9 秒。用户切去别的窗口再回来时，一个已经消失的 toast
 * 等于什么都没说。
 *
 * toast 只用于「此刻发生、看一眼就够」的事件：抓到新热点、保存成功、
 * 单次操作失败。
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const seqRef = useRef(0)
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (toast: Omit<ToastItem, 'id'>) => {
      seqRef.current += 1
      const id = `t${seqRef.current}`
      setToasts((prev) => {
        // 最多同时 3 条。再多就不是提示而是遮挡了
        const next = [...prev, { ...toast, id }]
        return next.length > 3 ? next.slice(next.length - 3) : next
      })
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), TTL[toast.tone]),
      )
    },
    [dismiss],
  )

  // 卸载时清掉所有定时器，否则会在已卸载的组件上 setState
  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    },
    [],
  )

  return { toasts, push, dismiss }
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[21rem] flex-col gap-2"
    >
      {toasts.map((t) => {
        const { ring, icon, Icon } = TONE_STYLE[t.tone]
        const inner = (
          <>
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', icon)} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-zinc-200">{t.title}</span>
              {t.body && (
                <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-zinc-400">
                  {t.body}
                </span>
              )}
            </span>
          </>
        )

        return (
          <div
            key={t.id}
            className={cn(
              'glass animate-fade-up pointer-events-auto flex gap-2.5 rounded-xl p-3 shadow-xl shadow-black/40 ring-1',
              ring,
            )}
          >
            {t.href ? (
              <a
                href={t.href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => onDismiss(t.id)}
                className="flex min-w-0 flex-1 gap-2.5"
              >
                {inner}
              </a>
            ) : (
              <span className="flex min-w-0 flex-1 gap-2.5">{inner}</span>
            )}
            <button
              onClick={() => onDismiss(t.id)}
              className="h-4 shrink-0 cursor-pointer text-zinc-600 transition-colors hover:text-zinc-300"
              aria-label="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
