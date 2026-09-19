import { describe, expect, it } from 'vitest'
import { createPrisma } from '../src/db.js'

describe('createPrisma', () => {
  /**
   * 这条原本断言 `setting.count() === 0`——即「整个测试库是空的」。
   * 那是个脆弱的断言：只要任何别的测试往 Setting 写一行（阶段 5 的
   * discover 领域默认值就会），它就塌，而报错信息完全指不到真正的原因。
   *
   * 改成自包含的读写往返：既真的验证了连接可用，又只依赖自己写入的数据。
   * 用唯一 key，避免与其它测试并行时的相互干扰。
   */
  it('能连上数据库并读写', async () => {
    const prisma = createPrisma('file:./test.db')
    const key = `__db_test_${process.hrtime.bigint().toString()}`

    await prisma.setting.create({ data: { key, value: 'ok' } })
    const row = await prisma.setting.findUnique({ where: { key } })
    expect(row?.value).toBe('ok')

    await prisma.setting.delete({ where: { key } })
    expect(await prisma.setting.findUnique({ where: { key } })).toBeNull()

    await prisma.$disconnect()
  })
})
