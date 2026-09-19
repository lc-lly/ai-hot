import { describe, expect, it } from 'vitest'
import { mapLimit } from '../src/util/concurrency.js'

describe('mapLimit', () => {
  it('保持输入顺序', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => n * 10)
    expect(out).toEqual([30, 10, 20])
  })

  it('并发数不超过 limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return null
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('空数组直接返回空数组', async () => {
    expect(await mapLimit([], 4, async (n: number) => n)).toEqual([])
  })

  it('limit 小于 1 时报错', async () => {
    await expect(mapLimit([1], 0, async (n) => n)).rejects.toThrow(/limit/)
  })
})
