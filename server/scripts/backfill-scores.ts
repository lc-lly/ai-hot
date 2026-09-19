/**
 * 回填物化列：`heatScore` / `domain` / `importance`。
 *
 * 这三个列是为了让「按热度排序」「按领域筛选」「按等级筛选」变成普通 SQL
 * 而物化的（见 `prisma/schema.prisma` 的 HotItem 注释）。新增条目会在
 * `pipeline/ingest.ts` 的 `persistItems` 里自动填，**存量条目需要跑这个脚本**。
 *
 * 什么时候需要重跑：
 *   - 拉到过旧数据（比如从别处复制了一份 dev.db）
 *   - `score/heat.ts` / `domain.ts` / `importance.ts` 的口径改了
 *
 * 用法：
 *   cd server && npx tsx scripts/backfill-scores.ts
 *   cd server && npx tsx scripts/backfill-scores.ts --dry   # 只看会改多少条
 *
 * 幂等：重复跑结果一样，只更新值真的变了的行。
 */
import { createPrisma } from '../src/db.js'
import { domain as domainOf } from '../src/score/domain.js'
import { heat as heatOf } from '../src/score/heat.js'
import { IMPORTANCE_RANK, importanceOf } from '../src/score/importance.js'

const dry = process.argv.includes('--dry')

async function main(): Promise<void> {
  // 与 index.ts 一致：先尝试加载 .env，没有也算正常
  try {
    process.loadEnvFile()
  } catch {
    /* 没有 .env 是合法情况 */
  }

  const url = process.env.DATABASE_URL ?? 'file:./dev.db'
  const prisma = createPrisma(url)

  try {
    const rows = await prisma.hotItem.findMany({
      select: {
        id: true,
        title: true,
        summary: true,
        raw: true,
        heatScore: true,
        domain: true,
        importance: true,
        importanceRank: true,
        aiFlags: true,
        source: { select: { kind: true } },
      },
    })

    console.log(`[backfill] 共 ${rows.length} 条`)

    let changed = 0
    for (const row of rows) {
      const kind = row.source?.kind ?? null
      const heat = heatOf(kind, row.raw)
      const dom = domainOf(row.title, row.summary)

      let flags: string[] = []
      try {
        const parsed: unknown = JSON.parse(row.aiFlags)
        if (Array.isArray(parsed)) flags = parsed.filter((f): f is string => typeof f === 'string')
      } catch {
        /* 脏数据当没有 flags */
      }
      const imp = importanceOf({ heat, flags })
      const rank = IMPORTANCE_RANK[imp]

      if (
        row.heatScore === heat &&
        row.domain === dom &&
        row.importance === imp &&
        row.importanceRank === rank
      ) {
        continue
      }

      changed += 1
      if (dry) continue

      await prisma.hotItem.update({
        where: { id: row.id },
        data: { heatScore: heat, domain: dom, importance: imp, importanceRank: rank },
      })
    }

    console.log(`[backfill] ${dry ? '待更新' : '已更新'} ${changed} 条，其余无需改动`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e: unknown) => {
  console.error('[backfill] 失败：', e)
  process.exit(1)
})
