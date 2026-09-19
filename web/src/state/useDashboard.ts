/**
 * 仪表盘的状态中枢：把分页热点流、统计卡、监控词、实时通道合成一个 store。
 *
 * ## 为什么合成一个而不是拆三个
 *
 * 这三份数据在**同一个屏幕上同时可见**，而且互相触发刷新：
 * 「立即扫描」跑完要同时刷新统计、热点流、监控词的命中数；
 * WS 的 `stats` 消息要同时改统计卡和通知铃铛的角标。
 * 拆开的话每个联动都要在组件树里穿线，反而更乱。
 *
 * 搜索 Tab 有自己的查询状态（`useFeed` 的另一个实例），不在这里——
 * 它与雷达页的筛选互不影响。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  createTopic,
  deleteTopic,
  fetchStats,
  fetchTopics,
  runJob,
  updateTopic,
  type TopicInput,
} from '../net/api.js'
import { normalizeItem, normalizeStats } from '../lib/normalize.js'
import { useRealtime, type RealtimeState } from '../net/useRealtime.js'
import { useToasts, type ToastItem } from '../components/ui/Toast.js'
import { useFeed, type FeedState } from './useFeed.js'
import { useTicker, type TickerState } from './useTicker.js'
import type { StatsDTO, TopicDTO } from '../types.js'

export type ScanState = 'idle' | 'running' | 'skipped' | 'done' | 'failed'

export interface ScanStatus {
  state: ScanState
  /** 给用户看的一句话。`failed` 与 `skipped` 时**必定**有内容 */
  message: string | null
}

export interface Dashboard {
  feed: FeedState
  /**
   * 实时热点条的数据。**与 `feed` 是两份独立的状态**——
   * 它的 WS 插入不会碰 `feed`，见 `useTicker.ts` 与 `feed` 的注释。
   */
  ticker: TickerState
  stats: StatsDTO | null
  topics: TopicDTO[]
  topicsLoading: boolean
  /** 监控词 CRUD。失败时抛 `ApiError`，由调用方展示 */
  addTopic: (input: TopicInput) => Promise<void>
  editTopic: (id: string, patch: Partial<TopicInput>) => Promise<void>
  removeTopic: (id: string) => Promise<void>
  scan: () => Promise<void>
  scanStatus: ScanStatus
  realtime: RealtimeState
  toasts: ToastItem[]
  dismissToast: (id: string) => void
  /** 通知被标记已读后重拉一次统计——角标数字来自 `/api/stats` 的 `unread` */
  refreshStats: () => void
}

export function useDashboard(): Dashboard {
  const feed = useFeed()
  const ticker = useTicker()
  const [stats, setStats] = useState<StatsDTO | null>(null)
  const [topics, setTopics] = useState<TopicDTO[]>([])
  const [topicsLoading, setTopicsLoading] = useState(true)
  const [scanStatus, setScanStatus] = useState<ScanStatus>({ state: 'idle', message: null })
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts()

  /**
   * 拉一次统计。
   *
   * 失败**刻意静默**：它只是四张卡，弹一个红色错误条会把整页的
   * 注意力拉到一个次要组件上。卡片会保留上一次的数字。
   */
  const pullStats = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchStats()
      if (next) setStats(next)
    } catch {
      /* 见上 */
    }
  }, [])

  const reloadTopics = useCallback(async (): Promise<void> => {
    setTopicsLoading(true)
    try {
      setTopics(await fetchTopics())
    } catch {
      // 监控词页自己有错误态；这里静默，避免刚打开就弹红
    } finally {
      setTopicsLoading(false)
    }
  }, [])

  useEffect(() => {
    void pullStats()
    void reloadTopics()
  }, [pullStats, reloadTopics])

  // WS 之外的轮询兜底。理由见下方 realtime 的注释。
  useEffect(() => {
    const timer = setInterval(() => void pullStats(), 20_000)
    return () => clearInterval(timer)
  }, [pullStats])

  // ---- 监控词 CRUD ----
  const addTopic = useCallback(
    async (input: TopicInput) => {
      await createTopic(input)
      await Promise.all([reloadTopics(), pullStats()])
    },
    [reloadTopics, pullStats],
  )

  const editTopic = useCallback(
    async (id: string, patch: Partial<TopicInput>) => {
      await updateTopic(id, patch)
      // 改词可能让此前被跳过的条目重新进入待评估队列（后端会重置它们），
      // 所以统计与信息流也要跟着刷新
      await Promise.all([reloadTopics(), pullStats(), feed.refresh({ quiet: true })])
    },
    [reloadTopics, pullStats, feed],
  )

  const removeTopic = useCallback(
    async (id: string) => {
      await deleteTopic(id)
      await Promise.all([reloadTopics(), pullStats()])
    },
    [reloadTopics, pullStats],
  )

  // ---- 实时通道 ----
  //
  // `useRealtime` 内部用 ref 持有回调，所以这里每轮渲染传新的闭包不会
  // 导致 socket 重建——这是它能安全地读最新 state 的原因。
  const feedRef = useRef(feed)
  feedRef.current = feed

  /**
   * 新热点 toast 的节流窗口。
   *
   * 一轮 collect 会推几十条 `item` 消息。每条弹一个 toast 的话，屏幕会同时
   * 挂满几十个提示（`useToasts` 只保留最后 3 条，但那意味着**前几条已经被
   * 提示过又消失了**，用户看到的是不断闪烁的角落）。所以 8 秒内只弹第一条，
   * 其余靠列表刷新体现——列表本来就带「刷新中」的细进度线。
   */
  const lastItemToastRef = useRef(0)

  const realtime = useRealtime({
    onMessage: (msg) => {
      if (msg.type === 'stats') {
        // 后端两条路径（WS 广播 / GET /api/stats）共用同一个 `computeStats`，
        // 所以形状完全一致，可以用同一个归一化函数
        const next = normalizeStats(msg.data)
        if (next) setStats(next)
        return
      }

      if (msg.type === 'item') {
        // **刻意不把这条塞进列表。** 列表是「服务端第 N 页的那 20 条」，
        // 往里插一条会把本该出现的条目挤到下一页，用户看到的分页就错了。
        // 新条目通过刷新出现（`refresh` 自带节流，一轮 collect 只触发一次）。
        feedRef.current.refresh()

        const item = normalizeItem(msg.data)

        // 但**实时条可以插**——它不做分页，插入的代价只有「容量满时挤掉
        // 最旧的一条」。这是这个界面里唯一一处能让新热点立刻出现在
        // 视野中的地方，所以这一句才是「第一时间发现」的兑现点。
        if (item) ticker.insert(item)

        const now = Date.now()
        if (now - lastItemToastRef.current > 8000) {
          lastItemToastRef.current = now
          if (item) {
            pushToast({
              tone: 'info',
              title: '抓到新热点',
              body: item.title,
              ...(item.url ? { href: item.url } : {}),
            })
          }
        }
        return
      }

      // 通知落点是铃铛：角标数字来自 `/api/stats`，所以这里重拉一次统计即可
      if (msg.type === 'notification') {
        void pullStats()
        return
      }

      // `source` / `log` 不改变本页状态：它们是给日志面板用的，
      // 而新界面没有日志面板（采集健康度看监控词页的命中数更直接）。
    },
  })

  const { refresh: refreshTicker } = ticker

  /*
   * 重连后补拉一次实时条。
   *
   * WS 断开期间的 `item` 消息是**收不到**的，而实时条是纯靠 WS 前插维持的
   * ——不补这一次，它就会一直停在断线那一刻的样子，看起来还在滚，
   * 但滚的全是旧闻。这里专门处理「closed → open」这个**跃迁**，
   * 而不是「open 就拉」：后者会在每次渲染都触发一次请求。
   */
  const wasOpenRef = useRef(false)
  useEffect(() => {
    const open = realtime.status === 'open'
    if (open && !wasOpenRef.current) refreshTicker()
    wasOpenRef.current = open
  }, [realtime.status, refreshTicker])

  /*
   * WS 没连上时的轮询兜底。连上了就完全不轮询——消息是推过来的，
   * 再按分钟拉一次纯属浪费。这是全局唯一一处「连接状态影响取数策略」的地方。
   */
  useEffect(() => {
    if (realtime.status === 'open') return
    const timer = setInterval(refreshTicker, 60_000)
    return () => clearInterval(timer)
  }, [realtime.status, refreshTicker])

  // ---- 立即扫描 ----
  const scan = useCallback(async () => {
    setScanStatus({ state: 'running', message: '正在采集各数据源…' })
    try {
      const collect = await runJob('collect')
      if (collect.skipped) {
        // 上一轮还没跑完。**必须说出来**——否则用户看到转圈突然停下、
        // 数据没变，会以为按钮坏了。扫描是分钟级的，撞上这个状态是常态。
        setScanStatus({ state: 'skipped', message: '上一轮扫描还在进行中，请稍候再试' })
        pushToast({ tone: 'warn', title: '上一轮扫描还在跑', body: '等它结束再点，或稍后自动更新。' })
        return
      }
      if (!collect.ok) {
        const message = collect.error ?? '采集失败，请查看服务端日志'
        setScanStatus({ state: 'failed', message })
        pushToast({ tone: 'error', title: '采集失败', body: message })
        return
      }

      // 采完立刻评一批。只跑 collect 的话用户看到的是一屏没有 AI 结论的
      // 灰卡片——而卡片上最有辨识度的元素（真伪、相关度、理由）全来自 AI。
      setScanStatus({ state: 'running', message: '正在用 AI 分析新增内容…' })
      const triage = await runJob('triage')

      await Promise.all([pullStats(), reloadTopics()])
      feed.refresh({ quiet: true })
      // 扫描是**绕过 WS 直接改库**的，推来的 `item` 消息可能还没到。
      // 主动补一次，让实时条立刻反映刚采到的东西
      refreshTicker()

      // 顶栏那行状态 4 秒后自己消失，而扫描是分钟级的：用户很可能已经
      // 滚到页面下半部分了。所以结论也要以 toast 的形式送到他眼前。
      if (!triage.ok) {
        const message = triage.error ?? 'AI 分析失败'
        setScanStatus({ state: 'failed', message })
        pushToast({ tone: 'warn', title: '已采集，但 AI 分析失败', body: message })
      } else if (triage.skipped) {
        setScanStatus({ state: 'done', message: '已采集，AI 分析正在进行中' })
        pushToast({ tone: 'info', title: '采集完成', body: 'AI 分析正在进行中，稍后会陆续出现结论。' })
      } else {
        setScanStatus({ state: 'done', message: '扫描完成' })
        pushToast({ tone: 'success', title: '扫描完成', body: '统计与列表已更新。' })
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '扫描失败，请检查后端是否在运行'
      setScanStatus({ state: 'failed', message })
      pushToast({ tone: 'error', title: '扫描失败', body: message })
    }
  }, [feed, pullStats, reloadTopics, pushToast, refreshTicker])

  // 结果 4 秒后自动收起。常驻的成功提示会变成视觉噪音，
  // 而失败/跳过不自动收——那个信息用户可能还没看到。
  useEffect(() => {
    if (scanStatus.state !== 'done') return
    const t = setTimeout(() => setScanStatus({ state: 'idle', message: null }), 4000)
    return () => clearTimeout(t)
  }, [scanStatus])

  return {
    feed,
    ticker,
    stats,
    topics,
    topicsLoading,
    addTopic,
    editTopic,
    removeTopic,
    scan,
    scanStatus,
    realtime,
    toasts,
    dismissToast,
    refreshStats: useCallback(() => void pullStats(), [pullStats]),
  }
}
