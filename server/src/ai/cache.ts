import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { CACHE_TTL_MS } from './budget.js'

export interface PromptDescriptor {
  purpose: string
  model: string
  messages: ReadonlyArray<{ role: string; content: string }>
  temperature: number
}

/**
 * prompt 哈希 = 模型 + 用途 + 温度 + 全部消息内容的 SHA-256。
 *
 * 只哈希**语义输入**，不掺时间戳或调用 id——否则同一份输入每次都是新键，
 * 缓存永远不命中，等于没做（spec §4.4 的一半成本控制就废了）。
 */
export function promptHashOf(descriptor: PromptDescriptor): string {
  const canonical = JSON.stringify({
    purpose: descriptor.purpose,
    model: descriptor.model,
    temperature: descriptor.temperature,
    messages: descriptor.messages.map((m) => [m.role, m.content]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export interface CachedResponse {
  response: string
  createdAt: Date
}

export async function readCache(
  prisma: PrismaClient,
  promptHash: string,
  now: Date,
): Promise<CachedResponse | null> {
  const row = await prisma.aiCache.findUnique({ where: { promptHash } })
  if (!row) return null
  if (row.expiresAt.getTime() <= now.getTime()) {
    // 过期即删。留在表里既占空间，也会让 `expiresAt` 索引失去意义。
    await prisma.aiCache.deleteMany({ where: { promptHash } })
    return null
  }
  return { response: row.response, createdAt: row.createdAt }
}

export async function writeCache(
  prisma: PrismaClient,
  promptHash: string,
  purpose: string,
  response: string,
  now: Date,
): Promise<void> {
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS)
  await prisma.aiCache.upsert({
    where: { promptHash },
    create: { promptHash, purpose, response, createdAt: now, expiresAt },
    update: { response, expiresAt },
  })
}

/** 清理过期缓存，供阶段 5 的 cleanup 任务调用。 */
export async function purgeExpiredCache(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const res = await prisma.aiCache.deleteMany({ where: { expiresAt: { lte: now } } })
  return res.count
}
