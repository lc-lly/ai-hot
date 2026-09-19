/**
 * WebSocket 传输层（契约 §2 / §2.3）。
 *
 * 这一层**只管连接**：解析信封、维护退避与心跳、把消息交给上层。
 * 它刻意不持有业务数据，也不假设自己在线——
 * 契约 §2.3 明确「WS 只负责实时，不是唯一数据源」，
 * 所以断线时这里只上报状态，数据由 state/useHotData.ts 的轮询兜底。
 */

import { useEffect, useRef, useState } from 'react'
import type { Envelope } from '../types.js'

/** 契约 §2.3：1s → 2s → 4s → 8s，上限 30s */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const

/** 契约 §2.3：每 30s 发一次 ping；60s 内无任何服务端消息视为断线 */
export const HEARTBEAT_MS = 30_000
export const SILENCE_LIMIT_MS = 60_000

export type RealtimeStatus = 'connecting' | 'open' | 'closed'

export interface RealtimeState {
  status: RealtimeStatus
  /** 已失败的重连次数，连上后归零 */
  attempt: number
  /** 距下次重连的毫秒数，仅在 status='closed' 时有值 */
  nextRetryMs: number | null
  lastMessageAt: number | null
  serverVersion: string | null
  serverTime: string | null
}

export interface RealtimeHandlers {
  onMessage: (msg: Envelope) => void
  /** 前端自己的调试行，直接灌进底部日志流 */
  onTrace?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

function socketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

function isEnvelope(v: unknown): v is Envelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { type?: unknown }).type === 'string'
  )
}

export function useRealtime(handlers: RealtimeHandlers): RealtimeState {
  const [state, setState] = useState<RealtimeState>({
    status: 'connecting',
    attempt: 0,
    nextRetryMs: null,
    lastMessageAt: null,
    serverVersion: null,
    serverTime: null,
  })

  // 用 ref 持有回调，避免上层每次 render 重建 socket
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    let disposed = false
    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let countdownTimer: ReturnType<typeof setInterval> | null = null
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let watchdogTimer: ReturnType<typeof setInterval> | null = null
    let attempt = 0
    let lastMessageAt = 0
    let retryAt = 0

    const trace = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
      handlersRef.current.onTrace?.(level, message)
    }

    const clearTimers = () => {
      if (retryTimer) clearTimeout(retryTimer)
      if (countdownTimer) clearInterval(countdownTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (watchdogTimer) clearInterval(watchdogTimer)
      retryTimer = null
      countdownTimer = null
      heartbeatTimer = null
      watchdogTimer = null
    }

    const dropSocket = () => {
      if (!ws) return
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        /* 关闭失败无所谓，反正要丢弃引用 */
      }
      ws = null
    }

    const connect = () => {
      if (disposed) return
      dropSocket()
      const url = socketUrl()
      setState((s) => ({ ...s, status: 'connecting', nextRetryMs: null }))
      trace('debug', `ws connect → ${url}`)

      let sock: WebSocket
      try {
        sock = new WebSocket(url)
      } catch (err) {
        trace('error', `ws 构造失败: ${err instanceof Error ? err.message : String(err)}`)
        scheduleRetry('construct-failed')
        return
      }
      ws = sock

      sock.onopen = () => {
        if (disposed) return
        attempt = 0
        lastMessageAt = Date.now()
        setState((s) => ({
          ...s,
          status: 'open',
          attempt: 0,
          nextRetryMs: null,
          lastMessageAt,
        }))
        trace('info', 'ws 已连接 · 实时通道开启')

        heartbeatTimer = setInterval(() => {
          if (sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ type: 'ping', data: {} }))
          }
        }, HEARTBEAT_MS)

        // 看门狗：静默超过 60s 就当链路已死（半开连接不会触发 onclose）
        watchdogTimer = setInterval(() => {
          if (Date.now() - lastMessageAt > SILENCE_LIMIT_MS) {
            trace('warn', `ws 静默 >${SILENCE_LIMIT_MS / 1000}s，判定断线`)
            scheduleRetry('silence')
          }
        }, 5000)
      }

      sock.onmessage = (ev: MessageEvent) => {
        lastMessageAt = Date.now()
        if (typeof ev.data !== 'string') return
        let parsed: unknown
        try {
          parsed = JSON.parse(ev.data)
        } catch {
          trace('warn', `ws 收到非 JSON 帧，已丢弃 (${ev.data.slice(0, 60)})`)
          return
        }
        if (!isEnvelope(parsed)) return

        if (parsed.type === 'hello') {
          const data = parsed.data ?? {}
          setState((s) => ({
            ...s,
            lastMessageAt,
            serverVersion: typeof data['version'] === 'string' ? data['version'] : null,
            serverTime: typeof data['serverTime'] === 'string' ? data['serverTime'] : null,
          }))
          trace('info', `ws hello · server ${String(data['version'] ?? '?')}`)
          return
        }
        // 心跳应答不进业务流，也不进日志流（否则每 30s 刷一行噪音）
        if (parsed.type === 'pong') return

        setState((s) => ({ ...s, lastMessageAt }))
        handlersRef.current.onMessage(parsed)
      }

      sock.onerror = () => {
        // 浏览器不暴露错误细节，只报一个事实；真正的处理走 onclose
        trace('warn', 'ws 传输错误')
      }

      sock.onclose = (ev: CloseEvent) => {
        if (disposed) return
        scheduleRetry(`code=${ev.code}`)
      }
    }

    function scheduleRetry(reason: string) {
      if (disposed) return
      clearTimers()
      dropSocket()
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000
      attempt += 1
      retryAt = Date.now() + delay
      setState((s) => ({
        ...s,
        status: 'closed',
        attempt,
        nextRetryMs: delay,
      }))
      trace('warn', `ws 断开 (${reason}) · ${delay / 1000}s 后重连 (第 ${attempt} 次)`)

      countdownTimer = setInterval(() => {
        const left = Math.max(0, retryAt - Date.now())
        setState((s) => (s.nextRetryMs === left ? s : { ...s, nextRetryMs: left }))
      }, 500)

      retryTimer = setTimeout(connect, delay)
    }

    connect()

    return () => {
      disposed = true
      clearTimers()
      dropSocket()
    }
  }, [])

  return state
}
