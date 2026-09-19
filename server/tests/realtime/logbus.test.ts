import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_CAPACITY,
  isLogChannel,
  isLogLevel,
  LogBus,
  toLogData,
} from '../../src/realtime/logbus.js'

describe('LogBus 环形缓冲', () => {
  it('默认容量足够契约 §4 的轮询兜底（至少几百条）', () => {
    expect(DEFAULT_LOG_CAPACITY).toBeGreaterThanOrEqual(300)
    expect(new LogBus().capacity).toBe(DEFAULT_LOG_CAPACITY)
  })

  it('写入的 entry 形状符合契约 §2.1', () => {
    const bus = new LogBus({ now: () => new Date('2026-09-15T00:00:00.000Z') })
    const entry = bus.log({ channel: 'fetch', level: 'warn', message: 'boom', meta: { n: 1 } })
    expect(entry.id).toMatch(/[0-9a-f-]{36}/)
    expect(entry.ts).toBe('2026-09-15T00:00:00.000Z')
    expect(entry.level).toBe('warn')
    expect(entry.channel).toBe('fetch')
    expect(entry.message).toBe('boom')
    expect(entry.meta).toEqual({ n: 1 })

    // WS 的 data 剥掉 ts，其余原样
    expect(toLogData(entry)).toEqual({
      id: entry.id,
      level: 'warn',
      channel: 'fetch',
      message: 'boom',
      meta: { n: 1 },
    })
  })

  it('level 默认 info，meta 没给就不带这个键', () => {
    const entry = new LogBus().log({ channel: 'system', message: 'hi' })
    expect(entry.level).toBe('info')
    expect(Object.hasOwn(entry, 'meta')).toBe(false)
    expect(Object.keys(toLogData(entry)).sort()).toEqual(['channel', 'id', 'level', 'message'])
  })

  it('recent 从新到旧', () => {
    const bus = new LogBus({ capacity: 10 })
    for (let i = 1; i <= 3; i += 1) bus.log({ channel: 'ai', message: `m${i}` })
    expect(bus.recent().map((e) => e.message)).toEqual(['m3', 'm2', 'm1'])
    expect(bus.recent(2).map((e) => e.message)).toEqual(['m3', 'm2'])
    expect(bus.recent(0)).toEqual([])
    expect(bus.recent(99)).toHaveLength(3)
  })

  it('容量有界：写满后覆盖最旧的，size 不再涨', () => {
    const bus = new LogBus({ capacity: 5 })
    for (let i = 1; i <= 20; i += 1) bus.log({ channel: 'notify', message: `m${i}` })
    expect(bus.size).toBe(5)
    expect(bus.capacity).toBe(5)
    expect(bus.recent().map((e) => e.message)).toEqual(['m20', 'm19', 'm18', 'm17', 'm16'])
  })

  it('环回之后 get/has 仍能找到存活的那几条', () => {
    const bus = new LogBus({ capacity: 3 })
    const first = bus.log({ channel: 'system', message: 'a' })
    bus.log({ channel: 'system', message: 'b' })
    bus.log({ channel: 'system', message: 'c' })
    bus.log({ channel: 'system', message: 'd' }) // 顶掉 a

    expect(bus.has(first.id)).toBe(false)
    const last = bus.recent(1)[0]
    expect(last?.message).toBe('d')
    expect(bus.get(last?.id ?? '')).toBe(last)
    expect(bus.get('nope')).toBeUndefined()
  })

  it('clear 清空', () => {
    const bus = new LogBus()
    bus.log({ channel: 'system', message: 'a' })
    bus.clear()
    expect(bus.size).toBe(0)
    expect(bus.recent()).toEqual([])
  })

  it('容量至少为 1，非法 limit 不会越界', () => {
    const bus = new LogBus({ capacity: 0 })
    expect(bus.capacity).toBe(1)
    bus.log({ channel: 'system', message: 'a' })
    expect(bus.recent(Number.NaN)).toHaveLength(1)
  })

  it('注入时钟让 id 唯一、ts 可控', () => {
    const bus = new LogBus({ now: () => new Date('2026-01-01T00:00:00.000Z') })
    const a = bus.log({ channel: 'system', message: 'x' })
    const b = bus.log({ channel: 'system', message: 'y' })
    expect(a.id).not.toBe(b.id)
    expect(a.ts).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('log 枚举守卫', () => {
  it('只认契约里列的值', () => {
    expect(isLogLevel('debug')).toBe(true)
    expect(isLogLevel('fatal')).toBe(false)
    expect(isLogLevel(1)).toBe(false)
    expect(isLogChannel('fetch')).toBe(true)
    expect(isLogChannel('ai')).toBe(true)
    expect(isLogChannel('notify')).toBe(true)
    expect(isLogChannel('system')).toBe(true)
    expect(isLogChannel('other')).toBe(false)
  })
})
