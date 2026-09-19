import { cn } from '../lib/cn.js'
import { agoOf, isFresh } from '../lib/format.js'
import type { Importance, ItemDTO } from '../types.js'
import type { TickerState } from '../state/useTicker.js'

/**
 * 实时热点条：页头正下方的 32px 走马灯。
 *
 * ## 它回答的问题
 *
 * 页面别的地方回答的都是「**已经**抓到了什么」。这条带子回答的是
 * 「**此刻**正在发生什么」——对「想第一时间发现热点」的人来说，
 * 这是唯一一个不需要任何操作就能拿到的信息。
 *
 * 它**不参与筛选**：上面的热点流可以被筛成「只看紧急」「只看某个监控词」，
 * 而这条带子永远是全库最新的 10 条。理由是「此刻在发生什么」不该取决于
 * 用户上一分钟设的过滤器。
 *
 * ## 悬停暂停是**必要的**，不是锦上添花
 *
 * 走马灯的速度是按「扫一眼有没有新东西」调的，不是按阅读调的。
 * 不暂停的话，想点中哪条基本靠运气。悬停在**整条带子**上就停
 * （`group-hover`），所以鼠标移到目标条目的路上它已经停了。
 *
 * ## 降级全部走 CSS，**不用** `useReducedMotion()`
 *
 * 全局那条 CSS（`styles.css:311` 的 `@media (prefers-reduced-motion)`）会把
 * 动画时长压到 0.01ms——它能让走马灯停下来，但**停下来的走马灯配上
 * `overflow-hidden` 就等于「后面的条目看不了了」**。动画没了、内容跟着
 * 不可达，这是把无障碍做成了功能缺失。
 *
 * 所以这里换一套渲染而不是只停动画：**单份内容 + `overflow-x-auto`**，
 * 用户自己横划。触屏同理——没有 hover，走马灯既读不了也点不准。
 *
 * 这个分支用 `pointer-coarse:` / `motion-reduce:` 两个变体写在类名上，
 * **而不是**用 JS 读 `matchMedia`。JS 方案要么在 `useEffect` 里读（首帧画出
 * 走马灯、下一帧才跳成静态，闪一下），要么上一整套订阅。这两个变体是
 * Tailwind 自带的（已确认 4.3.3 支持），零运行时成本，且首帧就是对的。
 *
 * `useReducedMotion()` 仍然是硬性要求——但那是给 `CardSpotlight` /
 * `NumberTicker` 用的：那两个的动画由 motion 逐帧写进 DOM，
 * CSS 根本拦不住，必须 JS 判断。**能交给 CSS 的就别交给 JS。**
 *
 * ## 重复的那一份要 `tabIndex={-1}`
 *
 * 无缝衔接靠把内容复制两份、位移 -50%。第二份是给**滚动过程中**补位的，
 * 鼠标滚到那儿时它已经在屏幕里了，所以它得能点。
 * 但它又必须 `aria-hidden`（否则读屏软件把每条热点念两遍）——
 * 而 `aria-hidden` 的子树里**不允许有可聚焦元素**。
 *
 * 结论：第二份的 `<a>` 保留鼠标点击、去掉键盘焦点（`tabIndex={-1}`）。
 * 键盘和读屏用户走第一份，鼠标用户点到哪份都行。
 */
export function LiveTicker({ items, loading, error }: Pick<TickerState, 'items' | 'loading' | 'error'>) {
  return (
    <div
      aria-label="实时热点"
      className="group flex h-8 items-center border-t border-white/5 bg-base/70 backdrop-blur-xl"
    >
      {/* 标签不跟着滚。它固定住，「这条带子在说什么」就不会随滚动跑掉 */}
      <span className="flex h-full shrink-0 items-center gap-1.5 border-r border-white/5 px-3 text-[11px] text-faint">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
        实时
      </span>

      {items.length === 0 ? (
        <span className="px-3 text-xs text-faint">{emptyText(loading, error)}</span>
      ) : (
        /*
         * `w-max` 让轨道按内容宽度撑开（而不是被容器压扁），
         * `-50%` 的位移才有确定的含义：正好是第一份的宽度。
         *
         * 条目之间的间距**用 `pr-8` 写在每个条目上，不用 `gap`**。
         * 用 gap 的话，2N 个条目只有 (2N-1) 个间隙，两份内容宽度不等，
         * 位移到 -50% 时会**跳一下**——而且这个跳动只在循环点出现，
         * 静态截图看不出来，只有盯着看才发现。
         */
        <div
          className={cn(
            'min-w-0 flex-1 overflow-hidden',
            // 降级时改成可横划。滚动条隐藏是有意的：32px 的带子里塞一条
            // 滚动条会挤掉半行字，而已隐藏不会丢信息——同样的 10 条在下面的
            // 热点流里全都能看到，这条带子是便捷入口，不是唯一路径。
            'motion-reduce:overflow-x-auto pointer-coarse:overflow-x-auto',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          )}
        >
          <div
            className={cn(
              'flex w-max',
              // 只有「允许动效 + 精确指针」才滚。触屏和 reduce 都不滚。
              'motion-safe:pointer-fine:animate-ticker',
              'group-hover:[animation-play-state:paused]',
            )}
          >
            {items.map((item) => (
              <Entry key={item.id} item={item} duplicate={false} />
            ))}
            {items.map((item) => (
              <Entry key={`${item.id}-dup`} item={item} duplicate />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 空态文案。
 *
 * 三种「没有条目」的含义完全不同，不能共用一句话：
 * - 还在拉 → 说正在接
 * - 拉回来了但是空库 → 说库里确实没有，并告诉用户下一步做什么
 * - 拉失败 → 说没接到（**不能**说「暂无热点」：那是把我们的故障
 *   说成「世界上没有热点」，与卡片上「不把沉默渲染成一个具体的值」是同一条规矩）
 */
function emptyText(loading: boolean, error: string | null): string {
  if (error !== null) return '实时热点暂时取不到，稍后会自动重试'
  if (loading) return '正在接入实时热点…'
  return '库里还没有条目，点右上角「立即扫描」拉一批'
}

/** 重要度圆点。四个档位都有静态类名字面量，Tailwind 才扫得到。 */
const DOT: Record<Importance, string> = {
  urgent: 'bg-urgent',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
}

function Entry({ item, duplicate }: { item: ItemDTO; duplicate: boolean }) {
  const published = item.publishedAt ?? item.fetchedAt
  // 与卡片上的时间戳同一口径：判据是**发布时刻**，见 `isFresh` 的注释
  const fresh = isFresh(published)

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer noopener"
      // 见文件头注释：第二份要点得到，但不能进 a11y 树、也不能进 Tab 序
      aria-hidden={duplicate ? true : undefined}
      tabIndex={duplicate ? -1 : undefined}
      className={cn(
        // `pr-8` 而不是 gap，理由见上方轨道那段的注释
        'flex shrink-0 items-center gap-2 pr-8 text-xs text-zinc-300 transition-colors hover:text-accent-soft',
        // 降级成静态行时，重复的那份整个去掉，只剩下单份内容
        duplicate && 'motion-reduce:hidden pointer-coarse:hidden',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[item.importance])}
      />
      {/* 标题不设自己的颜色，好让它跟着 `<a>` 的 hover 变色 */}
      <span className="max-w-[26rem] truncate">{item.title}</span>
      <span className={cn('shrink-0', fresh ? 'font-medium text-accent-soft' : 'text-zinc-500')}>
        {agoOf(published)}
      </span>
    </a>
  )
}
