/**
 * 实时热点条的数据源。
 *
 * ## 为什么它**不**用 `useFeed`
 *
 * 实时条要的是「此刻正在发生什么」，热点流要的是「服务端第 N 页的那 20 条」。
 * 两者的排序键、容量、更新方式全都不同：
 *
 * | | 热点流 | 实时条 |
 * |---|---|---|
 * | 数据 | 服务端分页，用户可筛可翻 | 固定最新 10 条，不可筛 |
 * | 新条目 | **不插入**，靠刷新出现 | 立即插入 |
 * | 容量 | 20/页 | 10，超出丢弃 |
 *
 * 复用 `useFeed` 会有两个后果：一是实时条的 WS 插入会破坏分页
 * （`useFeed.ts:157-161` 那条不变量的理由），二是实时条的独立容量
 * 无处安放。所以这里是一个**独立的 state 分片**，与 `feed` 互不影响。
 *
 * ## 初次填充复用已有的接口，零后端改动
 *
 * `fetchItems({ sort:'publishedAt', order:'desc', pageSize:10 })` ——
 * `publishedAt` 早在冻结的参数方言里（`types.ts` 的 `ItemQuery`），
 * 后端不需要加任何端点或参数。
 *
 * ## 新条目是**插入后排序**，不是无脑前插
 *
 * 直觉做法是把 WS 来的条目 `unshift` 到最前面。但 WS 推的 `item` 是
 * 「**刚抓到的**」，不是「刚发生的」——一条三天前的旧文今天才被采集到，
 * 前插会让它挂在「此刻正在发生」的条带最显眼的位置上撒谎。
 *
 * 所以插入后按 `publishedAt` 重排。真正的新热点本来就该在最前面，
 * 而被翻出来的旧文会落到它真实的位置，甚至被 10 条的容量挤出去——
 * 这是对的：它不是实时热点。条目旁边的时间戳也始终是诚实的。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, fetchItems } from '../net/api.js'
import type { ItemDTO } from '../types.js'

/** 条带上同时存在的条目数。再多就滚得太长，一眼扫不完。 */
export const TICKER_SIZE = 10

export interface TickerState {
  items: ItemDTO[]
  /** 首次填充还没回来。用来区分「还没接到」和「确实没有热点」 */
  loading: boolean
  error: string | null
  /** WS 推来一条新条目。去重 + 重排 + 截断都在内部完成 */
  insert: (item: ItemDTO) => void
  /** 重拉一次。断线重连后调用，补上断开期间错过的条目 */
  refresh: () => void
}

/**
 * 排序键。
 *
 * 用 `publishedAt`，缺失时退回 `fetchedAt`——与卡片上的时间戳
 * （`HotspotCard` 的 `item.publishedAt ?? item.fetchedAt`）是同一个口径。
 * 两处不一致的话，条带上排第一的条目点开可能不是卡片上最新那条。
 *
 * 时间戳解析失败的条目返回 `-Infinity`：降序排列时它落到最后。
 * 不用 `NaN`——`Array.prototype.sort` 的比较函数返回 `NaN` 是未定义行为，
 * 在 V8 上会得到一个**看起来像随机**的顺序，而且不报错。
 */
function timeKey(item: ItemDTO): number {
  const iso = item.publishedAt ?? item.fetchedAt
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? -Infinity : t
}

/**
 * 合并两批条目：按 id 去重（**新数据赢**）、按发布时间降序、截断到容量。
 *
 * `incoming` 放在前面参与去重，所以同一条目在 `incoming` 里的版本会覆盖
 * `prev` 里的旧版本——WS 推来的条目 AI 结论可能还是 `pending`，
 * 而重新拉取拿到的已经评完了，后者必须能盖掉前者。
 */
function merge(prev: ItemDTO[], incoming: ItemDTO[]): ItemDTO[] {
  const seen = new Set<string>()
  const out: ItemDTO[] = []
  for (const item of [...incoming, ...prev]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  out.sort((a, b) => timeKey(b) - timeKey(a))
  return out.slice(0, TICKER_SIZE)
}

export function useTicker(): TickerState {
  const [items, setItems] = useState<ItemDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 竞态守卫，与 `useFeed` 同一套办法：序号最大的那次请求才有权写入
  const seqRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const seq = seqRef.current + 1
    seqRef.current = seq
    try {
      const { items: next } = await fetchItems({
        sort: 'publishedAt',
        order: 'desc',
        page: 1,
        pageSize: TICKER_SIZE,
      })
      if (seq !== seqRef.current) return
      // 走 merge 而不是直接替换：重连补拉期间 WS 可能已经推进来几条，
      // 直接替换会把它们抹掉
      setItems((prev) => merge(prev, next))
      setError(null)
    } catch (err) {
      if (seq !== seqRef.current) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      // **刻意不清空 items**：失败时保留上一次的内容。
      // 条带整个消失比内容旧一点更糟——它会让页头的高度跳一下
      setError(err instanceof ApiError ? err.message : '实时热点加载失败')
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const insert = useCallback((item: ItemDTO) => {
    setItems((prev) => merge(prev, [item]))
  }, [])

  const refresh = useCallback(() => void load(), [load])

  return useMemo(
    () => ({ items, loading, error, insert, refresh }),
    [items, loading, error, insert, refresh],
  )
}
