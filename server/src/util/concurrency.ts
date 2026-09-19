/**
 * 按固定并发上限执行异步映射，结果顺序与输入一致。
 * 单个任务抛错会整体 reject（采集场景下由调用方决定是否吞掉）。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit 必须是 >= 1 的整数，收到: ${limit}`)
  }
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item, index)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}
