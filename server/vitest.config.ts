import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    testTimeout: 10_000,
    // 每次跑测试前把 prisma/test.db 同步到最新 schema。
    // 不做的话，schema 一改而测试库没跟上，所有数据库相关测试都会以
    // 与真实原因无关的报错挂掉。
    globalSetup: ['./tests/global-setup.ts'],
    // SQLite 单文件写锁：并行跑测试文件会互相污染并抛 SQLITE_BUSY。
    // 测试总量很小，串行跑代价可忽略。
    fileParallelism: false,
  },
})
