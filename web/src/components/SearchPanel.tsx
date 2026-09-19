import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Database, Globe, Search, SearchX } from 'lucide-react'
import { cn } from '../lib/cn.js'
import { KIND_LABELS, SOURCE_KINDS } from '../lib/kinds.js'
import type { FeedState } from '../state/useFeed.js'
import { searchExternal, type ExternalSearchResult, type SearchSourceReport } from '../net/api.js'
import type { ItemDTO } from '../types.js'
import { CardSkeletonRow, HotspotCard } from './HotspotCard.js'
import { Button } from './ui/Button.js'
import { GlassCard } from './ui/Card.js'
import { Empty } from './ui/Empty.js'
import { Input, Select } from './ui/Field.js'
import { Pagination } from './ui/Pagination.js'

const SORT_OPTIONS = [
  { value: 'fetchedAt', label: '按抓取时间' },
  { value: 'heat', label: '按热度' },
  { value: 'importance', label: '按重要程度' },
]

/**
 * 搜索范围。
 *
 * 这两件事在用户脑子里是**同一个问题**（「有没有关于 X 的东西」），
 * 但技术上完全不同，所以值得用一个显式的开关而不是自动合并：
 *
 * - `local`：库里已经抓到的内容。快（毫秒级）、每条都带热度和 AI 的真伪判定。
 *   搜不到，可能只是**我们还没抓到**。
 * - `web`：站外此刻的结果（HN Algolia / Reddit / GitHub）。慢（秒级）、
 *   没有 AI 结论——它们从来没被评过。
 *
 * 自动合并看起来更贴心，实际更糟：用户会分不清「这条没有真伪徽章」
 * 是因为 AI 觉得没问题，还是因为它是刚搜来的。
 */
type Scope = 'local' | 'web'

const SEARCH_KINDS = SOURCE_KINDS.filter((k) => k.group === 'search')

export function SearchPanel({
  feed,
  collectedTotal,
}: {
  feed: FeedState
  /** 库里已抓取的条目总数，用来解释本地搜索的覆盖范围 */
  collectedTotal: number | null
}) {
  const [text, setText] = useState('')
  const [scope, setScope] = useState<Scope>('local')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const submitted = feed.query.q ?? ''
  const hasSearched = submitted !== ''

  // 站外搜索有自己的状态：它不是「筛选」，不该塞进 useFeed 的查询对象里
  // （那会让它跟着分页、筛选一起被重置）。
  const [web, setWeb] = useState<ExternalSearchResult | null>(null)
  const [webLoading, setWebLoading] = useState(false)
  const [webError, setWebError] = useState<string | null>(null)
  const webSeq = useRef(0)

  // 切到这个 Tab 时自动聚焦：用户来这里就是为了打字
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const runWebSearch = useCallback(async (q: string) => {
    const seq = webSeq.current + 1
    webSeq.current = seq
    setWebLoading(true)
    try {
      const result = await searchExternal(q)
      // 竞态守卫：连按两次回车时，只让最后一次的结果落地
      if (seq !== webSeq.current) return
      setWeb(result)
      setWebError(null)
    } catch (e) {
      if (seq !== webSeq.current) return
      setWeb(null)
      setWebError(e instanceof Error ? e.message : '站外搜索失败')
    } finally {
      if (seq === webSeq.current) setWebLoading(false)
    }
  }, [])

  const submit = () => {
    const q = text.trim()
    if (q === '') return
    if (scope === 'web') {
      // 站外搜索不经过 useFeed：它没有分页，也不该被筛选栏影响。
      // 同步一份到 feed.query 只是为了「按关键词筛」那类跳转能带上词。
      void runWebSearch(q)
    }
    feed.setFilters({ q: q || undefined })
  }

  const switchScope = (next: Scope) => {
    if (next === scope) return
    setScope(next)
    const q = text.trim() || submitted
    if (next === 'web' && q !== '') void runWebSearch(q)
  }

  return (
    <div className="space-y-4">
      <GlassCard className="p-3">
        <div className="mb-2.5 flex items-center gap-1 rounded-lg bg-white/[0.03] p-0.5 text-xs">
          <ScopeTab
            active={scope === 'local'}
            onClick={() => switchScope('local')}
            icon={<Database className="h-3.5 w-3.5" />}
            label="站内检索"
            hint="已抓到的内容，带 AI 结论"
          />
          <ScopeTab
            active={scope === 'web'}
            onClick={() => switchScope('web')}
            icon={<Globe className="h-3.5 w-3.5" />}
            label="站外搜索"
            hint="Hacker News / Reddit / GitHub 的实时结果"
          />
        </div>

        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            icon={<Search className="h-4 w-4" />}
            placeholder={
              scope === 'local'
                ? '搜索标题、摘要、作者…（回车开始）'
                : '搜索全网…（回车开始，约 2–5 秒）'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            loading={scope === 'web' ? webLoading : feed.loading && hasSearched}
            className="flex-1"
          />
          {scope === 'local' && (
            <Select
              value={feed.query.sort ?? 'fetchedAt'}
              onChange={(v) => feed.setFilters({ sort: v as FeedState['query']['sort'] })}
              options={SORT_OPTIONS}
              aria-label="排序"
              className="w-[9rem] shrink-0"
            />
          )}
          <Button variant="primary" onClick={submit} className="shrink-0" disabled={webLoading}>
            {webLoading ? '搜索中…' : '搜索'}
          </Button>
        </div>

        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
          {scope === 'local' ? (
            <>
              <Database className="h-3 w-3 shrink-0" />
              <span>
                在已抓取的 <span className="tabular text-zinc-400">{collectedTotal ?? '—'}</span>{' '}
                条内容里检索，每条都带热度和 AI 的真伪判定。
              </span>
              <span className="text-zinc-600">
                搜不到某个词，可能只是我们还没抓到它——切到「站外搜索」试试。
              </span>
            </>
          ) : (
            <>
              <Globe className="h-3 w-3 shrink-0" />
              <span>直接检索 HN Algolia、Reddit 和 GitHub，不限于我们抓过的内容。</span>
              <span className="text-zinc-600">
                这些结果是临时的，没有真伪判定——AI 从没评过它们。
              </span>
            </>
          )}
        </p>
      </GlassCard>

      {scope === 'web' ? (
        <WebResults
          query={submitted}
          result={web}
          loading={webLoading}
          error={webError}
          onRetry={() => void runWebSearch(submitted)}
        />
      ) : (
        <LocalResults feed={feed} submitted={submitted} collectedTotal={collectedTotal} />
      )}
    </div>
  )
}

function ScopeTab({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 transition',
        active
          ? 'bg-accent/15 text-accent-soft shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_30%,transparent)]'
          : 'text-zinc-500 hover:text-zinc-300',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function LocalResults({
  feed,
  submitted,
  collectedTotal,
}: {
  feed: FeedState
  submitted: string
  collectedTotal: number | null
}) {
  if (submitted === '') {
    return (
      <Empty
        icon={<Search className="h-5 w-5" />}
        title="输入关键词开始搜索"
        hint={
          collectedTotal === null
            ? '搜到的条目会带上热度、重要程度和 AI 的真伪判定。'
            : `库里已有 ${collectedTotal} 条内容可以直接搜，每条都带热度和 AI 结论——这是站外搜索给不了的。`
        }
      />
    )
  }

  if (feed.initialLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <CardSkeletonRow key={i} />
        ))}
      </div>
    )
  }

  if (feed.items.length === 0) {
    return (
      <Empty
        icon={<SearchX className="h-5 w-5" />}
        title={`没有找到「${submitted}」`}
        hint={
          feed.error
            ? feed.error
            : '可能只是还没有抓到相关内容。换成「站外搜索」能查到我们从没抓过的条目，或者去「监控词」把它加进去，之后抓到了会主动通知你。'
        }
      />
    )
  }

  return (
    <>
      <p className={cn('text-xs text-zinc-500', feed.loading && 'opacity-60')}>
        找到 <span className="tabular text-zinc-300">{feed.pagination.total}</span> 条与「
        {submitted}」相关的内容
      </p>

      <div className="space-y-2.5">
        {feed.items.map((item) => (
          // 搜索结果用轻量卡片：用户是在扫列表找东西，不是在读文章。
          // 摘要与 AI 理由留在正文里，列表里只给辨识度最高的几项。
          <HotspotCard key={item.id} item={item} variant="light" />
        ))}
      </div>

      <Pagination
        page={feed.pagination.page}
        totalPages={feed.pagination.totalPages}
        total={feed.pagination.total}
        disabled={feed.loading}
        onChange={feed.setPage}
      />
    </>
  )
}

function WebResults({
  query,
  result,
  loading,
  error,
  onRetry,
}: {
  query: string
  result: ExternalSearchResult | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  if (query === '') {
    return (
      <Empty
        icon={<Globe className="h-5 w-5" />}
        title="搜索站外内容"
        hint={`同时检索 ${SEARCH_KINDS.map((k) => k.label).join(' / ')}。这些是此刻的真实结果，不是我们抓过的存档。`}
      />
    )
  }

  if (loading && result === null) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <CardSkeletonRow key={i} />
        ))}
      </div>
    )
  }

  if (error !== null) {
    return (
      <Empty
        icon={<AlertTriangle className="h-5 w-5" />}
        title="站外搜索失败"
        hint={`${error}。站外接口有限流，稍等一会儿再试。`}
        action={
          <Button variant="ghost" onClick={onRetry}>
            重试
          </Button>
        }
      />
    )
  }

  if (result === null || result.items.length === 0) {
    return (
      <Empty
        icon={<SearchX className="h-5 w-5" />}
        title={`站外没有找到「${query}」`}
        hint="换个更短的关键词试试。空结果也可能来自某个源被限流——看下面的源状态。"
      />
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">
          从站外找到 <span className="tabular text-zinc-300">{result.items.length}</span> 条
          {result.cached && <span className="ml-1 text-zinc-600">（60 秒内缓存）</span>}
        </p>
        <SourceStatusList sources={result.sources} />
      </div>

      <div className="space-y-2.5">
        {result.items.map((item: ItemDTO) => (
          <HotspotCard key={item.id} item={item} variant="light" />
        ))}
      </div>
    </>
  )
}

/**
 * 每个源的状态。
 *
 * **必须有**：某个源被限流时，结果会静默少掉三分之一。用户看到 8 条
 * 不会意识到「Reddit 那 20 条其实没查到」——他会以为全网只有 8 条。
 */
function SourceStatusList({ sources }: { sources: SearchSourceReport[] }) {
  if (sources.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sources.map((s) => (
        <span
          key={s.kind}
          // 被阈值挡掉的条数只写在 tooltip 里，不占徽章位置。
          // 但**必须写**：不写的话用户看到 B站 只有 5 条，会以为
          // 「B站上就这么多」，而事实是另外 15 条因为互动量低被过滤了。
          title={
            s.error ??
            `${s.count} 条 / ${s.ms}ms` +
              (s.filtered > 0 ? `；另有 ${s.filtered} 条互动量未达标已过滤` : '')
          }
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px]',
            s.ok ? 'bg-white/[0.04] text-zinc-500' : 'bg-fake/10 text-fake',
          )}
        >
          {KIND_LABELS[s.kind] ?? s.kind}
          {s.ok ? ` ${s.count}` : ' 失败'}
        </span>
      ))}
    </div>
  )
}
