import type { ReactNode } from 'react'
import { AlertTriangle, Check, HelpCircle, ShieldQuestion } from 'lucide-react'
import { cn } from '../../lib/cn.js'
import type { Importance } from '../../types.js'

/**
 * 徽章。全站的「小结论」都长这样：一行里能扫完，不抢标题的字号。
 */
export function Badge({
  children,
  className,
  icon,
  title,
}: {
  children: ReactNode
  className?: string
  icon?: ReactNode
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/**
 * 四色重要度。**这是卡片上唯一的「首要徽章」**，其他徽章都要比它安静。
 *
 * ## 全部走 token，不再硬编码 Tailwind 色阶
 *
 * 上一版这里是 `text-rose-300 ring-rose-500/30` 这类写死的类名，同时
 * `styles.css` 里又有一套 `--color-urgent`——两套值各改各的，改一处
 * 另一处必然漂移。现在徽章的背景/文字/边框三处都从同一个 token 派生
 * （Tailwind v4 的 `/15` 语法就是 `color-mix`），改 token 即全站生效。
 *
 * ## 视觉重量让给卡片的左轨
 *
 * 卡片现在用「左轨 + 极淡底色晕」表达重要度（见 `HotspotCard`），
 * 所以徽章不再需要用满饱和的填充去喊——它退到 15% 底、本色文字，
 * 只负责给出**文字标签**（轨道说得清「多重」，说不清「叫什么」）。
 * 两个元素都喊的话，卡片会变成一块嘈杂的色斑。
 */
const IMPORTANCE_STYLE: Record<Importance, { label: string; className: string }> = {
  urgent: {
    label: '紧急',
    className: 'bg-urgent/15 text-urgent ring-1 ring-urgent/30',
  },
  high: {
    label: '重要',
    className: 'bg-high/15 text-high ring-1 ring-high/30',
  },
  medium: {
    label: '普通',
    className: 'bg-medium/10 text-medium ring-1 ring-medium/25',
  },
  low: {
    label: '次要',
    className: 'bg-white/5 text-muted ring-1 ring-low/40',
  },
}

export function ImportanceBadge({ value, className }: { value: Importance; className?: string }) {
  const style = IMPORTANCE_STYLE[value]
  return (
    <Badge
      className={cn(style.className, className)}
      title={`重要程度：${style.label}（由热度与 AI 标记共同决定）`}
    >
      {style.label}
    </Badge>
  )
}

/**
 * 真伪徽章。**三态**，不是两态。
 *
 * `authenticity === null` 表示 AI 还没评过这一条。此时必须显示
 * 「未评估」而不是「已核实」也不是「疑似虚假」——
 * 把我们的沉默说成任何一种结论都是在编造事实。
 *
 * 判定口径与后端 `routes/items.ts` 的 `authenticity=suspicious` 一致：
 * 带 rumor/clickbait/ad 任一标记，或 authenticity < 0.5。
 */
export function TruthBadge({
  authenticity,
  flags,
  className,
}: {
  authenticity: number | null
  flags: readonly string[]
  className?: string
}) {
  const SUSPICIOUS = ['rumor', 'clickbait', 'ad']
  const flagged = flags.filter((f) => SUSPICIOUS.includes(f))

  if (authenticity === null && flags.length === 0) {
    return (
      <Badge
        className={cn('bg-white/5 text-faint ring-1 ring-low/40 ring-dashed', className)}
        icon={<HelpCircle className="h-3 w-3" />}
        title="AI 尚未评估这条内容"
      >
        未评估
      </Badge>
    )
  }

  if (flagged.length > 0 || (authenticity !== null && authenticity < 0.5)) {
    return (
      <Badge
        className={cn('bg-fake/15 text-fake ring-1 ring-fake/30', className)}
        icon={<AlertTriangle className="h-3 w-3" />}
        title={flagged.length > 0 ? `标记：${flagged.join('、')}` : '可信度低于 0.5'}
      >
        疑似虚假
      </Badge>
    )
  }

  return (
    <Badge
      className={cn('bg-true/15 text-true ring-1 ring-true/30', className)}
      icon={<Check className="h-3 w-3" />}
      title={`可信度 ${((authenticity ?? 0) * 100).toFixed(0)}%`}
    >
      已核实
    </Badge>
  )
}

/**
 * 命中方式徽章。**三态**。
 *
 * `isAbout === null` 时**整个徽章不渲染**——没有可说的就不说，
 * 而不是渲染一个「未知」占位。卡片上每多一个无信息的元素，
 * 真正有信息的元素就少一分注意力。
 */
export function MatchBadge({
  match,
  className,
}: {
  match: { isAbout: boolean | null; topicName: string } | null
  className?: string
}) {
  if (!match || match.isAbout === null) return null

  return (
    <Badge
      className={cn(
        // 「直接提及」用 accent——它是**交互主色**，但这里表达的是
        // 「AI 确认这条就是在讲你的关键词」，是全站最该被看见的结论之一。
        // 与 medium（天蓝）色相相邻，但两者不会同时出现在一个位置上：
        // accent 属于「命中了监控词」，medium 属于「内容有多重要」。
        match.isAbout
          ? 'bg-accent/15 text-accent-soft ring-1 ring-accent/30'
          : 'bg-white/5 text-muted ring-1 ring-low/40',
        className,
      )}
      title={
        match.isAbout
          ? `AI 判定这条的主旨就是在讲「${match.topicName}」`
          : `AI 判定这条只是顺带提到「${match.topicName}」`
      }
    >
      {match.isAbout ? '直接提及' : '间接相关'}
    </Badge>
  )
}

/** 浅灰的元信息小块，用于领域、来源名这类不需要着色的标签。 */
export function MetaBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Badge className={cn('bg-white/5 text-muted ring-1 ring-low/40', className)}>{children}</Badge>
  )
}

/**
 * AI 标记（clickbait / rumor / stale ...）。
 *
 * 刻意**只在有标记时渲染**。没有标记的条目不该出现「无标记」三个字——
 * 那是把「正常」也当成一条信息，会把卡片填满噪音。
 */
const FLAG_LABEL: Record<string, string> = {
  clickbait: '标题党',
  ai_generated: '疑似 AI 生成',
  rumor: '传闻',
  stale: '旧闻',
  ad: '广告',
  unverified: '未证实',
}

/**
 * 琥珀色在这里是**第二次**出现（第一次是重要度「重要」）。
 *
 * 这是有意的复用，不是疏忽：两者虽然共用色相，但**从不同时出现在同一个
 * 视觉层级上**——重要度徽章在标题行的首位，标记块在它后面的元信息行，
 * 尺寸更小、带图标。用户扫一眼卡片时读的是「位置 + 形状」，
 * 不是「色号」。真要为标记再引入一个第五色，代价是整套配色失去纪律，
 * 而那正是上一版「每个 AI 产品都长这样」的病因。
 */
export function FlagChips({ flags, className }: { flags: readonly string[]; className?: string }) {
  if (flags.length === 0) return null
  return (
    <>
      {flags.map((f) => (
        <Badge
          key={f}
          className={cn('bg-high/10 text-high ring-1 ring-high/25', className)}
          icon={<ShieldQuestion className="h-3 w-3" />}
        >
          {FLAG_LABEL[f] ?? f}
        </Badge>
      ))}
    </>
  )
}
