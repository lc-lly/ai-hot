import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Bell, BellOff, CheckCheck, Inbox } from 'lucide-react'
import { cn } from '../lib/cn.js'
import { agoOf } from '../lib/format.js'
import { ApiError, fetchNotifications, markAllRead, markRead } from '../net/api.js'
import type { NotificationDTO } from '../types.js'
import { Button } from './ui/Button.js'

/**
 * 通知铃铛：未读角标 + 下拉列表 + 全部已读。
 *
 * ## 为什么把「还没做」当成一个正式状态
 *
 * 后端 `/api/notifications` 属于阶段 3，此刻返回 404。如果按普通错误处理，
 * 用户点开铃铛看到的是一句红色的「请求失败（404）」——这会让他以为**坏了**，
 * 而事实是**还没做**。这两件事对用户的意义完全不同，界面必须说清楚。
 * 所以 404/501 走 `unavailable` 分支，显示「通知功能尚未启用」。
 *
 * 这不是为了遮掩，恰恰相反：把一个未实现的功能伪装成「加载中」才是遮掩。
 *
 * ## 角标数字的来源与列表的来源是两条路
 *
 * 角标来自 `/api/stats` 的 `unread`（HTTP 轮询 + WS 广播），列表来自
 * 打开面板时的一次拉取。所以角标可能先于列表更新——这是可接受的，
 * 反过来（列表已更新而角标不变）才会让人困惑。
 *
 * ## 打开时才拉取
 *
 * 通知面板一天可能只开几次。跟热点流一起在首屏拉取，等于给每次页面加载
 * 都加一个几乎没人看的请求。
 */
export function NotificationBell({
  unread,
  onRead,
}: {
  /** 未读数。**`null` 表示还不知道**，此时不显示角标（而不是显示 0） */
  unread: number | null
  /** 已读状态变化后调用，让上层重新拉一次统计 */
  onRead: () => void
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationDTO[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [marking, setMarking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 只是为了 Esc 关闭后把焦点还回去，见下面的 `onKey` */
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = seqRef.current + 1
    seqRef.current = seq
    setLoading(true)
    try {
      const next = await fetchNotifications()
      if (seq !== seqRef.current) return
      setItems(next)
      setError(null)
      setUnavailable(false)
    } catch (err) {
      if (seq !== seqRef.current) return
      if (err instanceof ApiError && (err.status === 404 || err.status === 501)) {
        setUnavailable(true)
        setError(null)
      } else {
        setError(err instanceof ApiError ? err.message : '通知加载失败')
      }
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 点击外部 / Esc 关闭。用 mousedown 而不是 click：
  // click 要等到 mouseup，拖选文本时松手在面板外会误关
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      setOpen(false)
      // 焦点还给铃铛。不还的话它会掉到 `<body>`：键盘用户下一次 Tab 得从
      // 页头第一个可聚焦元素重新数起，等于被弹回页面开头
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const readAll = useCallback(async () => {
    setMarking(true)
    try {
      await markAllRead()
      // 本地先标记，避免等下一轮统计回来才看到角标消失
      setItems((prev) => prev?.map((n) => ({ ...n, read: true })) ?? prev)
      onRead()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '标记已读失败')
    } finally {
      setMarking(false)
    }
  }, [onRead])

  const readOne = useCallback(
    async (n: NotificationDTO) => {
      if (n.read) return
      setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? prev)
      try {
        await markRead(n.id)
        onRead()
      } catch {
        // 单条标记失败不打扰用户：列表下次打开时会对齐服务端的真实状态
      }
    },
    [onRead],
  )

  const hasUnread = (unread ?? 0) > 0

  return (
    /*
      这个 `relative` 是**承重**的，别当成冗余删掉。

      它是下拉面板的包含块——`absolute right-0 mt-2` 全部相对它计算，
      所以面板才会贴着铃铛的下边缘展开。

      页头也带 `backdrop-filter`（那也会成为包含块），所以删掉这里的
      `relative` 不会报错、不会变成未定位：面板会静默跳到**页头右上角**，
      也就是整行最右边。这类"看起来只是挪了个位置"的失效最难查。
    */
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={hasUnread ? `通知，${unread} 条未读` : '通知'}
        aria-expanded={open}
        className={cn(
          'relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg transition-colors',
          'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none',
          open ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
        )}
      >
        <Bell className="h-4.5 w-4.5" />
        {hasUnread && (
          <span className="tabular absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-urgent px-1 text-[10px] font-semibold text-white">
            {/* 超过 99 就写 99+，否则数字会把圆点撑成一个椭圆 */}
            {unread !== null && unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        /*
          底色用 `.panel`（实底 `--color-elevated`）而不是 `.glass`。

          `.glass` 是 4% 白 + 模糊，那对页头/实时条是对的——它们浮在页面上、
          透出一点背景反而有层次。但下拉面板**压在任意内容之上**，透出来就是
          纯噪声：实测能同时看见面板正文和页面里「全部监控词」那排筛选控件叠
          在一起。`.glass` 自己的注释也写了它只给页头和实时条用。

          宽度：24rem 是正文可读的下限（21rem 里排四行中文非常挤）。外面套
          `min(…, 100vw - 3rem)` 是因为面板贴右边缘、而全局没有 `overflow-x:
          hidden`——窄屏上写死宽度会顶出横向滚动条。

          `border-white/10` 盖掉 `.panel` 自带的 `white/6`：浮层需要比卡片
          更清楚的边。工具类盖得住，因为 `.panel` 在 `@layer components` 里
          （见 `styles.css` 里那条分层规则的说明）。

          副作用：`shadow-2xl` 会整体替换掉 `.panel` 的 `inset 0 1px 0` 顶边
          高光（Tailwind v4 的 box-shadow 是分层的）。这里接受——卡片靠顶边
          高光"浮起来"，下拉面板靠投影浮起来，两者要的不是同一种立体感。
        */
        <div
          role="dialog"
          aria-label="通知"
          className="panel animate-fade-up absolute right-0 z-40 mt-2 w-[min(24rem,calc(100vw-3rem))] overflow-hidden rounded-xl border-white/10 shadow-2xl shadow-black/60"
        >
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-2.5">
            <span className="text-sm font-medium text-zinc-200">通知</span>
            <Button
              size="sm"
              variant="ghost"
              loading={marking}
              /* 列表里确实有未读、或角标说有未读，才允许点 */
              disabled={!hasUnread && !(items ?? []).some((n) => !n.read)}
              onClick={readAll}
              icon={<CheckCheck className="h-3.5 w-3.5" />}
            >
              全部已读
            </Button>
          </div>

          {/*
            `max-h` 要比正文的行数预算宽松。22rem（352px）配六行正文只看得到
            两条多，它就成了比 clamp 更紧的约束——正文给够了行数却看不全，
            等于没给。60vh 是给矮窗口兜底的。
          */}
          {/*
            `overscroll-contain` 挡的是**滚动链**（scroll chaining）。

            默认行为（`overscroll-behavior: auto`）：内层滚到边界后，剩下那点
            滚动量会**冒泡给最近的可滚动祖先**。这里的祖先是文档，于是面板已经
            贴底了，再往下滚一次，滚的就是整个页面——面板还开着，背后的卡片先
            动起来，看起来像面板脱离了页面。往上滚到顶同理。

            为什么是 `contain` 而不是 `none`：两者**都**切断滚动链，差别只在
            容器自身要不要保留「到头了」的反馈（Safari 的橡皮筋、Android 的
            辉光）。`none` 把它一并抹掉，`contain` 留着。这里要的是「页面别动」，
            不是「别给反馈」，所以用 `contain`。

            为什么不在打开面板时锁 `body` 滚动：那会让**滚动条消失**，整个
            `mx-auto max-w-7xl` 的内容横向平移一次——正是 `styles.css:228` 那条
            `scrollbar-gutter: stable` 花力气消掉的那类抖动。为一个下拉面板
            把那个代价请回来不值得。
          */}
          <div className="max-h-[min(28rem,60vh)] overflow-y-auto overscroll-contain">
            {unavailable ? (
              <Notice
                icon={<BellOff className="h-4 w-4" />}
                title="通知功能尚未启用"
                hint="后端的通知通道还在开发中。等它上线后，这里会显示命中的热点和推送记录。"
              />
            ) : error ? (
              <Notice
                icon={<BellOff className="h-4 w-4" />}
                title="加载失败"
                hint={error}
                action={<Button size="sm" onClick={() => void load()}>重试</Button>}
              />
            ) : loading && items === null ? (
              <Notice icon={<Inbox className="h-4 w-4 animate-pulse" />} title="加载中…" />
            ) : (items ?? []).length === 0 ? (
              <Notice
                icon={<Inbox className="h-4 w-4" />}
                title="还没有通知"
                hint="当有热点命中你的监控词、且达到推送阈值时，会出现在这里。"
              />
            ) : (
              <ul className="divide-y divide-white/5">
                {(items ?? []).map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => void readOne(n)}
                      className={cn(
                        'relative flex w-full cursor-pointer px-3 py-2.5 text-left transition-colors',
                        /*
                          未读行**没有 hover 底色**，读了才有。

                          上一版两种状态都挂 `hover:bg-white/[0.03]`，而未读行
                          自己的底色是 `bg-accent/[0.06]`——两个都是 background-color，
                          hover 那条写在后面，于是鼠标一放上去，未读行就从青色
                          变成白色。用户的话是「未读信息时的 hover 样式不要改变，
                          和没有 hover 时保持一样」。

                          与其说是样式问题，不如说是**语义**问题：未读行的底色
                          不是「鼠标在这儿」，是「这条你还没看」。两种含义挤在
                          同一个属性上，谁覆盖谁就变成了「鼠标一划过，未读就不
                          那么未读了」。

                          读了之后底色本来就没了，这时才轮到 hover 出场——
                          它只负责回答「你正指着哪一行」。
                        */
                        n.read ? 'hover:bg-white/[0.03]' : 'signal-rail bg-accent/[0.06]',
                      )}
                      /*
                        未读的左侧轨道。走 `.signal-rail`（与卡片同一套语言）而不是
                        原来那个 1.5px 圆点：圆点在实底面板上几乎看不见，而且它的
                        `mt-1.5` 是为了跟首行文字对齐硬凑的偏移。

                        `--rail-inset` 取 `0.625rem` = 这里的 `py-2.5`。竖条于是
                        只覆盖**内容盒**，和文字同高。不设的话它撑满整行，相邻
                        未读之间首尾相接，连成一根贯穿列表的长线——用户报的就是
                        这个（「连成了一条线不好看」），他想要的是「左边那道高亮
                        光标跟文字一样高」。
                      */
                      style={
                        n.read
                          ? undefined
                          : ({
                              ['--rail' as string]: 'var(--color-accent)',
                              ['--rail-inset' as string]: '0.625rem',
                            } as CSSProperties)
                      }
                    >
                      {/* 未读态原先是 `aria-hidden` 的圆点，读屏完全感知不到 */}
                      {!n.read && <span className="sr-only">未读</span>}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-200">
                            {n.title}
                          </span>
                          <span className="shrink-0 text-[11px] text-zinc-600">
                            {agoOf(n.createdAt)}
                          </span>
                        </span>
                        {n.body && (
                          /*
                            正文是**多行结构文本**，不是一句话。服务端按行组织
                            （见 `jobs/discover.ts` 的 `formatDiscoverBody`）：
                            标题 / 指标 / 来源 / 综合分 / 链接。

                            三个类缺一不可：
                            - `whitespace-pre-line` 保住那些换行。不加的话 `\n`
                              会塌成空格，整段变成一坨跑马句——这正是原来难看的
                              原因之一
                            - `break-words` 让没空格的长 URL 折行而不是撑破面板
                            - `line-clamp-6`：对「发现热点」和「核实」这两类正文
                              它是**病态兜底**——服务端把它们排到 5 个行盒内
                              （空行也占配额，所以那边刻意不留空行），正常不该
                              被触发。但**日报那类正文确实会被它截断**：那是一份
                              Top N 的列表，N 条就是 N 行，压不进 6 行。那是有意
                              的——下拉面板里放一份摘要，完整列表在发现页

                            必须是**单个文本节点**：`-webkit-box` 的多子节点布局
                            在 WebKit/Gecko 上仍是旧的横向排布，拆成
                            `lines.map(...)` 会在那些浏览器上横着排开。
                          */
                          <span className="mt-1 line-clamp-6 text-xs leading-relaxed whitespace-pre-line break-words text-zinc-400">
                            {n.body}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 面板内的空态 / 错误态。比通用 `Empty` 紧凑——下拉面板不该有 16 的纵向内边距。 */
function Notice({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-5 py-8 text-center">
      <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-zinc-500">
        {icon}
      </span>
      <p className="text-[13px] font-medium text-zinc-300">{title}</p>
      {hint && <p className="mt-1 text-xs leading-relaxed text-zinc-500">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
