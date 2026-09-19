import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env.js'

describe('loadEnv', () => {
  it('空环境下给出全部默认值', () => {
    const env = loadEnv({})
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(8787)
    expect(env.DATABASE_URL).toBe('file:./dev.db')
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com')
    expect(env.AI_MOCK).toBe(false)
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('PORT 从字符串转成数字', () => {
    expect(loadEnv({ PORT: '9000' }).PORT).toBe(9000)
  })

  it('PORT 非数字时报错', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/PORT/)
  })

  it('AI_MOCK 只在 1/true 时为 true，字符串 "false" 不算真', () => {
    expect(loadEnv({ AI_MOCK: '1' }).AI_MOCK).toBe(true)
    expect(loadEnv({ AI_MOCK: 'true' }).AI_MOCK).toBe(true)
    expect(loadEnv({ AI_MOCK: 'false' }).AI_MOCK).toBe(false)
    expect(loadEnv({ AI_MOCK: '0' }).AI_MOCK).toBe(false)
  })

  it('非法 NODE_ENV 报错', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/)
  })

  it('DEEPSEEK_API_KEY 为空字符串时视为未设置', () => {
    expect(loadEnv({ DEEPSEEK_API_KEY: '' }).DEEPSEEK_API_KEY).toBeUndefined()
    expect(loadEnv({ DEEPSEEK_API_KEY: '   ' }).DEEPSEEK_API_KEY).toBeUndefined()
    expect(loadEnv({ DEEPSEEK_API_KEY: 'sk-abc' }).DEEPSEEK_API_KEY).toBe('sk-abc')
  })
})
