import { Router } from 'express'
import type { PrismaClient } from '@prisma/client'
import { HttpError } from '../errors.js'
import { ingestSource } from '../pipeline/ingest.js'
import { broadcast, log } from '../realtime/index.js'
import { getAdapter, listAdapters } from '../sources/registry.js'

/** 采集结果 → 一条 fetch 日志 + 一次 source 健康广播。 */
function reportCollect(
  source: { id: string; name: string; kind: string },
  outcome: { ok: boolean; detail: string; lastError?: string | null },
): void {
  log({
    channel: 'fetch',
    level: outcome.ok ? 'info' : 'error',
    message: `${source.name}（${source.kind}）: ${outcome.detail}`,
    meta: { sourceId: source.id, ok: outcome.ok },
  })
  broadcast('source', {
    id: source.id,
    name: source.name,
    kind: source.kind,
    lastOk: outcome.ok,
    lastRunAt: new Date().toISOString(),
    lastError: outcome.lastError ?? null,
  })
}

export function sourceRoutes(deps: { prisma: PrismaClient }): Router {
  const router = Router()

  router.get('/sources', async (_req, res) => {
    const rows = await deps.prisma.source.findMany({ orderBy: { createdAt: 'asc' } })
    res.json({
      adapters: listAdapters().map((a) => a.kind),
      sources: rows.map((s) => ({ ...s, config: JSON.parse(s.config || '{}') })),
    })
  })

  router.post('/sources', async (req, res) => {
    const body = req.body as { kind?: unknown; name?: unknown; config?: unknown }
    if (typeof body.kind !== 'string' || typeof body.name !== 'string') {
      throw new HttpError(400, 'BAD_REQUEST', 'kind 与 name 必填')
    }
    try {
      getAdapter(body.kind)
    } catch (e) {
      throw new HttpError(400, 'UNKNOWN_SOURCE_KIND', e instanceof Error ? e.message : String(e))
    }
    const created = await deps.prisma.source.create({
      data: {
        kind: body.kind,
        name: body.name,
        config: JSON.stringify(body.config ?? {}),
      },
    })
    res.status(201).json({ ...created, config: JSON.parse(created.config) })
  })

  router.post('/sources/:id/collect', async (req, res) => {
    const id = req.params.id as string
    const source = await deps.prisma.source.findUnique({ where: { id } })
    if (!source) throw new HttpError(404, 'NOT_FOUND', `数据源不存在: ${id}`)

    const adapter = getAdapter(source.kind)
    const startedAt = Date.now()
    try {
      const result = await ingestSource(deps.prisma, adapter, source, {
        fetch: globalThis.fetch,
        now: new Date(),
      })
      await deps.prisma.source.update({
        where: { id },
        data: { lastRunAt: new Date(), lastOk: true, lastError: null },
      })
      reportCollect(source, {
        ok: true,
        detail: `抓到 ${result.fetched} 条，新增 ${result.inserted}，重复 ${result.skippedDuplicate}`,
      })
      res.json({ ...result, elapsedMs: Date.now() - startedAt })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await deps.prisma.source.update({
        where: { id },
        data: { lastRunAt: new Date(), lastOk: false, lastError: message },
      })
      reportCollect(source, { ok: false, detail: `采集失败：${message}`, lastError: message })
      throw new HttpError(502, 'SOURCE_FAILED', message)
    }
  })

  router.get('/sources/health', async (_req, res) => {
    const rows = await deps.prisma.source.findMany({ where: { enabled: true } })
    const results = await Promise.all(
      rows.map(async (s) => {
        try {
          const adapter = getAdapter(s.kind)
          const parsed = JSON.parse(s.config || '{}') as Record<string, unknown>
          const health = await adapter.health({
            sourceId: s.id,
            config: parsed,
            fetch: globalThis.fetch,
            now: new Date(),
          })
          return { id: s.id, name: s.name, kind: s.kind, ...health }
        } catch (e) {
          return {
            id: s.id,
            name: s.name,
            kind: s.kind,
            ok: false,
            detail: e instanceof Error ? e.message : String(e),
          }
        }
      }),
    )
    res.json({ results })
  })

  return router
}
