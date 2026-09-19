/**
 * 评分模块的公开面。
 *
 * 全是纯函数：无 Express、无 Prisma、无 IO。
 * 契约 §5 规定 `server/src/score/**` 属于阶段 3 评分。
 */
export { clamp01, digitsFrom, heat, parseRawObject, rawHeat, HEAT_BASES, HEAT_FALLBACK } from './heat.js'
export { domain, DOMAINS, DOMAIN_FALLBACK, DOMAIN_KEYWORDS } from './domain.js'
export { parseFlags, toAiState, toItemDTO } from './dto.js'
export type { ItemRowInput } from './dto.js'
export { AI_FLAGS, AI_STATES } from './types.js'
export type { AiState, ItemDTO } from './types.js'
