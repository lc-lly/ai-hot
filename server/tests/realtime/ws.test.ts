import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { logRoutes } from '../../src/routes/logs.js'
import { LogBus } from '../../src/realtime/logbus.js'
import {
  attachRealtime,
  broadcast,
  clientCount,
  log,
  type RealtimeDeps,
  type RealtimeHandle,
} from '../../src/realtime/server.js'
import { toItemDTO } from '../../src/score/dto.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function boot(deps: RealtimeDeps = {}) {
  const server: Server = createServer()
  const bus = new LogBus()
  const handle: RealtimeHandle = attachRealtime(server, { logBus: bus, now: () => new Date('2026-09-15T00:00:00.000Z'), ...deps })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  cleanups.push(async () => {
    await handle.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  return { server, bus, handle, port, url: `ws://127.0.0.1:${port}/ws` }
}

interface Client {
  ws: WebSocket
  messages: Array<{ type: string; ts: string; data: Record<string, unknown> }>
  waitFor(type: string, timeoutMs?: number): Promise<{ type: string; ts: string; data: Record<string, unknown> }>
  countOf(type: string): number
}

async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url)
  const messages: Client['messages'] = []
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString('utf8'))))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  // 连接建立之后可能出现的 error（对端 RST 等）不该打挂测试进程
  ws.on('error', () => undefined)

  const waitFor: Client['waitFor'] = async (type, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = messages.find((m) => m.type === type)
      if (found) return found
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`等待 ${type} 超时，收到: ${JSON.stringify(messages)}`)
  }

  cleanups.push(async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate()
  })

  return { ws, messages, waitFor, countOf: (type) => messages.filter((m) => m.type === type).length }
}

describe('WS /ws', () => {
  it('连上立刻收到 hello（契约 §2.1）', async () => {
    const { url } = await boot({ version: '9.9.9' })
    const c = await connect(url)

    const hello = await c.waitFor('hello')
    expect(hello.ts).toBe('2026-09-15T00:00:00.000Z')
    expect(hello.data).toEqual({ serverTime: '2026-09-15T00:00:00.000Z', version: '9.9.9' })
  })

  it('log() 一次调用同时进环形缓冲和广播，data 严格对齐契约 §2.1（不带 ts）', async () => {
    const { url, bus, handle } = await boot()
    const c = await connect(url)
    await c.waitFor('hello')

    handle.log({ channel: 'fetch', level: 'info', message: 'hackernews: 30 条', meta: { inserted: 30 } })

    const msg = await c.waitFor('log')
    expect(Object.keys(msg.data).sort()).toEqual(['channel', 'id', 'level', 'message', 'meta'])
    expect(msg.data).toMatchObject({
      level: 'info',
      channel: 'fetch',
      message: 'hackernews: 30 条',
      meta: { inserted: 30 },
    })
    // 同一个 entry 也在缓冲里（轮询兜底不会漏）
    expect(bus.recent(1)[0]?.id).toBe(msg.data['id'])
  })

  it('broadcast 到所有客户端，返回值是实际发出的连接数', async () => {
    const { url, handle } = await boot()
    const a = await connect(url)
    const b = await connect(url)
    await Promise.all([a.waitFor('hello'), b.waitFor('hello')])

    const dto = toItemDTO({ id: 'i1', title: 'GPT 新闻', url: 'https://e.com/1', fetchedAt: new Date(0) })
    expect(handle.broadcast('item', dto)).toBe(2)

    const [ma, mb] = await Promise.all([a.waitFor('item'), b.waitFor('item')])
    expect(ma.data).toEqual(dto)
    expect(mb.data).toEqual(dto)
    expect(ma.ts).toBe('2026-09-15T00:00:00.000Z')
  })

  it('stats / source / notification 三种 data 都能原样送达', async () => {
    const { url, handle } = await boot()
    const c = await connect(url)
    await c.waitFor('hello')

    handle.broadcast('stats', { pending: 3, todayMatches: 7, tokensToday: 1234 })
    handle.broadcast('source', {
      id: 's1',
      name: 'hn',
      kind: 'hackernews',
      lastOk: true,
      lastRunAt: '2026-09-15T00:00:00.000Z',
      lastError: null,
    })
    handle.broadcast('notification', {
      id: 'n1',
      createdAt: '2026-09-15T00:00:00.000Z',
      title: 't',
      body: 'b',
      level: 'push',
      read: false,
      itemId: 'i1',
      topicId: null,
      channels: ['inapp'],
    })

    expect((await c.waitFor('stats')).data).toEqual({ pending: 3, todayMatches: 7, tokensToday: 1234 })
    expect((await c.waitFor('source')).data).toMatchObject({ id: 's1', lastOk: true })
    expect((await c.waitFor('notification')).data).toMatchObject({ level: 'push', channels: ['inapp'] })
  })

  it('客户端 ping → 服务端 pong（契约 §2.2）', async () => {
    const { url } = await boot()
    const c = await connect(url)
    await c.waitFor('hello')

    c.ws.send(JSON.stringify({ type: 'ping', data: {} }))
    const pong = await c.waitFor('pong')
    expect(pong.data).toEqual({})
    expect(pong.ts).toBe('2026-09-15T00:00:00.000Z')
  })

  it('垃圾消息 / 未知类型不会打挂连接', async () => {
    const { url, handle } = await boot()
    const c = await connect(url)
    await c.waitFor('hello')

    c.ws.send('not json')
    c.ws.send(JSON.stringify({ type: 'subscribe', data: { room: 'x' } }))
    c.ws.send(JSON.stringify({ no: 'type' }))
    await new Promise((r) => setTimeout(r, 50))

    expect(c.ws.readyState).toBe(WebSocket.OPEN)
    expect(handle.clientCount()).toBe(1)
    expect(handle.broadcast('stats', { pending: 0, todayMatches: 0, tokensToday: 0 })).toBe(1)
    await c.waitFor('stats')
  })

  it('客户端断开后不再计入，也不会被广播（无监听泄漏）', async () => {
    const { url, handle } = await boot()
    const a = await connect(url)
    const b = await connect(url)
    await Promise.all([a.waitFor('hello'), b.waitFor('hello')])
    expect(handle.clientCount()).toBe(2)

    const closed = new Promise<void>((resolve) => b.ws.once('close', () => resolve()))
    b.ws.terminate()
    await closed
    await waitUntil(() => handle.clientCount() === 1)

    expect(handle.broadcast('stats', { pending: 0, todayMatches: 0, tokensToday: 0 })).toBe(1)
    await a.waitFor('stats')
    expect(b.messages.filter((m) => m.type === 'stats')).toHaveLength(0)
  })

  it('半开连接会被清出广播集合（广播只发 OPEN 的 socket）', async () => {
    const { url, handle } = await boot()
    const a = await connect(url)
    await a.waitFor('hello')
    expect(handle.clientCount()).toBe(1)

    // 拔掉底层 TCP，不打招呼
    a.ws.terminate()
    await waitUntil(() => handle.clientCount() === 0)

    expect(handle.broadcast('stats', { pending: 0, todayMatches: 0, tokensToday: 0 })).toBe(0)
  })

  it('心跳不会误杀活着的连接', async () => {
    const { url, handle } = await boot({ heartbeatIntervalMs: 20 })
    const c = await connect(url)
    await c.waitFor('hello')

    await new Promise((r) => setTimeout(r, 150)) // 跑过好几个心跳周期

    expect(handle.clientCount()).toBe(1)
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
    expect(handle.broadcast('stats', { pending: 1, todayMatches: 0, tokensToday: 0 })).toBe(1)
    await c.waitFor('stats')
  })

  it('只挂 /ws，别的路径连不上（不另起端口）', async () => {
    const { port } = await boot()
    const other = new WebSocket(`ws://127.0.0.1:${port}/nope`)
    const outcome = await new Promise<string>((resolve) => {
      other.once('open', () => resolve('open'))
      other.once('error', () => resolve('error'))
    })
    other.terminate()
    expect(outcome).toBe('error')
  })

  it('close() 后端口仍在监听（不关底层 http.Server），连接全部断开', async () => {
    const { server, url, handle } = await boot()
    const c = await connect(url)
    await c.waitFor('hello')

    const closed = new Promise<void>((resolve) => c.ws.once('close', () => resolve()))
    await handle.close()
    await closed

    expect(handle.clientCount()).toBe(0)
    expect(server.listening).toBe(true)
  })
})

describe('进程级 broadcast / log（阶段 2/4/5 的入口）', () => {
  it('没挂载时是安全的 no-op，但日志仍然进缓冲（轮询兜底）', () => {
    const entry = log({ channel: 'system', message: 'before attach' })
    expect(entry.message).toBe('before attach')
    expect(broadcast('stats', { pending: 0, todayMatches: 0, tokensToday: 0 })).toBe(0)
    expect(clientCount()).toBe(0)
  })

  it('挂载后模块级 log/broadcast 打到客户端', async () => {
    const { url } = await boot()
    const c = await connect(url)
    await c.waitFor('hello')

    const entry = log({ channel: 'ai', message: '模型返回' })
    const msg = await c.waitFor('log')
    expect(msg.data['id']).toBe(entry.id)
    expect(broadcast('item', { id: 'x' })).toBe(1)
    await c.waitFor('item')
  })

  it("broadcast('log', ...) 也进环形缓冲——调用方不会漏掉兜底数据", async () => {
    const { url, bus, handle } = await boot()
    const c = await connect(url)
    await c.waitFor('hello')

    handle.broadcast('log', { channel: 'notify', level: 'warn', message: 'webpush 失败' })
    const msg = await c.waitFor('log')
    expect(msg.data).toMatchObject({ channel: 'notify', level: 'warn', message: 'webpush 失败' })
    expect(bus.recent(1)[0]?.message).toBe('webpush 失败')

    // 脏值降级而不是抛
    handle.broadcast('log', { message: 42 })
    const second = await waitForCount(c, 'log', 2)
    expect(second[1]?.data).toMatchObject({ channel: 'system', level: 'info', message: '42' })
    expect(bus.size).toBe(2)
  })
})

describe('与 Express 共用一个 http.Server（契约 §1）', () => {
  it('HTTP /api/logs 与 WS /ws 同端口同实例', async () => {
    const bus = new LogBus({ now: () => new Date('2026-09-15T00:00:00.000Z') })
    const app = express()
    app.use(express.json())
    app.use('/api', logRoutes({ logBus: bus }))

    // 控制者的挂法：app.listen() 返回 http.Server，WS 挂上去，不另起端口
    const server = createServer(app)
    const handle = attachRealtime(server, { logBus: bus, now: () => new Date('2026-09-15T00:00:00.000Z') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    cleanups.push(async () => {
      await handle.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    const c = await connect(`ws://127.0.0.1:${port}/ws`)
    await c.waitFor('hello')

    handle.log({ channel: 'fetch', message: '同端口' })

    // 一条日志同时从 WS 和 HTTP 拿得到
    expect((await c.waitFor('log')).data).toMatchObject({ message: '同端口' })

    const res = await fetch(`http://127.0.0.1:${port}/api/logs?limit=5`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; logs: Array<{ message: string; channel: string }> }
    expect(body.count).toBe(1)
    expect(body.logs[0]).toMatchObject({ message: '同端口', channel: 'fetch' })
  })
})

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitUntil 超时')
}

async function waitForCount(c: Client, type: string, n: number, timeoutMs = 2000): Promise<Client['messages']> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = c.messages.filter((m) => m.type === type)
    if (found.length >= n) return found
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等待 ${n} 条 ${type} 超时`)
}
