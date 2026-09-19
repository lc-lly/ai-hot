import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppHeader } from './components/AppHeader.js'
import { FilterSortBar } from './components/FilterSortBar.js'
import { HotFeed } from './components/HotFeed.js'
import { KeywordPanel } from './components/KeywordPanel.js'
import { LiveTicker } from './components/LiveTicker.js'
import { SearchPanel } from './components/SearchPanel.js'
import { StatCards } from './components/StatCards.js'
import { TabNav, type TabKey } from './components/TabNav.js'
import { Backdrop } from './components/ui/Backdrop.js'
import { ToastStack } from './components/ui/Toast.js'
import { useKeyboard } from './hooks/useKeyboard.js'
import { FEED_KINDS } from './lib/kinds.js'
import { useDashboard } from './state/useDashboard.js'
import { useFeed } from './state/useFeed.js'

/**
 * 页面骨架。
 *
 * ## 布局与旧版的根本差别
 *
 * 旧版是**单屏不滚动**（根元素 `overflow:hidden`），所有内容都在一屏里
 * 挤，靠 canvas 雷达盘和终端日志流填满空白。新版是**常规滚动页面**：
 * 顶栏吸顶、Tab 切页、下方是内容区，长什么样由内容决定。
 *
 * ## 为什么搜索页是「懒挂载 + 隐藏」而不是条件渲染
 *
 * 条件渲染的话，每次切回搜索页 `useFeed` 都会重建，用户刚搜的词、
 * 翻到的第 3 页全部丢失。但直接挂载又会在首屏白拉一次 `/api/items`
 * （搜索页在用户点进去之前完全用不上）。
 * 所以：第一次进搜索 Tab 时挂载，之后只是 `display:none` 藏起来。
 *
 * ## 雷达页为什么是常驻挂载（两个 Tab 的理由不一样）
 *
 * 搜索页常驻是为了**保住状态**，雷达页常驻是为了**别让动画重播**。
 *
 * 雷达页原本写的是 `{tab === 'radar' && ...}`。条件渲染意味着每从别的
 * Tab 切回来一次，整棵子树就重新挂载一次，`StatCards` 上那四张卡的
 * `fade-up` 入场动画（带 40ms 错峰）也就在每次挂载时重放一遍——表现
 * 就是「从监控词切回热点雷达时页面会抖」。
 *
 * 但**光改成常驻挂载解决不了**：从 `display:none` 切回可见时，Chrome
 * 会把元素身上还没摘掉的 CSS 动画从头重跑（实测：切回雷达页后 250ms
 * 录到 4 次 `animationstart: fade-up`，间隔正是 0/40/80ms）。真正的
 * 修复是 `StatCards` 里那个「放完就摘掉 class」，见该组件。
 *
 * 常驻挂载是那条修复的**前提**：组件一旦重新挂载，它那个 once 状态就
 * 归零，动画会再放一次。所以这两处改动是一体的，不能只回退其中一处。
 *
 * 顺带一提，常驻挂载本身没有代价：雷达页的筛选状态本来就存在 App 这
 * 一层（`dashboard.feed`），不靠组件活着来保存。
 */
export default function App() {
  const dashboard = useDashboard()
  const [tab, setTab] = useState<TabKey>('radar')
  const [searchVisited, setSearchVisited] = useState(false)

  useEffect(() => {
    if (tab === 'search') setSearchVisited(true)
  }, [tab])

  /*
    来源下拉的选项。

    ## 为什么不能只从已加载的数据里收集（这是修掉的一个真 bug）

    原实现是「遍历 `feed.items` 去重」。但 `useFeed` 的 `items` 只装
    **当前一页**（20 条，每次 load 整体替换、不累积，见 `state/useFeed.ts`），
    所以这个清单等于「当前这一页里出现过哪些源」。

    默认排序是 `fetchedAt desc`，而 HackerNews 每轮采集返回 59 条、
    一次 collect 就把最新一页铺满——于是下拉框里常年只有 HackerNews
    一项，用户新配的百度/B站/RSS 全部看不见。**这不是数据没进库**：
    它们都在，只是没出现在第 1 页而已。

    ## 现在以 `FEED_KINDS` 为准

    它是 `server/src/routes/topics.ts` 白名单在前端的镜像，本来就是
    「来源种类的单一事实来源」。用它的好处是清单**不再随分页和时间漂移**。

    仍然并上已加载条目里出现过的 kind：`FEED_KINDS` 是**种类**级的，
    而条目可能来自一个已经停用的源（如 `github-trending` 已禁用但历史
    条目还在）。那种情况下列表里没有它就等于「有数据但筛不到」。

    只列 feed 类：搜索类源不落库（`routes/search.ts` 不写 HotItem），
    它们有自己的 Tab，混进来只会永远筛出空结果。
  */
  const kinds = useMemo(() => {
    const extras = new Set<string>()
    for (const item of dashboard.feed.items) {
      if (item.source?.kind) extras.add(item.source.kind)
    }
    const ordered = FEED_KINDS.map((k) => k.value)
    // 已加载数据里出现的、但不在 FEED_KINDS 里的 kind 追加在后面
    return [...ordered, ...[...extras].filter((k) => !ordered.includes(k)).sort()]
  }, [dashboard.feed.items])

  const filterByTopic = useCallback(
    (topicId: string) => {
      dashboard.feed.setFilters({ topicId })
      setTab('radar')
    },
    [dashboard.feed],
  )

  useKeyboard({
    'Alt+1': () => setTab('radar'),
    'Alt+2': () => setTab('keywords'),
    'Alt+3': () => setTab('search'),
    '/': (ev) => {
      ev.preventDefault()
      setTab('search')
    },
  })

  // 根元素用 `min-h-screen` 而不是 `min-h-full`：后者是 `min-height:100%`，
  // 要沿着 html/body 一路传下来才有效，而 body 上的 `min-height:100%` 在
  // html 高度为 auto 时会被算成 0。100vh 不依赖任何父元素。
  return (
    <div className="relative min-h-screen">
      {/*
        背景层必须是根的第一个子元素且 pointer-events:none（见 Backdrop 注释），
        内容层用 relative z-10 盖在它上面。
      */}
      <Backdrop />

      <div className="relative z-10">
        {/*
          页头和实时条共用**一层**吸顶外壳。

          不是让两个元素各自 `sticky`：那样第二个必须写死 `top-16` 来对齐
          页头高度，页头一改高度（加一行、换个 padding）就会盖住/露出缝隙，
          而且不会报错，只是错位。一个外壳里两行，高度就是同一个事实。

          实时条跟着吸顶是有意的：它是页面里唯一回答「此刻在发生什么」的
          元素，滚到列表第 3 屏时它最有用，不该滚掉。

          ## 外壳里的行必须显式定序

          实时条和页头都带 `backdrop-blur`，那让它们各自成为 `z-index: auto`
          的层叠上下文，于是**按 DOM 顺序绘制**——实时条在后，就压住了页头。
          这不是理论问题：通知面板是页头里的 `absolute z-40`，被困在页头的
          层叠上下文里，实测被实时条盖住顶部 36px，且那块区域的点击会落到
          实时条的链接上。现在页头用 `relative z-40` 显式压在实时条上面
          （见 `AppHeader`）。

          所以**往后往这个外壳里加行时，不要给正 z-index**——给 `auto` 或
          负值，顺序由 DOM 决定；否则就要重新想一遍谁压谁。
        */}
        <div className="sticky top-0 z-30">
          <AppHeader
            scanStatus={dashboard.scanStatus}
            onScan={() => void dashboard.scan()}
            realtime={dashboard.realtime}
            unread={dashboard.stats?.unread ?? null}
            onNotificationsRead={dashboard.refreshStats}
          />
          <LiveTicker
            items={dashboard.ticker.items}
            loading={dashboard.ticker.loading}
            error={dashboard.ticker.error}
          />
        </div>

        <div className="mx-auto max-w-7xl px-6 pb-16">
          <div className="border-b border-white/5 py-3">
            <TabNav
              active={tab}
              onChange={setTab}
              keywordCount={dashboard.stats?.topicCount ?? dashboard.topics.length}
            />
          </div>

          {/*
            这里原先有一行「快捷键：Alt + 1/2/3 切页 · / 跳到搜索」的提示。
            删掉的理由不是它占地方，是它**只对第一次来的人有用，却对所有人
            都一直显示**：它是页面上唯一一行不随内容变化、也不回答任何问题的
            文字，天天摆在 Tab 条下面。快捷键本身照旧生效（见上面的
            `useKeyboard`），Tab 条也本来就写着三个页面的名字，不需要再教一遍。
          */}

          {/*
            雷达页：常驻挂载，切走时只是 `hidden`（理由见文件头的注释）。
          */}
          <div className={tab === 'radar' ? 'space-y-5 pt-4' : 'hidden'}>
            <StatCards stats={dashboard.stats} />

            <FilterSortBar
              query={dashboard.feed.query}
              onChange={dashboard.feed.setFilters}
              onReset={dashboard.feed.resetFilters}
              topics={dashboard.topics}
              kinds={kinds}
            />

            <HotFeed
              feed={dashboard.feed}
              topics={dashboard.topics}
              onScan={() => void dashboard.scan()}
            />
          </div>

          {tab === 'keywords' && (
            <div className="pt-4">
              <KeywordPanel
                topics={dashboard.topics}
                loading={dashboard.topicsLoading}
                onAdd={dashboard.addTopic}
                onEdit={dashboard.editTopic}
                onRemove={dashboard.removeTopic}
                onFilterBy={filterByTopic}
              />
            </div>
          )}

          {/*
            搜索页：首次访问才挂载，之后靠 hidden 保留状态。
            `hidden` 是 Tailwind 的 display:none——组件保持挂载但不参与布局。
          */}
          {searchVisited && (
            <div className={tab === 'search' ? 'pt-4' : 'hidden'}>
              <SearchTab collectedTotal={dashboard.stats?.total ?? null} />
            </div>
          )}
        </div>
      </div>

      <ToastStack toasts={dashboard.toasts} onDismiss={dashboard.dismissToast} />
    </div>
  )
}

/**
 * 搜索页的容器。
 *
 * 单独拆出来是因为它需要**自己的** `useFeed` 实例：搜索的查询状态与雷达页
 * 的筛选互不影响（在搜索页过滤了「只看紧急」，不该让雷达页也跟着变）。
 * 而这个 hook 只能在组件里调用——放在 App 里就等于无条件挂载了。
 */
function SearchTab({ collectedTotal }: { collectedTotal: number | null }) {
  const feed = useFeed()
  return <SearchPanel feed={feed} collectedTotal={collectedTotal} />
}
