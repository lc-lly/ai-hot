import type { SourceAdapter } from './types.js'

const adapters = new Map<string, SourceAdapter>()

export function registerAdapter(adapter: SourceAdapter): void {
  if (adapters.has(adapter.kind)) {
    throw new Error(`duplicate adapter kind: ${adapter.kind}`)
  }
  adapters.set(adapter.kind, adapter)
}

export function getAdapter(kind: string): SourceAdapter {
  const found = adapters.get(kind)
  if (!found) {
    const known = [...adapters.keys()].sort().join(', ') || '(空)'
    throw new Error(`unknown source kind: ${kind}；已注册的有: ${known}`)
  }
  return found
}

export function listAdapters(): SourceAdapter[] {
  return [...adapters.values()]
}

/** 仅测试使用：清空注册表，避免用例之间互相污染 */
export function __resetRegistry(): void {
  adapters.clear()
}
