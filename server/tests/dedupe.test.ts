import { describe, expect, it } from 'vitest'
import { contentHash, normalizeUrl } from '../src/pipeline/dedupe.js'

describe('normalizeUrl', () => {
  it('去掉 fragment', () => {
    expect(normalizeUrl('https://a.com/x#sec')).toBe('https://a.com/x')
  })

  it('去掉 utm 等追踪参数', () => {
    expect(normalizeUrl('https://a.com/x?utm_source=rss&utm_medium=feed')).toBe('https://a.com/x')
  })

  it('保留有意义的查询参数', () => {
    expect(normalizeUrl('https://a.com/x?p=1&utm_source=rss')).toBe('https://a.com/x?p=1')
  })

  it('查询参数排序，保证同参数不同顺序得到同一结果', () => {
    expect(normalizeUrl('https://a.com/x?b=2&a=1')).toBe(normalizeUrl('https://a.com/x?a=1&b=2'))
  })

  it('去掉 www. 前缀并统一小写域名', () => {
    expect(normalizeUrl('https://WWW.A.com/x')).toBe('https://a.com/x')
  })

  it('去掉路径末尾多余斜杠，但根路径保留', () => {
    expect(normalizeUrl('https://a.com/x/')).toBe('https://a.com/x')
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com/')
  })

  it('把 http 统一成 https', () => {
    expect(normalizeUrl('http://a.com/x')).toBe('https://a.com/x')
  })

  it('非法 URL 抛错', () => {
    expect(() => normalizeUrl('not a url')).toThrow()
  })
})

describe('contentHash', () => {
  it('同样输入得到同样结果', () => {
    expect(contentHash('标题', 'https://a.com/x')).toBe(contentHash('标题', 'https://a.com/x'))
  })

  it('标题大小写与空白差异不影响结果', () => {
    expect(contentHash('Hello  World', 'https://a.com/x')).toBe(
      contentHash('hello world', 'https://a.com/x'),
    )
  })

  it('URL 的追踪参数差异不影响结果', () => {
    expect(contentHash('t', 'https://a.com/x?utm_source=rss')).toBe(
      contentHash('t', 'https://a.com/x'),
    )
  })

  it('标题不同则哈希不同', () => {
    expect(contentHash('a', 'https://a.com/x')).not.toBe(contentHash('b', 'https://a.com/x'))
  })

  it('同名不同站点的转载不会被合并', () => {
    expect(contentHash('同一个标题', 'https://a.com/x')).not.toBe(
      contentHash('同一个标题', 'https://b.com/x'),
    )
  })

  it('输出 64 位十六进制', () => {
    expect(contentHash('t', 'https://a.com/x')).toMatch(/^[0-9a-f]{64}$/)
  })
})
