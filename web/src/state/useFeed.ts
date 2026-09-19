/**
 * 热点流的分页查询状态。
 *
 * ## 为什么推翻了上一版的模型
 *
 * 上一版是「全量累积」：一次拉 400 条进内存，之后 WS 来的新条目按 id
 * 合并进去，数组只增不减。那个模型能成立，是因为旧界面是一块不滚动的
 * 单屏，看到的就是「最近的一屏」。
 *
 * 新界面要的是**服务端分页 + 多维筛选**——用户切到第 3 页、按热度排序、
 * 只看紧急、只看某个关键词。这些都必须由服务端回答，前端不可能靠
 * 一个只会增长的本地数组算出来。两种模型不能共存，所以整个换掉。
 *
 * 换掉之后 WS 的 `item` 消息不再往列表里塞条目（那会让「第 3 页」的
 * 内容被新条目挤走），改为**弹 toast + 触发一次刷新**。
 *
 * ## 三个必须处理的正确性问题
 *
 * 1. **竞态**：用户快速改筛选时，先发的慢请求可能后到，把新结果覆盖掉。
 *    用递增的 `seq` 丢弃过期响应，比 `AbortController` 更可靠——
 *    abort 只保证「不再关心」，不保证「回调不会被调用」。
 * 2. **翻页保留筛选**：改筛选条件必须回到第 1 页（否则可能停在一个
 *    新结果集里不存在的页码上，看到空白）；改页码则不重置。
 * 3. **刷新节流**：一次 collect 会插入几十条，每条 WS 都触发刷新就是
 *    几十个请求。合并到一个短窗口里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, fetchItems } from '../net/api.js'
import type { ItemDTO, ItemQuery, Pagination } from '../types.js'

export const DEFAULT_PAGE_SIZE = 20

/** 筛选条件的默认值。`resetFilters()` 回到这里。 */
export const EMPTY_FILTERS: ItemQuery = {
  sort: 'fetchedAt',
  order: 'desc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
}

/** 判断两个查询在**筛选维度**上是否等价（忽略 page）。 */
function sameFilters(a: ItemQuery, b: ItemQuery): boolean {
  const keys: Array<keyof ItemQuery> = [
    'sort',
    'order',
    'q',
    'kind',
    'sourceId',
    'topicId',
    'importance',
    'domain',
    'timeRange',
    'authenticity',
    'excludeFlags',
    'pageSize',
  ]
  return keys.every((k) => (a[k] ?? '') === (b[k] ?? ''))
}

export interface FeedState {
  items: ItemDTO[]
  pagination: Pagination
  loading: boolean
  /** 首屏加载（还没有任何数据）与翻页/刷新要区分：前者画骨架，后者只转圈 */
  initialLoading: boolean
  error: string | null
  query: ItemQuery
  /** 改筛选。**自动回到第 1 页** */
  setFilters: (patch: Partial<ItemQuery>) => void
  setPage: (page: number) => void
  resetFilters: () => void
  refresh: (opts?: { quiet?: boolean }) => void
}

export function useFeed(initial: ItemQuery = EMPTY_FILTERS): FeedState {
  const [query, setQuery] = useState<ItemQuery>({ ...EMPTY_FILTERS, ...initial })
  const [items, setItems] = useState<ItemDTO[]>([])
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadedOnce, setLoadedOnce] = useState(false)

  // 竞态守卫：只有序号最大的那次请求有权写入状态
  const seqRef = useRef(0)
  // 供 refresh 读取当前查询，避免把它做成 query 的依赖而重建函数
  const queryRef = useRef(query)
  queryRef.current = query

  const load = useCallback(async (q: ItemQuery, quiet: boolean) => {
    const seq = seqRef.current + 1
    seqRef.current = seq

    if (!quiet) setLoading(true)
    try {
      const { items: next, pagination: page } = await fetchItems(q)
      if (seq !== seqRef.current) return // 已被更新的请求取代
      setItems(next)
      setPagination(page)
      setError(null)
      setLoadedOnce(true)
    } catch (err) {
      if (seq !== seqRef.current) return
      // 取消不是错误
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof ApiError ? err.message : '加载失败')
      // **刻意不清空 items**：刷新失败时保留上一批数据，
      // 比把用户正在看的内容替换成一片空白要好得多
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(query, false)
  }, [query, load])

  const setFilters = useCallback((patch: Partial<ItemQuery>) => {
    setQuery((prev) => {
      const next = { ...prev, ...patch }
      // 筛选变了就回第 1 页，除非调用方明确指定了 page
      if (!sameFilters(prev, next)) next.page = patch.page ?? 1
      return next
    })
  }, [])

  const setPage = useCallback((page: number) => {
    setQuery((prev) => ({ ...prev, page: Math.max(1, page) }))
  }, [])

  const resetFilters = useCallback(() => {
    setQuery((prev) => ({ ...EMPTY_FILTERS, pageSize: prev.pageSize }))
  }, [])

  // 节流：WS 来一条 item 就刷一次的话，一轮 collect 会打出几十个请求
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refresh = useCallback(
    (opts: { quiet?: boolean } = {}) => {
      if (opts.quiet) {
        void load(queryRef.current, true)
        return
      }
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        // 刷新按当前筛选重拉**当前页**，不是回第 1 页——
        // 用户停在第 3 页时来了新数据，不该把他弹回开头
        void load(queryRef.current, true)
      }, 1200)
    },
    [load],
  )

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return useMemo(
    () => ({
      items,
      pagination,
      loading,
      initialLoading: loading && !loadedOnce,
      error,
      query,
      setFilters,
      setPage,
      resetFilters,
      refresh,
    }),
    [items, pagination, loading, loadedOnce, error, query, setFilters, setPage, resetFilters, refresh],
  )
}
