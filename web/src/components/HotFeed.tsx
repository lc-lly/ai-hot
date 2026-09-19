import { Inbox, SearchX } from 'lucide-react'
import { cn } from '../lib/cn.js'
import type { FeedState } from '../state/useFeed.js'
import type { TopicDTO } from '../types.js'
import { HotspotCard, CardSkeletonRow } from './HotspotCard.js'
import { Button } from './ui/Button.js'
import { Empty } from './ui/Empty.js'
import { Pagination } from './ui/Pagination.js'

/**
 * 热点卡片流 + 分页。
 *
 * ## 空态必须区分「库里就没有」和「筛选筛没了」
 *
 * 这两种情况给用户的下一步动作完全不同：前者要他去点「立即扫描」，
 * 后者要他去改筛选条件。统一显示「暂无数据」等于什么都没说。
 */
export function HotFeed({
  feed,
  topics,
  onScan,
}: {
  feed: FeedState
  topics: TopicDTO[]
  onScan: () => void
}) {
  const { items, pagination, initialLoading, loading, error } = feed

  if (initialLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <CardSkeletonRow key={i} />
        ))}
      </div>
    )
  }

  if (error && items.length === 0) {
    return (
      <Empty
        icon={<SearchX className="h-5 w-5" />}
        title="加载失败"
        hint={error}
        action={<Button onClick={() => feed.refresh()}>重试</Button>}
      />
    )
  }

  const filtered = Boolean(
    feed.query.q ||
      feed.query.kind ||
      feed.query.importance ||
      feed.query.timeRange ||
      feed.query.authenticity ||
      feed.query.topicId,
  )

  if (items.length === 0) {
    return filtered ? (
      <Empty
        icon={<SearchX className="h-5 w-5" />}
        title="没有符合条件的条目"
        hint="当前的筛选条件比较严格。试试放宽时间范围，或点「重置」清空所有条件。"
        action={<Button onClick={feed.resetFilters}>重置筛选</Button>}
      />
    ) : (
      <Empty
        icon={<Inbox className="h-5 w-5" />}
        title="还没有任何热点"
        hint="点右上角的「立即扫描」抓一批。首次采集要跑几十秒，之后每 15 分钟会自动更新。"
        action={
          <Button variant="primary" onClick={onScan}>
            立即扫描
          </Button>
        }
      />
    )
  }

  const matchedTopic = feed.query.topicId
    ? topics.find((t) => t.id === feed.query.topicId)
    : undefined

  return (
    <div className="space-y-3">
      {/* 刷新中给一条细进度线，而不是把列表换掉 */}
      <div className={cn('h-0.5 rounded-full transition-opacity', loading ? 'bg-accent/40' : 'opacity-0')} />

      {matchedTopic && (
        <p className="text-xs text-zinc-500">
          显示命中「{matchedTopic.name}」的条目 · 共 {pagination.total} 条
        </p>
      )}

      {/* 没有 `index`，也没有错峰入场：卡片立即出现。理由见 `HotspotCard.tsx` */}
      {items.map((item) => (
        <HotspotCard key={item.id} item={item} />
      ))}

      <Pagination
        page={pagination.page}
        totalPages={pagination.totalPages}
        total={pagination.total}
        disabled={loading}
        onChange={feed.setPage}
      />
    </div>
  )
}
