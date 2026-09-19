import { useSyncExternalStore } from 'react'

/**
 * 媒体查询 → 布尔值。**全应用共用一份订阅源。**
 *
 * ## 为什么不直接用 motion 的 `useReducedMotion()`
 *
 * 因为那会把 `motion`（约 45KB gz）拉回首屏关键路径。
 *
 * `HotspotCard` 必须在**决定要不要挂载动效层之前**就知道这两件事，
 * 而它只要写下一行 `import { useReducedMotion } from 'motion/react'`，
 * 无论后面怎么 `React.lazy`，`motion` 都已经是**静态**依赖了——
 * `vite.config.ts` 里单独切出 `motion` chunk 的努力会在这里全部作废。
 *
 * `CardSpotlight` / `NumberTicker` 内部**继续用 motion 自己的
 * `useReducedMotion()`**，那是对的：它们本来就在 motion 里面，
 * 而且需要独立成立（不依赖调用方替它们判过）。
 *
 * ## 为什么是 `useSyncExternalStore` 而不是 `useState` + `useEffect`
 *
 * 1. **首帧就是对的。** `useEffect` 版本首帧只能给一个猜的值（通常是
 *    `false`），触屏用户会先看到一帧「有动效」的界面再被纠正。
 *    `getSnapshot` 在渲染期同步读 `matchMedia`，不存在这一帧。
 * 2. **一份监听，不是 N 份。** 一页 20 张卡各 `addEventListener` 一次
 *    就是 20 个监听器。这里按查询字符串缓存，全站每种查询只有一个。
 *
 * ## 缓存的 `MediaQueryList` 在**首次调用时**才创建
 *
 * 模块顶层直接 `window.matchMedia(...)` 的话，任何在 Node 里 import
 * 这个文件的场合（测试、将来的 SSR）都会当场抛错。放进函数里，
 * 代价只是第一次调用时的一次 Map 查找。
 */

interface Store {
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => boolean
}

const stores = new Map<string, Store>()

function storeOf(query: string): Store {
  const cached = stores.get(query)
  if (cached !== undefined) return cached

  const mql = window.matchMedia(query)
  const store: Store = {
    subscribe(onChange) {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    getSnapshot: () => mql.matches,
  }
  stores.set(query, store)
  return store
}

export function useMediaQuery(query: string): boolean {
  const store = storeOf(query)
  // 第三个参数是 SSR 的快照。本仓库是纯 SPA，它不会被用到；
  // 但如果将来真的跑在 Node 里，缺了它 `useSyncExternalStore` 会直接抛错。
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => false)
}

/**
 * 有**精确**指针吗（鼠标、触控笔）。触屏为 `false`。
 *
 * 判据用 `pointer: fine` 而不是 `hover: hover`：两者在触屏上都为假，
 * 但 `pointer` 描述的是「输入设备的精度」，正是「这个效果该不该装」
 * 要问的问题——它表达的是「有没有一个能悬停并追踪位置的东西」。
 */
export function usePointerFine(): boolean {
  return useMediaQuery('(pointer: fine)')
}

/**
 * 用户在系统里要求减少动效吗。
 *
 * 这是**用户的选择**，不是设备能力，所以判定必须走 JS：`styles.css` 里
 * 那条 `animation-duration: 0.01ms !important` 只拦得住 CSS 动画，
 * 对 motion 的逐帧写入（`useSpring` 直接改 `textContent`）完全无效。
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)')
}
