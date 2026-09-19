import { describe, expect, it } from 'vitest'
import {
  normalizeTitle,
  normalizeUrlKey,
  registrableDomain,
  titleKey,
  tokenize,
} from '../../src/cluster/normalize.js'
import { dice, diceOfTokens } from '../../src/cluster/similarity.js'

describe('normalizeTitle', () => {
  it('全角字母 / 括号经 NFKC 收敛到半角', () => {
    expect(normalizeTitle('ＡＩ（大模型）发布')).toBe('ai 大模型 发布')
  })

  it('去标点、压空白、转小写', () => {
    expect(normalizeTitle('  OpenAI   Ships   GPT-6!!  ')).toBe('openai ships gpt 6')
  })

  it('剥掉 HTML 与 URL', () => {
    expect(normalizeTitle('<b>Hello</b> https://example.com/x World')).toBe('hello world')
  })

  it('非字符串输入退化为空串，不抛', () => {
    expect(normalizeTitle(null)).toBe('')
    expect(normalizeTitle(undefined)).toBe('')
  })
})

describe('tokenize', () => {
  it('拉丁词按空格切，去掉停用词', () => {
    expect(tokenize('the state of ai coding')).toEqual(['state', 'ai', 'coding'])
  })

  it('保留「短但关键」的拉丁词（长度 >= 2）', () => {
    expect(tokenize('ai llm ide')).toEqual(['ai', 'llm', 'ide'])
  })

  it('中文按 bigram 切，丢弃单字段', () => {
    // 「大模型发布」→ 大模 / 模型 / 型发 / 发布
    expect(tokenize('大模型发布')).toEqual(['大模', '模型', '型发', '发布'])
  })

  it('单字中文段被丢弃（噪声）', () => {
    expect(tokenize('新 大模型')).toEqual(['大模', '模型'])
  })

  it('中英混排各自成词', () => {
    expect(tokenize('ai编程')).toEqual(['ai', '编程'])
  })

  it('结果去重且确定', () => {
    expect(tokenize('ai ai ai')).toEqual(['ai'])
    // 两个独立的「模型」词各出一个 bigram，去重后只剩一个
    expect(tokenize('模型 模型')).toEqual(['模型'])
  })
})

describe('registrableDomain', () => {
  it('去掉 www 与子域', () => {
    expect(registrableDomain('https://news.ycombinator.com/item?id=1')).toBe('ycombinator.com')
    expect(registrableDomain('https://www.theverge.com/x')).toBe('theverge.com')
  })

  it('处理二级后缀', () => {
    expect(registrableDomain('https://news.bbc.co.uk/a')).toBe('bbc.co.uk')
    expect(registrableDomain('https://tech.sina.com.cn/a')).toBe('sina.com.cn')
  })

  it('非法 URL 返回空串（调用方据此跳过域名比对）', () => {
    expect(registrableDomain('not a url')).toBe('')
    expect(registrableDomain('')).toBe('')
  })

  it('IP 原样返回', () => {
    expect(registrableDomain('http://192.168.1.1/a')).toBe('192.168.1.1')
  })
})

describe('normalizeUrlKey', () => {
  it('忽略 hash、末尾斜杠与协议差异', () => {
    expect(normalizeUrlKey('http://Example.com/a/#frag')).toBe(normalizeUrlKey('https://example.com/a'))
  })

  it('非法 URL 返回空串', () => {
    expect(normalizeUrlKey('::::')).toBe('')
  })
})

describe('dice', () => {
  it('完全相同为 1', () => {
    expect(dice(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
  })

  it('完全不相交为 0', () => {
    expect(dice(new Set(['a']), new Set(['b']))).toBe(0)
  })

  it('空集为 0（没有证据不算相似）', () => {
    expect(dice(new Set(), new Set(['a']))).toBe(0)
    expect(dice(new Set(), new Set())).toBe(0)
  })

  it('长标题只稀释一次：Dice 而不是 Jaccard', () => {
    // A={a,b,c} B={a,b,c,d,e} → 2*3/(3+5)=0.75（Jaccard 只有 0.6）
    expect(diceOfTokens(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e'])).toBe(0.75)
  })

  it('对 token 顺序不敏感', () => {
    expect(diceOfTokens(['a', 'b'], ['b', 'a'])).toBe(1)
  })
})

describe('titleKey', () => {
  it('同一标题的不同写法得到同一个 key', () => {
    expect(titleKey('OpenAI Ships GPT-6')).toBe(titleKey('openai  ships  gpt-6 '))
  })
})
