import { describe, expect, it } from 'vitest'
import { domain, DOMAIN_FALLBACK, DOMAIN_KEYWORDS } from '../../src/score/domain.js'

describe('domain —— 契约 §3.4 冻结口径', () => {
  it('大模型', () => {
    expect(domain('OpenAI 发布 GPT-5', null)).toBe('大模型')
    expect(domain('Claude 新版本', null)).toBe('大模型')
    expect(domain('Gemini 上线', null)).toBe('大模型')
    expect(domain('Llama 4 开源', null)).toBe('大模型')
    expect(domain('Qwen 更新', null)).toBe('大模型')
    expect(domain('DeepSeek 推理模型', null)).toBe('大模型')
    expect(domain('某大模型公司', null)).toBe('大模型')
    expect(domain('语言模型评测', null)).toBe('大模型')
    expect(domain('LLM 推理加速', null)).toBe('大模型')
  })

  it('编程工具', () => {
    expect(domain('Cursor 1.0', null)).toBe('编程工具')
    expect(domain('Copilot 免费了', null)).toBe('编程工具')
    expect(domain('新的 IDE 体验', null)).toBe('编程工具')
    expect(domain('编程助手横评', null)).toBe('编程工具')
    expect(domain('代码补全', null)).toBe('编程工具')
    expect(domain('coding agent', null)).toBe('编程工具')
    expect(domain('developer survey', null)).toBe('编程工具')
    expect(domain('编辑器插件', null)).toBe('编程工具')
  })

  it('开源', () => {
    expect(domain('GitHub 上的新项目', null)).toBe('开源')
    expect(domain('某项目开源了', null)).toBe('开源')
    expect(domain('open source alternative', null)).toBe('开源')
    expect(domain('这个 repo 值得一看', null)).toBe('开源')
    expect(domain('10k star', null)).toBe('开源')
  })

  it('硬件', () => {
    expect(domain('GPU 供货紧张', null)).toBe('硬件')
    expect(domain('国产芯片进展', null)).toBe('硬件')
    expect(domain('NVIDIA 财报', null)).toBe('硬件')
    expect(domain('算力租赁', null)).toBe('硬件')
    expect(domain('显卡价格', null)).toBe('硬件')
    expect(domain('TPU v6', null)).toBe('硬件')
  })

  it('行业', () => {
    expect(domain('某公司完成 B 轮融资', null)).toBe('行业')
    expect(domain('一笔收购', null)).toBe('行业')
    expect(domain('产品发布', null)).toBe('行业')
    expect(domain('大厂裁员', null)).toBe('行业')
    expect(domain('监管新规', null)).toBe('行业')
    expect(domain('政策解读', null)).toBe('行业')
  })

  it('全不中返回「其他」', () => {
    expect(domain('今天的天气不错', null)).toBe(DOMAIN_FALLBACK)
    expect(domain('', '')).toBe(DOMAIN_FALLBACK)
    expect(domain(null, null)).toBe(DOMAIN_FALLBACK)
    expect(domain(undefined, undefined)).toBe(DOMAIN_FALLBACK)
  })

  it('title 不中时看 summary', () => {
    expect(domain('一条新闻', '讲的是 GPU 集群')).toBe('硬件')
    expect(domain('一条新闻', '讲的是 LLM 推理加速')).toBe('大模型')
  })

  it('按表顺序取先命中的（顺序即优先级）', () => {
    // 编程工具在开源之前：GitHub Copilot 两边都命中，取编程工具
    expect(domain('GitHub Copilot 更新', null)).toBe('编程工具')
    // 大模型在最前：GPT 与 GitHub 都命中，取大模型
    expect(domain('GitHub 上的 GPT 工具', null)).toBe('大模型')
    // 硬件在开源之后：star 与 GPU 都命中，取开源
    expect(domain('GPU 项目收获 1k star', null)).toBe('开源')
  })

  it('大小写不敏感', () => {
    expect(domain('OPENAI GPT', null)).toBe('大模型')
    expect(domain('github trending', null)).toBe('开源')
    expect(domain('GPU', null)).toBe('硬件')
  })

  it('关键词表与契约 §3.4 一致', () => {
    expect(DOMAIN_KEYWORDS.map((d) => d.domain)).toEqual(['大模型', '编程工具', '开源', '硬件', '行业'])
    expect(DOMAIN_KEYWORDS[2]?.keywords).toContain('open source')
  })
})
