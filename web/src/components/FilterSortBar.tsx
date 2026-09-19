import { useEffect, useState } from 'react'
import { Hash, RotateCcw, Search, X } from 'lucide-react'
import { cn } from '../lib/cn.js'
import { KIND_LABELS } from '../lib/kinds.js'
import { Button } from './ui/Button.js'
import { Input, Select } from './ui/Field.js'
import type { Importance, ItemQuery, TopicDTO } from '../types.js'

/**
 * 六维筛选排序栏：排序 / 来源 / 重要程度 / 时间 / 真实性 / 关键词。
 *
 * ## 关键词输入为什么要本地 state + 防抖
 *
 * 直接把每次按键写进查询状态的话，打「Claude」会发出 6 个请求，
 * 而前 5 个的结果都会被丢弃。这里本地持有输入值、250ms 后才提交，
 * 提交后服务端仍有竞态守卫兜底（见 `useFeed`）。
 *
 * ## 「重置」只在真的有东西可重置时才可点
 *
 * 一个永远可点但点了没反应的按钮，比一个灰着的按钮更让人困惑。
 */

const SORT_OPTIONS = [
  { value: 'fetchedAt', label: '按抓取时间' },
  { value: 'publishedAt', label: '按发布时间' },
  { value: 'heat', label: '按热度' },
  { value: 'importance', label: '按重要程度' },
  { value: 'authenticity', label: '按可信度' },
]

const ORDER_OPTIONS = [
  { value: 'desc', label: '降序' },
  { value: 'asc', label: '升序' },
]

const TIME_OPTIONS = [
  { value: '', label: '全部时间' },
  { value: '1h', label: '近 1 小时' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
]

const IMPORTANCE_OPTIONS = [
  { value: '', label: '全部等级' },
  { value: 'urgent', label: '紧急' },
  { value: 'high', label: '重要' },
  { value: 'medium', label: '普通' },
  { value: 'low', label: '次要' },
]

const AUTHENTICITY_OPTIONS = [
  { value: '', label: '不筛真伪' },
  { value: 'real', label: '只看已核实' },
  { value: 'suspicious', label: '只看疑似虚假' },
]

export function FilterSortBar({
  query,
  onChange,
  onReset,
  topics,
  /** 当前有哪些来源种类，由调用方从已加载的数据里收集 */
  kinds,
}: {
  query: ItemQuery
  onChange: (patch: Partial<ItemQuery>) => void
  onReset: () => void
  topics: TopicDTO[]
  kinds: string[]
}) {
  const [text, setText] = useState(query.q ?? '')

  // 外部重置时把输入框也清掉，否则「重置」看起来没生效
  useEffect(() => {
    setText(query.q ?? '')
  }, [query.q])

  useEffect(() => {
    if (text === (query.q ?? '')) return
    const t = setTimeout(() => onChange({ q: text || undefined }), 250)
    return () => clearTimeout(t)
    // 只在输入变化时重排定时器；query.q 由上面那个 effect 同步进 text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const dirty =
    Boolean(query.q) ||
    (query.sort !== undefined && query.sort !== 'fetchedAt') ||
    query.order === 'asc' ||
    Boolean(query.kind) ||
    Boolean(query.importance) ||
    Boolean(query.timeRange) ||
    Boolean(query.authenticity) ||
    Boolean(query.topicId)

  const sourceOptions = [
    { value: '', label: '全部来源' },
    ...kinds.map((k) => ({ value: k, label: KIND_LABELS[k] ?? k })),
  ]

  const topicOptions = [
    { value: '', label: '全部监控词' },
    ...topics.map((t) => ({ value: t.id, label: t.name })),
  ]

  return (
    <div className="glass flex flex-wrap items-center gap-2 rounded-xl p-2.5">
      <Input
        icon={<Search className="h-3.5 w-3.5" />}
        placeholder="搜索标题、摘要、作者…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-w-[13rem] flex-1"
      />

      <Select
        value={query.sort ?? 'fetchedAt'}
        onChange={(v) => onChange({ sort: v as ItemQuery['sort'] })}
        options={SORT_OPTIONS}
        aria-label="排序字段"
        className="w-[8.5rem]"
      />

      <Select
        value={query.order ?? 'desc'}
        onChange={(v) => onChange({ order: v as 'asc' | 'desc' })}
        options={ORDER_OPTIONS}
        aria-label="排序方向"
        className="w-[5.5rem]"
      />

      <Select
        value={query.importance ?? ''}
        onChange={(v) => onChange({ importance: (v || undefined) as Importance | undefined })}
        options={IMPORTANCE_OPTIONS}
        aria-label="重要程度"
        className="w-[7rem]"
      />

      <Select
        value={query.timeRange ?? ''}
        onChange={(v) => onChange({ timeRange: (v || undefined) as ItemQuery['timeRange'] })}
        options={TIME_OPTIONS}
        aria-label="时间范围"
        className="w-[7.5rem]"
      />

      <Select
        value={query.authenticity ?? ''}
        onChange={(v) => onChange({ authenticity: (v || undefined) as ItemQuery['authenticity'] })}
        options={AUTHENTICITY_OPTIONS}
        aria-label="真实性"
        className="w-[8.5rem]"
      />

      <Select
        value={query.kind ?? ''}
        onChange={(v) => onChange({ kind: v || undefined })}
        options={sourceOptions}
        aria-label="来源"
        className="w-[8.5rem]"
      />

      {/* 有监控词时才显示这一项——没有词的时候它恒为一个空选项，纯占地方 */}
      {topics.length > 0 && (
        <Select
          value={query.topicId ?? ''}
          onChange={(v) => onChange({ topicId: v || undefined })}
          options={topicOptions}
          aria-label="监控词"
          className="w-[9rem]"
        />
      )}

      <Button
        size="sm"
        variant="ghost"
        disabled={!dirty}
        onClick={onReset}
        icon={<RotateCcw className="h-3.5 w-3.5" />}
        title={dirty ? '清空所有筛选条件' : '当前没有筛选条件'}
      >
        重置
      </Button>

      {/* 命中关键词时给一个可摘掉的提示——用户可能在别处（监控词 Tab）设过筛选 */}
      {query.topicId && (
        <span
          className={cn(
            'flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-xs text-accent-soft',
            'ring-1 ring-accent/20',
          )}
        >
          <Hash className="h-3 w-3" />
          {topics.find((t) => t.id === query.topicId)?.name ?? '监控词'}
          <button
            onClick={() => onChange({ topicId: undefined })}
            className="cursor-pointer text-accent-soft/70 hover:text-accent-soft"
            aria-label="取消监控词筛选"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  )
}
