"""抓取多个信源，输出归一化 JSON。

    py scripts/fetch.py --since 24h
    py scripts/fetch.py --sources bilibili,baidu,juejin --limit 10
    py scripts/fetch.py --sources reddit --proxy http://127.0.0.1:7890
    py scripts/fetch.py --out ~/.hotspot-radar/runs/$(date +%F).json

stdout 只有 JSON，日志全在 stderr。这样 Agent 可以放心地把 stdout 交给 JSON 解析器。

**这个脚本只抓取和归一化。** 去重、聚类、排序、写摘要都是调用它的 Agent 的活儿 ——
本技能不调用任何 LLM，因此零 token 费用、零密钥。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    SCHEMA_FETCH,
    RadarError,
    emit,
    exit_code_for,
    log,
    now_iso,
    parse_since,
    project,
    setup_stdio_early,
)
from sources import (  # noqa: E402
    add_source_args,
    ctx_from_args,
    fetch_all,
    filter_items,
    resolve_sources,
)

# 速览默认每源只取 10 条。注意 `--limit` 是**每源**上限，
# 13 个默认源 × 10 实测约 63 条 / 23,000+ 字符 —— **超过工具单次输出上限**，
# 所以速览一律建议走 `--out`。watch.py 刻意用更大的默认值 —— 见 build_parser()。
FETCH_DEFAULT_LIMIT = 10

ALLOWED_FIELDS = [
    "id",
    "source",
    "title",
    "url",
    "summary",
    "author",
    "publishedAt",
    "heat",
    "rank",
    "lang",
    "raw",
    # 只有用了 --author/--grep 才会出现在条目上；放进白名单是为了让
    # `--fields` 能显式保留它（见 main() 里的自动保留）。
    "matched",
]


def _split_terms(raw: str | None) -> list[str]:
    return [t.strip() for t in raw.split(",") if t.strip()] if raw else []


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="fetch.py",
        description="从多个免密钥信源抓取热点并归一化为 JSON",
        epilog="示例：py scripts/fetch.py --since 24h --limit 20",
    )
    # 默认比 watch.py 小得多，因为两者的失败代价相反：
    #   fetch 是速览，一次抓 13 个源，`--limit` 又是**每源**上限 —— 用 50 会得到
    #     几百条，必然超出工具输出阈值。
    #   watch 是告警，limit 调小会让排在源内靠后的命中项**静默漏报**（最糟的失败）。
    # 所以速览取 10（实测 63 条 / 23,000+ 字符，**仍超上限**，建议配 --out），告警维持 50。
    add_source_args(p, default_limit=FETCH_DEFAULT_LIMIT)

    # 只加在 fetch.py，**不加**在共用的 add_source_args() 里 —— watch.py 不能有
    # 这两个参数。watch 已有更完整的监控词匹配（item_matches / --in-fields），
    # 再叠一层重叠的过滤会让它的「已见集合」语义错乱：过滤开一次关一次，
    # 之前被滤掉的条目会全部被当成新增报出来。
    f = p.add_argument_group("过滤（抓取之后、你的分析之前）")
    f.add_argument(
        "--author",
        help="按发布者过滤：匹配 author 字段或信源显示名（人名、机构名都可以）；"
             "逗号分隔=任一命中；子串匹配、不区分大小写、**不是正则**",
    )
    f.add_argument(
        "--grep",
        help="按标题+摘要过滤；逗号分隔=任一命中；子串匹配、不区分大小写、**不是正则**",
    )
    f.add_argument(
        "--grep-all",
        action="store_true",
        help="--grep 的多个词必须全部命中（默认任一命中）",
    )

    g = p.add_argument_group("输出")
    g.add_argument("--out", help="写到文件而不是 stdout（用 '-' 显式表示 stdout）")
    g.add_argument("--fields", help=f"逗号分隔，只保留这些字段以省 token。可选：{','.join(ALLOWED_FIELDS)}")
    g.add_argument("--ascii", action="store_true", help="输出纯 ASCII（\\uXXXX 转义），兼容非 UTF-8 终端")
    g.add_argument("--compact", action="store_true", help="JSON 不缩进")
    return p


def main(argv=None) -> int:
    setup_stdio_early(argv)  # 必须早于 argparse，否则 --help 的中文会乱码
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        cutoff = parse_since(args.since)
        ctx = ctx_from_args(args)
        # 必须把 only 交给 resolve_sources 校验。写成 `ctx.extra["only"] or resolve_sources(...)`
        # 会让 `--sources` 一旦给了就短路掉校验 —— 打错一个 id 会被当成
        # 「这个源抓取失败」，报 exit 3（全失败），而正确答案是 exit 1（用法错误）。
        ids = resolve_sources(ctx.extra["only"], args.all_sources)
    except RadarError as e:
        log(f"错误：{e}")
        return 1

    fields = None
    if args.fields:
        fields = [f.strip() for f in args.fields.split(",") if f.strip()]
        unknown = [f for f in fields if f not in ALLOWED_FIELDS]
        if unknown:
            log(f"错误：未知字段 {', '.join(unknown)}；可选 {', '.join(ALLOWED_FIELDS)}")
            return 1

    authors = _split_terms(args.author)
    greps = _split_terms(args.grep)
    if args.grep_all and not greps:
        log("错误：--grep-all 需要配合 --grep 使用")
        return 1
    filter_active = bool(authors or greps)

    if not ids:
        log("错误：没有选中任何信源")
        return 1

    log(f"抓取 {len(ids)} 个源，时间范围 {args.since}，每源上限 {ctx.limit}…")

    def report(h: dict) -> None:
        flag = "ok  " if h["ok"] else "FAIL"
        dropped = h["fetched"] - h["count"]
        note = f"（{args.since} 过滤掉 {dropped} 条）" if dropped else ""
        log(f"  [{flag}] {h['id']:<16} {h['count']:>3} 条{note} {h['ms']:>5}ms {h['error'] or ''}")

    health, items = fetch_all(ids, ctx, cutoff, on_source=report if args.verbose else None)

    # 顺序是必须的：过滤 → 统计 → 裁剪。过滤要读 author/summary，
    # 而 --fields 可能正好把这两个字段裁掉，先裁就筛不动了。
    filter_block = None
    if filter_active:
        before = len(items)
        items = filter_items(items, authors=authors, greps=greps, grep_all=args.grep_all)

        # 从**去重后**的 items 按源统计，保证 count == sum(sources[].matched)。
        # 用每源过滤前的列表统计会让这两个数对不上。
        counters: dict[str, int] = {}
        for it in items:
            sid = it.get("source")
            counters[sid] = counters.get(sid, 0) + 1
        health = [{**h, "matched": counters.get(h["id"], 0)} for h in health]

        filter_block = {
            "author": authors,
            "grep": greps,
            "before": before,
            "matched": len(items),
        }
        log(f"过滤：{before} → {len(items)} 条")
        if not items:
            # 0 条时最可能的原因是 --limit 太小（过滤发生在抓取之后），
            # 不提示的话用户会以为「这个人没发东西」。
            log(
                "提示：过滤后没有命中。过滤发生在抓取之后，召回受 --limit（每源上限）"
                "和 --since 限制 —— 把这两个调大再试；也不是正则，是字面子串。"
            )

    if fields:
        keep = list(fields)
        # 同 watch.py 的约定：--fields 不该把 matched 裁掉，否则看不出命中原因
        if filter_active and "matched" not in keep:
            keep.append("matched")
        items = [project(it, keep) for it in items]

    payload = {
        "schema": SCHEMA_FETCH,
        "generatedAt": now_iso(),
        "since": args.since,
        "count": len(items),
        "sources": health,
        "items": items,
    }
    # 没过滤时**不加**这个键，保证不加过滤的输出与改动前逐字节一致
    if filter_block is not None:
        payload["filter"] = filter_block

    emit(payload, args.out, ascii_only=args.ascii, pretty=not args.compact)

    if args.out not in (None, "-"):
        log(f"已写入 {args.out}")

    failed = [h["id"] for h in health if not h["ok"]]
    if failed:
        log(f"警告：{len(failed)} 个源失败 — {', '.join(failed)}")
        for h in health:
            if not h["ok"]:
                log(f"  {h['id']}: {h['error']}")

    return exit_code_for(health)


if __name__ == "__main__":
    sys.exit(main())
