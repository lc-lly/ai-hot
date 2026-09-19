import { useEffect, useRef } from 'react'

/**
 * 全局键盘层。
 *
 * ## 三条规矩
 *
 * 1. **焦点在输入框里时，不带修饰键的按键一律不劫持**——否则在搜索框里
 *    打 `/` 就会跳走。`Escape` 例外（关面板）。
 * 2. **`Ctrl`/`Meta` 组合一律放行**，留给浏览器（Ctrl+R、Cmd+K 等）。
 * 3. **`Alt` 组合是个例外**：它既不是文字输入，浏览器也没占用几个键，
 *    所以即使焦点在输入框里也照常处理。新界面用 `Alt+1/2/3` 切 Tab，
 *    正是为了让快捷键不与输入冲突（旧版不带走修饰键的 `1/2/3` 会和打字撞车）。
 *
 * 处理函数用 ref 持着，按键绑定不会因为上层重新 render 而解绑重绑。
 */
export type KeyMap = Record<string, (ev: KeyboardEvent) => void>

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * 把事件拼成 `Alt+1` 这样的组合键名字。
 *
 * 数字键用 `ev.code` 兜底：在某些键盘布局下按住 Alt 会改变 `ev.key`
 * （macOS 上 `Alt+1` 是 `¡`），而 `code` 恒为 `Digit1`。
 */
function comboOf(ev: KeyboardEvent): string {
  const mods: string[] = []
  if (ev.altKey) mods.push('Alt')
  if (ev.shiftKey) mods.push('Shift')

  let key = ev.key
  if (mods.length > 0 && !/^[a-zA-Z0-9]$/.test(key)) {
    if (/^Digit[0-9]$/.test(ev.code)) key = ev.code.slice(5)
    else if (/^Key[A-Z]$/.test(ev.code)) key = ev.code.slice(3)
  }

  return mods.length === 0 ? key : [...mods, key].join('+')
}

export function useKeyboard(map: KeyMap, enabled = true): void {
  const mapRef = useRef(map)
  mapRef.current = map

  useEffect(() => {
    if (!enabled) return
    const onKey = (ev: KeyboardEvent) => {
      // Ctrl/Meta 是浏览器和系统的地盘，绝不抢
      if (ev.ctrlKey || ev.metaKey) return

      const hasMod = ev.altKey || ev.shiftKey
      const typing = isTypingTarget(ev.target)
      if (typing && !hasMod && ev.key !== 'Escape') return

      // 先找带修饰键的组合，再回落到裸键
      const fn = mapRef.current[comboOf(ev)] ?? (hasMod ? undefined : mapRef.current[ev.key])
      if (!fn) return
      fn(ev)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
