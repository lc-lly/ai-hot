import { describe, expect, it } from 'vitest'
import { stripHtml, stripInlineTags, truncate } from '../src/util/text.js'

describe('stripHtml', () => {
  it('去掉标签只留文本', () => {
    expect(stripHtml('<p>你好 <b>世界</b></p>')).toBe('你好 世界')
  })

  it('解码常见实体', () => {
    expect(stripHtml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe('a & b <c> "d" \'e\'')
  })

  it('把连续空白压成单个空格', () => {
    expect(stripHtml('a\n\n   b\t\tc')).toBe('a b c')
  })

  it('去首尾空白', () => {
    expect(stripHtml('  <p>x</p>  ')).toBe('x')
  })
})

describe('stripInlineTags', () => {
  it('删掉行内标签但不补空格 —— 这正是与 stripHtml 的区别', () => {
    // 同一条输入喂给 stripHtml 会得到「AI 大模型 零基础」，把词切开了。
    // 搜索引擎的高亮标记包在词中间，补空格是错的。
    const highlighted = '【全748集】AI<em class="keyword">大模型</em>零基础全套教程'
    expect(stripInlineTags(highlighted)).toBe('【全748集】AI大模型零基础全套教程')
    expect(stripHtml(highlighted)).toBe('【全748集】AI 大模型 零基础全套教程')
  })

  it('块级标签也一并删掉（用 stripInlineTags 的场景里不该有块级标签）', () => {
    expect(stripInlineTags('<b>a</b><span class="x">b</span>')).toBe('ab')
  })

  it('不解码实体 —— JSON 接口给的是字面量，没有转义', () => {
    // 需要解码的场景（RSS、抓来的 HTML）走 stripHtml
    expect(stripInlineTags('a &amp; b')).toBe('a &amp; b')
    expect(stripHtml('a &amp; b')).toBe('a & b')
  })

  it('不压缩空白、不去首尾 —— 那是调用方的事', () => {
    expect(stripInlineTags('  a   b  ')).toBe('  a   b  ')
  })

  it('裸 < 不是标签，原样保留', () => {
    // `a < b` 里的 < 没有紧跟字母，不该被当成标签吃掉
    expect(stripInlineTags('a < b')).toBe('a < b')
  })

  it('没有标签时是恒等变换', () => {
    expect(stripInlineTags('普通文本')).toBe('普通文本')
  })
})

describe('truncate', () => {
  it('短于上限时原样返回', () => {
    expect(truncate('abc', 5)).toBe('abc')
  })

  it('超长时截断并加省略号', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcde…')
  })
})
