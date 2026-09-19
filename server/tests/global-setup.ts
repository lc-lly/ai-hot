import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 让测试库跟上 schema。
 *
 * `prisma/test.db` 是个持久文件，没有任何机制保证它和 `schema.prisma` 同步。
 * 一旦 schema 变了而它没变，所有碰数据库的测试都会以「Invalid invocation」
 * 这类和真实原因毫无关系的报错挂掉——排查成本极高。
 *
 * 这里在每个 vitest 进程启动时跑一次 `migrate deploy`，已是最新则是秒级 no-op。
 * 用 execSync 而非 execFileSync：前者默认走 shell，在 Windows 上能正确解析 npx。
 */
export default function setup(): void {
  execSync('npx prisma migrate deploy', {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
    stdio: 'inherit',
  })
}
