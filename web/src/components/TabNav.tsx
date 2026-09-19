import { Hash, Search, Zap } from 'lucide-react'
import { cn } from '../lib/cn.js'

export const TABS = ['radar', 'keywords', 'search'] as const
export type TabKey = (typeof TABS)[number]

const TAB_META: Record<TabKey, { label: string; icon: typeof Zap }> = {
  radar: { label: '热点雷达', icon: Zap },
  keywords: { label: '监控词', icon: Hash },
  search: { label: '搜索', icon: Search },
}

/**
 * 顶部 Tab。
 *
 * ## 与旧版的区别
 *
 * 旧版用 `1/2/3` 键盘切视图，且**视图是按数字键切换的全屏替换**。
 * 这有两个问题：数字键与输入框冲突（在搜索框里打「1」会切视图），
 * 以及隐藏了「还有别的页面」这个事实。
 *
 * 新版是可见的 Tab 条。键盘快捷键仍然支持（在 App 里绑 Alt+数字，
 * 不与输入冲突），但它是加速键而不是唯一入口。
 */
export function TabNav({
  active,
  onChange,
  keywordCount,
}: {
  active: TabKey
  onChange: (tab: TabKey) => void
  /** 监控词数量，显示在 Tab 上作为「这里有多少东西」的提示 */
  keywordCount?: number
}) {
  return (
    <nav className="flex items-center gap-1" role="tablist">
      {TABS.map((key) => {
        const { label, icon: Icon } = TAB_META[key]
        const isActive = key === active
        return (
          <button
            key={key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(key)}
            className={cn(
              'relative flex cursor-pointer items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
              'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none',
              isActive
                ? 'bg-white/[0.06] text-zinc-100'
                : 'text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
            {key === 'keywords' && keywordCount !== undefined && keywordCount > 0 && (
              <span className="tabular rounded-full bg-white/10 px-1.5 text-[11px] text-zinc-400">
                {keywordCount}
              </span>
            )}
            {isActive && (
              <span
                aria-hidden
                className="absolute inset-x-3 -bottom-px h-px bg-gradient-to-r from-transparent via-accent to-transparent"
              />
            )}
          </button>
        )
      })}
    </nav>
  )
}
