import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Hash, Pencil, Plus, Trash2, X } from 'lucide-react'
import { cn } from '../lib/cn.js'
import { FEED_KINDS, KIND_LABELS, NOTIFY_POLICY_META } from '../lib/kinds.js'
import { ApiError, type TopicInput } from '../net/api.js'
import type { NotifyPolicy, TopicDTO } from '../types.js'
import { Button } from './ui/Button.js'
import { GlassCard, SectionTitle } from './ui/Card.js'
import { Empty, Skeleton } from './ui/Empty.js'
import { Field, Input, Select, Textarea, Toggle } from './ui/Field.js'

/**
 * 监控词管理：增删改 + 启停。
 *
 * ## 两处不做会让用户白等的地方
 *
 * 1. **新建成功后必须提示「此前被跳过的条目会重新评估」。** 后端确实做了
 *    这件事（见 `server/src/routes/topics.ts` 的 `reviveSkipped`），但它
 *    要等下一轮 triage 才会出结果。不说明的话，用户加完关键词看到命中数
 *    还是 0，会以为这个功能没用。
 * 2. **删除必须二次确认。** 删掉一个词会连带删掉它的全部命中记录
 *    （`Match` 表的外键级联），那是不可恢复的。
 *
 * ## 表单为什么内嵌而不是弹窗
 *
 * 弹窗要处理焦点陷阱、Esc、背景滚动锁定、层级——这些用 `<dialog>` 能解决，
 * 但一个只有五个字段的表单不值得。内嵌在列表上方，改完即见结果，
 * 反而更快。
 */
export function KeywordPanel({
  topics,
  loading,
  onAdd,
  onEdit,
  onRemove,
  onFilterBy,
}: {
  topics: TopicDTO[]
  loading: boolean
  onAdd: (input: TopicInput) => Promise<void>
  onEdit: (id: string, patch: Partial<TopicInput>) => Promise<void>
  onRemove: (id: string) => Promise<void>
  /** 点某个词的「看命中」跳到雷达页并带上筛选 */
  onFilterBy: (topicId: string) => void
}) {
  /** `null` = 表单关闭；`'new'` = 新建；其余为正在编辑的词 id */
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const toMessage = (err: unknown, fallback: string) =>
    err instanceof ApiError ? err.message : fallback

  const toggle = useCallback(
    async (topic: TopicDTO, next: boolean) => {
      setPending(topic.id)
      setError(null)
      try {
        await onEdit(topic.id, { enabled: next })
      } catch (err) {
        setError(toMessage(err, '切换启停失败'))
      } finally {
        setPending(null)
      }
    },
    [onEdit],
  )

  const remove = useCallback(
    async (topic: TopicDTO) => {
      setPending(topic.id)
      setError(null)
      try {
        await onRemove(topic.id)
        if (editing === topic.id) setEditing(null)
      } catch (err) {
        setError(toMessage(err, '删除失败'))
      } finally {
        setPending(null)
      }
    },
    [onRemove, editing],
  )

  const editingTopic =
    editing !== null && editing !== 'new' ? topics.find((t) => t.id === editing) : undefined

  return (
    <div className="space-y-4">
      <SectionTitle
        right={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setEditing((v) => (v === 'new' ? null : 'new'))}
          >
            新增监控词
          </Button>
        }
      >
        监控词
      </SectionTitle>

      <p className="text-xs leading-relaxed text-zinc-500">
        监控词决定哪些条目值得用 AI 深入评估。命中「包含关键词」的条目会进入三层过滤，
        再由 AI 判定是否真的是关于它——不是字面出现就算命中。
      </p>

      {notice && (
        <div className="flex items-start gap-2 rounded-xl bg-true/10 px-3 py-2.5 text-xs leading-relaxed text-true ring-1 ring-true/20">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="cursor-pointer text-true/70 hover:text-true"
            aria-label="关闭提示"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-urgent/10 px-3 py-2.5 text-xs leading-relaxed text-urgent ring-1 ring-urgent/20">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="cursor-pointer text-urgent/70 hover:text-urgent"
            aria-label="关闭错误"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {editing !== null && (
        <TopicForm
          key={editing}
          initial={editingTopic}
          onCancel={() => setEditing(null)}
          onSubmit={async (input) => {
            if (editing === 'new') {
              await onAdd(input)
              setNotice(
                '已创建。此前被判为无关而跳过的条目会重新进入评估队列，命中结果要等下一轮 AI 分析才会出现。',
              )
            } else {
              await onEdit(editing, input)
              setNotice('已保存。下次 AI 分析会按新的关键词重新评估。')
            }
            setEditing(null)
          }}
        />
      )}

      {loading && topics.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }, (_, i) => (
            <GlassCard key={i} className="p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-3 h-5 w-2/3" />
            </GlassCard>
          ))}
        </div>
      ) : topics.length === 0 && editing === null ? (
        <Empty
          icon={<Hash className="h-5 w-5" />}
          title="还没有监控词"
          hint="加一个你关心的词（比如「Claude」「AI 编程」），系统就会盯着所有来源，命中时用 AI 判断是不是真的关于它，值得看的才通知你。"
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              新增第一个监控词
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {topics.map((t) => (
            <TopicCard
              key={t.id}
              topic={t}
              pending={pending === t.id}
              editing={editing === t.id}
              onToggle={(next) => void toggle(t, next)}
              onEdit={() => setEditing(t.id)}
              onRemove={() => void remove(t)}
              onFilter={() => onFilterBy(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TopicCard({
  topic,
  pending,
  editing,
  onToggle,
  onEdit,
  onRemove,
  onFilter,
}: {
  topic: TopicDTO
  pending: boolean
  editing: boolean
  onToggle: (next: boolean) => void
  onEdit: () => void
  onRemove: () => void
  onFilter: () => void
}) {
  const [confirming, setConfirming] = useState(false)

  // 二次确认在 4 秒后自动收起：用户点错了不用再点一次「取消」
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(t)
  }, [confirming])

  return (
    <GlassCard
      hover
      className={cn(
        'p-4',
        editing && 'border-accent/40',
        !topic.enabled && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-100">{topic.name}</h3>
            {!topic.enabled && (
              <span className="shrink-0 rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] text-zinc-500">
                已停用
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {topic.include.length === 0 ? (
              <span className="text-xs text-high/80">
                没有包含关键词，这条监控词永远不会命中
              </span>
            ) : (
              topic.include.map((k) => (
                <span
                  key={k}
                  className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent-soft ring-1 ring-accent/20"
                >
                  {k}
                </span>
              ))
            )}
            {topic.exclude.map((k) => (
              <span
                key={k}
                className="rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] text-zinc-500 line-through"
                title="排除词，命中它的条目不评估"
              >
                {k}
              </span>
            ))}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span>
              来源：
              {topic.sourceKinds.length === 0
                ? '不限'
                : topic.sourceKinds.map((k) => KIND_LABELS[k] ?? k).join(' / ')}
            </span>
            <span>置信度 ≥ {topic.minConfidence.toFixed(2)}</span>
            <span>
              推送：
              {NOTIFY_POLICY_META.find((p) => p.value === topic.notifyPolicy)?.label ??
                topic.notifyPolicy}
            </span>
            <button
              onClick={onFilter}
              disabled={topic.matchCount === 0}
              title={topic.matchCount === 0 ? '还没有命中记录' : '在热点雷达里只看这个词的命中'}
              className={cn(
                'rounded-md px-1.5 py-0.5 transition-colors',
                topic.matchCount === 0
                  ? 'cursor-not-allowed text-zinc-600'
                  : 'cursor-pointer text-accent-soft hover:bg-accent/10',
              )}
            >
              命中 {topic.matchCount}
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Toggle
            checked={topic.enabled}
            disabled={pending}
            onChange={onToggle}
            label={`${topic.enabled ? '停用' : '启用'} ${topic.name}`}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onEdit}
            icon={<Pencil className="h-3.5 w-3.5" />}
            aria-label="编辑"
          />
          {confirming ? (
            <Button
              size="sm"
              variant="danger"
              loading={pending}
              onClick={onRemove}
              icon={<Trash2 className="h-3.5 w-3.5" />}
            >
              确认删除
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirming(true)}
              icon={<Trash2 className="h-3.5 w-3.5" />}
              aria-label="删除"
            />
          )}
        </div>
      </div>
    </GlassCard>
  )
}

/**
 * 监控词表单。
 *
 * ## 关键词为什么按「一行一个」而不是「逗号分隔」
 *
 * 中文关键词里逗号是常见的（「AI，你好」这种），用逗号分隔就得处理转义。
 * 而行分隔没有歧义，粘贴一串也可以顺手换行。**逗号和顿号仍然接受**，
 * 只是不作为首选提示。
 */
function TopicForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: TopicDTO
  onSubmit: (input: TopicInput) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [include, setInclude] = useState((initial?.include ?? []).join('\n'))
  const [exclude, setExclude] = useState((initial?.exclude ?? []).join('\n'))
  const [sourceKinds, setSourceKinds] = useState<string[]>(initial?.sourceKinds ?? [])
  const [minConfidence, setMinConfidence] = useState(initial?.minConfidence ?? 0.5)
  const [notifyPolicy, setNotifyPolicy] = useState<NotifyPolicy>(
    initial?.notifyPolicy ?? 'high_only',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const includeList = splitKeywords(include)
  const canSubmit = name.trim() !== '' && includeList.length > 0 && !busy

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        name: name.trim(),
        include: includeList,
        exclude: splitKeywords(exclude),
        sourceKinds,
        minConfidence,
        notifyPolicy,
        ...(initial ? {} : { enabled: true }),
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败')
      setBusy(false)
    }
    // 成功时不 setBusy(false)：组件随即被卸载，改状态会触发 React 警告
  }

  return (
    <GlassCard className="animate-fade-up border-accent/30 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-100">
          {initial ? `编辑「${initial.name}」` : '新增监控词'}
        </h3>
        <button
          onClick={onCancel}
          className="cursor-pointer text-zinc-500 hover:text-zinc-300"
          aria-label="取消"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名称" hint="给这条监控词起个短名字，会显示在卡片和筛选栏里" className="sm:col-span-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：AI 编程"
            maxLength={60}
          />
        </Field>

        <Field
          label="包含关键词"
          hint="一行一个。字面命中还不够，AI 会再判断这条内容的主旨是不是关于它"
          className="sm:col-span-2"
        >
          <Textarea
            value={include}
            onChange={(e) => setInclude(e.target.value)}
            rows={3}
            placeholder={'Claude\nCursor\nAI 编程'}
          />
        </Field>

        <Field label="排除关键词" hint="可选。命中它的条目直接跳过，用来挡掉同名噪音" className="sm:col-span-2">
          <Textarea
            value={exclude}
            onChange={(e) => setExclude(e.target.value)}
            rows={2}
            placeholder={'招聘\n课程推广'}
          />
        </Field>

        <Field label="限定来源" hint="都不选 = 不限来源">
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {FEED_KINDS.map((k) => {
              const on = sourceKinds.includes(k.value)
              return (
                <button
                  key={k.value}
                  type="button"
                  title={k.hint}
                  onClick={() =>
                    setSourceKinds((prev) =>
                      prev.includes(k.value)
                        ? prev.filter((v) => v !== k.value)
                        : [...prev, k.value],
                    )
                  }
                  className={cn(
                    'cursor-pointer rounded-md px-2 py-1 text-xs transition-colors',
                    on
                      ? 'bg-accent/20 text-accent-soft ring-1 ring-accent/40'
                      : 'bg-white/[0.03] text-zinc-400 ring-1 ring-white/10 hover:text-zinc-200',
                  )}
                >
                  {k.label}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="推送策略">
          <Select
            value={notifyPolicy}
            onChange={(v) => setNotifyPolicy(v as NotifyPolicy)}
            options={NOTIFY_POLICY_META.map((p) => ({ value: p.value, label: p.label }))}
          />
        </Field>

        <Field
          label={`置信度阈值 ${minConfidence.toFixed(2)}`}
          hint="低于这个值的命中只入库、不推送"
          className="sm:col-span-2"
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
            className="accent-accent h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10"
          />
        </Field>
      </div>

      {error && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-urgent">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        {!canSubmit && name.trim() !== '' && includeList.length === 0 && (
          <span className="mr-auto text-xs text-high/80">
            至少要填一个包含关键词，否则这条监控词永远不会命中
          </span>
        )}
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
          {initial ? '保存' : '创建'}
        </Button>
      </div>
    </GlassCard>
  )
}

/** 按行拆关键词。**同时接受逗号与顿号**——用户粘贴时经常混着来。 */
function splitKeywords(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[\n,，、]/)) {
    const t = piece.trim()
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}
