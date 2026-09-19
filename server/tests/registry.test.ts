import { beforeEach, describe, expect, it } from 'vitest'
import { __resetRegistry, getAdapter, listAdapters, registerAdapter } from '../src/sources/registry.js'
import type { SourceAdapter } from '../src/sources/types.js'

const stub = (kind: string): SourceAdapter => ({
  kind,
  fetch: async () => [],
  health: async () => ({ ok: true, detail: 'stub' }),
})

describe('adapter registry', () => {
  beforeEach(() => __resetRegistry())

  it('注册后能按 kind 取回', () => {
    registerAdapter(stub('a'))
    expect(getAdapter('a').kind).toBe('a')
  })

  it('重复注册同一个 kind 直接报错', () => {
    registerAdapter(stub('a'))
    expect(() => registerAdapter(stub('a'))).toThrow(/duplicate/)
  })

  it('取未注册的 kind 报出可读错误，并列出已注册的 kind', () => {
    registerAdapter(stub('a'))
    expect(() => getAdapter('zzz')).toThrow(/zzz.*a/s)
  })

  it('listAdapters 返回全部已注册项', () => {
    registerAdapter(stub('a'))
    registerAdapter(stub('b'))
    expect(listAdapters().map((x) => x.kind).sort()).toEqual(['a', 'b'])
  })
})
