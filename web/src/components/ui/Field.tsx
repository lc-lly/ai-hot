import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComponentPropsWithRef, KeyboardEvent, ReactNode } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn.js'
import { CARD_SURFACE } from './Card.js'

/**
 * 筛选栏与表单共用的控件。
 *
 * 这些不是「通用组件库」，而是**把同一套暗色下的边框/焦点/禁用态写一遍**——
 * 分散写的话，六个下拉框会长出六种深浅不同的边框，在纯黑底上非常明显。
 */

/*
 * 边框亮度是**跟容器比出来的**，不是拍脑袋定的。
 *
 * 原来写 `border-white/10`。放在 `.panel`（`#1b1b1f`）上没问题，但筛选栏
 * 的容器是 `.glass`——一个只有 `white 4%` 的几乎全黑的面。于是：
 *
 *   .glass 容器  ≈ rgb(20,20,21)
 *   控件边框     = white/10 ≈ rgb(35,35,36)   ← 比自己的容器还亮一倍
 *
 * 一排七个下拉框，每个都比它们所在的那个面亮一档，看上去就是一串**浮在
 * 空中的白框**，而不是「一个筛选区里的七个控件」。用户看到的「白色边框
 * 很突兀」说的就是这个反差。
 *
 * 降到 `white/[0.07]` 之后边框比容器亮得刚好够读出边界，又不再抢眼。
 * hover 也从 `/20` 收到 `/[0.14]`，保持同一档差距。
 */
const SURFACE = [
  'rounded-lg border border-white/[0.07] bg-white/[0.04] text-sm text-zinc-200',
  'transition-colors outline-none',
  'hover:border-white/[0.14] hover:bg-white/[0.06]',
  'focus:border-accent/60 focus:ring-2 focus:ring-accent/25',
].join(' ')

const CONTROL = [SURFACE, 'h-9', 'disabled:cursor-not-allowed disabled:opacity-50'].join(' ')

/**
 * 下拉框。**自绘的 listbox，不是原生 `<select>`。**
 *
 * ## 为什么把原生 `<select>` 换掉
 *
 * 原生控件唯一的优势是「选项面板的行为浏览器全包了」，而它唯一的代价是
 * **那个面板的样式我们一点都碰不到**。上一版判断这个代价可以接受，理由是
 * `color-scheme: dark`（见 `styles.css`）会让系统面板跟着变暗。
 *
 * 这条推理在**计算样式上**是对的，在**渲染上**不成立：实测 `html`、
 * `select`、`option` 三层的 `computed color-scheme` 都是 `dark`、`<option>`
 * 上的 `bg-surface` 也真的解析成了 `rgb(16,16,18)`，但面板在屏幕上依然是
 * **白底黑字、选中项一道系统淡蓝**——一整块亮色直接砸在纯黑页面上，
 * 用户报的就是这个。
 *
 * 更麻烦的是它**没法验证**：那个面板是浏览器的独立窗口，`Page.captureScreenshot`
 * 截不到它。一个「改了但看不见效果、也没法量」的样式，只能靠用户来回反馈。
 *
 * 所以换自绘。换来的是：面板配色进得了 CSS、能用 CDP 量、能和全站用同一套
 * token。代价是下面这些行为得自己实现——**它们不是可选项**，原生控件帮我们
 * 做过的每一件都要补回来：
 *
 * | 行为 | 实现 |
 * |---|---|
 * | ↑/↓ 移动、Home/End 到两端 | `onKeyDown` + `active` 索引 |
 * | Enter/Space 选中、Esc 关闭 | 同上 |
 * | Tab 关闭 | 同上（不拦截，焦点照常往下走） |
 * | 点面板外关闭 | document 上的 `mousedown` |
 * | 关闭后焦点回到触发按钮 | `commit()` / Esc 里 `focus()` |
 * | 键盘移动时高亮项滚进视野 | 手算 `scrollTop`，不用 `scrollIntoView` |
 *
 * 最后一条刻意手算：`scrollIntoView` 会把**所有**可滚动祖先一起滚，包括
 * 文档本身。在这个「页面会滚、面板也会滚」的布局里，那意味着按一下 ↓
 * 整页跟着跳一下。
 *
 * ## 两个高亮是两件事，别合并
 *
 * - `active`（键盘/鼠标所在项）：`bg-white/[0.07]` 的底色，跟着 ↑↓ 走
 * - `selected`（当前值）：左侧勾 + `text-accent-soft`
 *
 * 合成一个的话，「我正看着哪一项」和「当前选的是哪一项」就分不开了——
 * 而键盘用户恰恰需要同时知道这两件事。
 *
 * ## 无障碍
 *
 * 走的是「select-only combobox」：焦点**始终**留在触发按钮上，面板里不设
 * 焦点，靠 `aria-activedescendant` 把「当前高亮项」报给读屏。所以 `<li>`
 * 上没有 `tabIndex`——给面板里的选项加可聚焦性，读屏用户就得在两条焦点
 * 链之间来回跳。
 *
 * ## 面板走 Portal，**不能**改成就地渲染
 *
 * 就地渲染踩了两个坑，而且都是「看起来只是没对齐」的那种：
 *
 * **一、被祖先裁掉。** `.panel` 自带 `overflow-hidden`（卡片要它来切圆角），
 * 而搜索页那个表单卡只有一行高。实测面板矩形是 `top 271 → bottom 377`，
 * 卡片矩形到 `307.6` 就结束了——面板下沿有 70px 被切掉，**连面板中心点都
 * 落在裁剪区外面**，于是 `elementFromPoint` 命中的是它背后的空态。
 *
 * **二、被祖先的层叠上下文困住。** `.glass` 带 `backdrop-filter`，那会创建
 * 层叠上下文；上下文一成立，面板自己的 `z-50` 就只在筛选栏内部有效，而
 * 筛选栏在父亲那层仍是 `z-index: auto`，会被 DOM 里排在后面的卡片盖住。
 * 实测面板中心的 `elementFromPoint` 命中一张卡片，点「按热度」点到的其实是
 * 卡片，值根本没变。（`AppHeader` 上那个 `relative z-40` 修的是同一类问题。）
 *
 * Portal 到 `body` 之后两个问题一起消失：它不再是任何裁剪盒或层叠上下文的
 * 后代。代价是位置要自己算——`position: fixed` + 读触发按钮的
 * `getBoundingClientRect()`，并且在滚动/改窗口时跟着更新。
 */
export function Select({
  value,
  onChange,
  options,
  className,
  disabled = false,
  ...rest
}: {
  value: string
  onChange: (value: string) => void
  /** 第一项通常给 `{ value: '', label: '全部' }` */
  options: ReadonlyArray<{ value: string; label: string }>
  className?: string
  disabled?: boolean
} & Omit<ComponentPropsWithRef<'button'>, 'value' | 'onChange' | 'children' | 'className'>) {
  const [open, setOpen] = useState(false)
  /** 键盘/鼠标的高亮位置。和 `value` 是两回事，见上方注释 */
  const [active, setActive] = useState(0)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const baseId = useId()

  /** 面板高度上限，与下面 `max-h-72` 保持一致。翻转判定要用它 */
  const MAX_H = 288
  /** 触发按钮和面板之间的缝 */
  const GAP = 4

  /**
   * 把面板摆到触发按钮正下方。
   *
   * **直接写 DOM 样式，不走 state**：滚动时这个函数每帧都会跑，走 state 就是
   * 每帧一次重渲染——而它改的只是位置，和 React 管的任何东西都无关。
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current
    const popup = listRef.current
    if (!trigger || !popup) return
    const r = trigger.getBoundingClientRect()
    popup.style.left = `${r.left}px`
    popup.style.width = `${r.width}px`

    // 下面放不下、上面更宽敞，就往上翻。不翻的话靠近视口底部的下拉框
    // 会被切掉一半，而「被切掉一半」在屏幕上看起来就像面板本来就那么高
    const below = window.innerHeight - r.bottom - GAP
    const above = r.top - GAP
    const need = Math.min(popup.offsetHeight, MAX_H)
    const openUp = below < need && above > below

    popup.style.top = openUp ? 'auto' : `${r.bottom + GAP}px`
    popup.style.bottom = openUp ? `${window.innerHeight - r.top + GAP}px` : 'auto'
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    place()
    /*
      `scroll` 必须用**捕获**阶段监听：面板打开时用户滚的通常是某个内层
      滚动容器（热点流那层），那种 scroll 事件不冒泡到 window，用默认的
      冒泡监听收不到，面板会和触发按钮脱开。
    */
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  // 找不到就退回第一项：`value` 是外部状态，可能指向一个已经被删掉的选项
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )
  const current = options[selectedIndex]

  // 每次展开都把高亮落在当前值上，而不是上次停在哪儿
  useEffect(() => {
    if (open) setActive(selectedIndex)
  }, [open, selectedIndex])

  // 高亮项滚进视野。手算 scrollTop，理由见上方注释
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const el = list?.children[active] as HTMLElement | undefined
    if (!list || !el) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [open, active])

  /*
    点外部关闭。用 mousedown 而不是 click：click 要等到 mouseup，
    在别处按下、拖过来松手也会触发。与 NotificationBell 同一套做法。

    **两个 ref 都要判**：面板 portal 到了 `body`，不再是 `rootRef` 的后代，
    只判 rootRef 的话，点面板里的选项会先被当成「点了外部」而关掉。
  */
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const commit = (index: number) => {
    const opt = options[index]
    if (!opt) return
    onChange(opt.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onKeyDown = (ev: KeyboardEvent<HTMLButtonElement>) => {
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        if (open) setActive((i) => Math.min(i + 1, options.length - 1))
        else setOpen(true)
        break
      case 'ArrowUp':
        ev.preventDefault()
        if (open) setActive((i) => Math.max(i - 1, 0))
        else setOpen(true)
        break
      case 'Home':
        if (open) {
          ev.preventDefault()
          setActive(0)
        }
        break
      case 'End':
        if (open) {
          ev.preventDefault()
          setActive(options.length - 1)
        }
        break
      case 'Enter':
      case ' ':
        ev.preventDefault()
        if (open) commit(active)
        else setOpen(true)
        break
      case 'Escape':
        if (open) {
          ev.preventDefault()
          setOpen(false)
        }
        break
      case 'Tab':
        // 不拦截，焦点照常往下走；只是面板不该继续挂着
        if (open) setOpen(false)
        break
      default:
        break
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        {...rest}
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open ? `${baseId}-opt-${active}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={cn(
          CONTROL,
          'flex w-full cursor-pointer items-center gap-1 pr-8 pl-3 text-left',
          open && 'border-accent/60 ring-2 ring-accent/25',
          disabled && 'cursor-not-allowed',
        )}
      >
        <span className="truncate">{current?.label ?? value}</span>
      </button>

      <ChevronDown
        className={cn(
          'pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 transition-transform',
          open ? 'rotate-180 text-zinc-300' : 'text-zinc-500',
        )}
      />

      {open &&
        createPortal(
          /*
            底色 = `.panel` 实底 + `CARD_SURFACE` 那道青渐变，和统计卡、
            热点卡是同一个面（常量直接从 `Card.tsx` 引，不是抄一份）。
            纯 `.panel` 是一块孤零零的黑，浮在同样偏黑的内容上分不出层次——
            用户的原话是「现在的黑色还是有点突兀」。

            不用 `.glass`：它压在筛选栏和卡片之上，透出背景就是噪声。

            边框仍走 `border-white/10` 而不是卡片那圈 `border-accent/15`：
            浮层压在任意内容之上，需要比卡片更清楚的边界（`NotificationBell`
            的面板同理）。底色渐变负责「和内容是一套」，边框负责「浮在上面」。

            位置（left / width / top|bottom）全部由 `place()` 直接写在元素
            的 style 上，所以这里一个定位类都不要加，加了也会被覆盖。
          */
          <ul
            ref={listRef}
            role="listbox"
            id={`${baseId}-list`}
            style={{ position: 'fixed' }}
            className={cn(
              'panel z-50 max-h-72 overflow-y-auto overscroll-contain rounded-lg border-white/10 py-1 shadow-2xl shadow-black/60',
              CARD_SURFACE,
            )}
          >
          {options.map((o, i) => {
            const selected = o.value === value
            return (
              <li
                key={`${o.value} ${i}`}
                id={`${baseId}-opt-${i}`}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActive(i)}
                onClick={(ev) => {
                  /*
                    触发按钮外面套着 `<label>`（见 KeywordPanel 的 `<Field>`）。
                    label 的默认行为是「把冒泡上来的点击转发给它的控件」——
                    点这一项会**顺带**再点一次触发按钮，把刚关上的面板又打开。
                    `preventDefault()` 取消的正是这个默认行为；`<li>` 自己
                    没有别的默认行为，不会误伤。
                  */
                  ev.preventDefault()
                  commit(i)
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
                  i === active ? 'bg-white/[0.07] text-zinc-100' : 'text-zinc-300',
                )}
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-accent-soft' : 'opacity-0')}
                />
                <span className="truncate">{o.label}</span>
              </li>
            )
            })}
          </ul>,
          document.body,
        )}
    </div>
  )
}

/**
 * 输入框。
 *
 * 用 `ComponentPropsWithRef<'input'>` 而不是 `InputHTMLAttributes`：
 * 后者不含 `ref`，搜索页就没法在切到该 Tab 时自动聚焦输入框。
 * `ref` 经由 `...rest` 落到真正的 `<input>` 上（React 19 里 `ref`
 * 对函数组件就是一个普通 prop）。
 */
export function Input({
  icon,
  loading = false,
  className,
  ...rest
}: { icon?: ReactNode; loading?: boolean } & ComponentPropsWithRef<'input'>) {
  return (
    <div className={cn('relative', className)}>
      {icon && (
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-zinc-500">
          {icon}
        </span>
      )}
      <input
        {...rest}
        className={cn(CONTROL, icon ? 'pl-9' : 'pl-3', loading ? 'pr-9' : 'pr-3', 'w-full')}
      />
      {loading && (
        <Loader2 className="animate-spin-slow absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
      )}
    </div>
  )
}

/**
 * 多行文本。
 *
 * 存在的理由是**别再抄一遍 `SURFACE`**：监控词表单里那两个 textarea 原先
 * 各自内联了一份和 `CONTROL` 一模一样的边框/底色/焦点类名。这正是本文件
 * 开头那句注释警告的事——改一处漏一处，两个输入框就会长出两种深浅的边框。
 */
export function Textarea({ className, ...rest }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...rest} className={cn(SURFACE, 'w-full resize-y px-3 py-2', className)} />
}

/**
 * 开关。用它而不是 checkbox，是因为「启用/停用」在视觉上就该是开与关。
 *
 * ## 圆钮的 `left-0.5` **不是**可有可无的
 *
 * 上一版圆钮只写了 `top-0.5`，水平位置交给 `translate-x-0.5` /
 * `translate-x-4.5` 决定。看上去「0.5 + 4.5 = 5 = 轨道宽 4.5 减钮宽」还挺自洽，
 * 实际渲染出来圆钮**整个跑到轨道右侧外面**，压在编辑按钮上（用户报的就是这个）。
 *
 * 原因是绝对定位元素的 `left` 为 `auto` 时，用的是它的**静态位置**，
 * 而这个位置**不是 0**：在浏览器里量出来是 18px（轨道宽 36 的一半），
 * 跟它自己的 `translate` 无关。于是两段位移叠起来——静态位置 18px
 * 加上 `translate-x-4.5` 的 18px——圆钮正好落在 36px 处，也就是轨道的右边缘。
 *
 * 实测（`.scratch/probe-toggle3.cjs`，把过渡关掉后逐项量）：
 *
 * | `left` / `translate` | 圆钮相对轨道左边的偏移 |
 * |---|---|
 * | `auto` / `18px`（原样） | **36px** ← 整个钮在轨道外 |
 * | `auto` / `0` | 18px ← 静态位置确实是 18 |
 * | `0` / `0` | 0px |
 *
 * 所以修法是**把 `left` 钉死**，让水平位置只有一个来源；`translate`
 * 只负责剩下那段行程。留 `translate` 而不是用 `left` 做动画，是因为
 * `left` 会触发布局，`transform` 不会。
 *
 * ## 行程是 16px 而不是 18px
 *
 * 轨道 36 − 钮 16 − 左侧留白 2 = 18，右边还要留 2 → 行程 = 36 − 16 − 2 − 2 = **16**，
 * 也就是 `translate-x-4`。写 `4.5` 是上一版为了凑那个错误的静态位置而拧出来的数。
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
        'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none',
        checked ? 'bg-accent' : 'bg-white/10',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  )
}

/** 表单里带标题的一格。 */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}
