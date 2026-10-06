"""盯盘：抓取 → 匹配监控词 → 只报「上次之后新增」的条目。

    py scripts/watch.py --add "deepseek,大模型,智能体"
    py scripts/watch.py                 # 日常跑这个
    py scripts/watch.py --list          # 看当前监控词和上次运行时间
    py scripts/watch.py --reset-state   # 重建基线

状态存在 `~/.hotspot-radar/`（可用 `--state-dir` 或 `HOTSPOT_RADAR_HOME` 改），
**不放技能目录** —— 技能目录受 git 管理，升级时可能被整体替换。

    watchlist.json   监控词，可手改
    state.json       已见集合（机器所有）
    state.json.bak   上一次的好副本
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    SCHEMA_STATE,
    SCHEMA_WATCH,
    SCHEMA_WATCHLIST,
    FileLock,
    RadarError,
    atomic_write_json,
    default_state_dir,
    emit,
    exit_code_for,
    log,
    now_iso,
    parse_since,
    project,
    read_json_with_backup,
    setup_stdio_early,
)
from sources import (  # noqa: E402
    add_source_args,
    ctx_from_args,
    fetch_all,
    resolve_sources,
)

DEFAULT_FIRST_RUN_LIMIT = 20
DEFAULT_RETAIN = "30d"
MAX_SEEN = 5000
DEFAULT_MATCH_FIELDS = ["title"]


# ---------------------------------------------------------------------------
# watchlist
# ---------------------------------------------------------------------------


def normalize_keywords(raw) -> list[dict]:
    """接受两种写法，降低手写的摩擦：

        "keywords": ["deepseek", "agent"]
        "keywords": [{"id": "agent", "terms": ["agent","智能体"], "exclude": ["agent orange"]}]
    """
    if not raw:
        return []
    out: list[dict] = []
    for entry in raw:
        if isinstance(entry, str):
            term = entry.strip()
            if term:
                out.append({"id": term, "terms": [term], "match": "any", "sources": ["*"], "exclude": []})
            continue
        if not isinstance(entry, dict):
            continue
        terms = [str(t).strip() for t in (entry.get("terms") or []) if str(t).strip()]
        if not terms:
            single = str(entry.get("id") or "").strip()
            if not single:
                continue
            terms = [single]
        out.append(
            {
                "id": str(entry.get("id") or terms[0]).strip(),
                "terms": terms,
                "match": "all" if entry.get("match") == "all" else "any",
                "sources": [str(s) for s in (entry.get("sources") or ["*"])],
                "exclude": [str(e).strip() for e in (entry.get("exclude") or []) if str(e).strip()],
            }
        )
    return out


def load_watchlist(path: Path) -> dict:
    data = read_json_with_backup(path)
    if not isinstance(data, dict):
        return {"schema": SCHEMA_WATCHLIST, "updatedAt": now_iso(), "keywords": []}
    data["keywords"] = normalize_keywords(data.get("keywords"))
    return data


def save_watchlist(path: Path, data: dict) -> None:
    data["schema"] = SCHEMA_WATCHLIST
    data["updatedAt"] = now_iso()
    atomic_write_json(path, data)


def add_terms(wl: dict, spec: str) -> list[str]:
    """`--add "a,b"` 追加监控词。已存在的跳过，返回本次新增的。"""
    existing = {k["id"] for k in wl["keywords"]}
    added = []
    for part in spec.split(","):
        term = part.strip()
        if not term or term in existing:
            continue
        wl["keywords"].append(
            {"id": term, "terms": [term], "match": "any", "sources": ["*"], "exclude": []}
        )
        existing.add(term)
        added.append(term)
    return added


# ---------------------------------------------------------------------------
# 匹配
# ---------------------------------------------------------------------------


def item_matches(item: dict, kw: dict, fields: list[str]) -> bool:
    haystack_parts = []
    for f in fields:
        v = item.get(f)
        if isinstance(v, str):
            haystack_parts.append(v)
    haystack = " \n ".join(haystack_parts).lower()

    if kw["sources"] and "*" not in kw["sources"] and item.get("source") not in kw["sources"]:
        return False
    if any(e.lower() in haystack for e in kw["exclude"]):
        return False

    hits = [t for t in kw["terms"] if t.lower() in haystack]
    if kw["match"] == "all":
        return len(hits) == len(kw["terms"])
    return bool(hits)


def matched_terms(item: dict, watchlist: dict, fields: list[str]) -> list[str]:
    hits = []
    for kw in watchlist["keywords"]:
        if item_matches(item, kw, fields):
            hits.append(kw["id"])
    return hits


# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------


def dedup_key(item: dict, mode: str) -> str:
    if mode == "id":
        return item["id"]
    if mode == "url":
        from _common import normalize_url

        return normalize_url(item.get("url")) or item["id"]
    if mode == "title":
        return " ".join(str(item.get("title") or "").lower().split())
    raise RadarError(f"未知的 --dedup-by 取值：{mode}（可选 id / url / title）")


def parse_retain(spec: str) -> float:
    """保留期的下界时间戳。`all` → -inf（全部保留）。

    注意 `parse_since` 返回的**已经是 cutoff 时间点**（而不是时长），
    所以这里直接用，不要再减一次 now()。
    """
    cutoff = parse_since(spec)
    if cutoff is None:
        return float("-inf")
    return cutoff.timestamp()


def prune_seen(seen: dict, cutoff_ts: float) -> dict:
    """丢掉过老的条目，再把总量封顶。否则 state 会无限增长。"""
    kept = {}
    for k, v in seen.items():
        try:
            ts = datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        except (ValueError, TypeError):
            ts = 0.0
        if ts >= cutoff_ts:
            kept[k] = v
    if len(kept) > MAX_SEEN:
        ordered = sorted(kept.items(), key=lambda kv: kv[1], reverse=True)
        kept = dict(ordered[:MAX_SEEN])
    return kept


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="watch.py",
        description="盯盘：只报监控词命中的「新增」条目",
        epilog='示例：py scripts/watch.py --add "deepseek,智能体"',
    )
    add_source_args(p)
    g = p.add_argument_group("监控词")
    g.add_argument("--add", help="追加监控词，逗号分隔")
    g.add_argument("--list", action="store_true", help="只看当前监控词与状态，不抓取")
    g.add_argument("--config", help="watchlist 文件路径（默认 <state-dir>/watchlist.json）")
    g.add_argument("--in-fields", default="title", help="在哪些字段里匹配，逗号分隔（默认 title）")

    s = p.add_argument_group("状态")
    s.add_argument("--state-dir", help="状态目录（默认 ~/.hotspot-radar，可用 HOTSPOT_RADAR_HOME 覆盖）")
    s.add_argument("--reset-state", action="store_true", help="丢弃已见集合，把当前内容作为新基线")
    s.add_argument("--dedup-by", default="id", choices=["id", "url", "title"], help="判定「同一条」的依据（默认 id）")
    s.add_argument("--retain", default=DEFAULT_RETAIN, help=f"已见集合保留期（默认 {DEFAULT_RETAIN}）")
    s.add_argument(
        "--first-run-limit",
        type=int,
        default=DEFAULT_FIRST_RUN_LIMIT,
        help=f"首次运行/基线重建时最多报几条（默认 {DEFAULT_FIRST_RUN_LIMIT}）",
    )

    o = p.add_argument_group("输出")
    o.add_argument("--out", help="写到文件而不是 stdout")
    o.add_argument("--fields", help="裁剪每条结果的字段")
    o.add_argument("--ascii", action="store_true", help="输出纯 ASCII")
    o.add_argument("--compact", action="store_true", help="JSON 不缩进")
    return p


def main(argv=None) -> int:
    setup_stdio_early(argv)  # 必须早于 argparse，否则 --help 的中文会乱码
    parser = build_parser()
    args = parser.parse_args(argv)

    state_dir = Path(args.state_dir).expanduser() if args.state_dir else default_state_dir()
    config_path = Path(args.config).expanduser() if args.config else state_dir / "watchlist.json"
    state_path = state_dir / "state.json"
    lock_path = state_dir / "watch.lock"

    try:
        match_fields = [f.strip() for f in args.in_fields.split(",") if f.strip()]
        if not match_fields:
            raise RadarError("--in-fields 不能为空")

        # ---- 只看监控词 ----
        if args.list:
            wl = load_watchlist(config_path)
            st = read_json_with_backup(state_path) or {}
            print(f"状态目录：{state_dir}")
            print(f"监控词文件：{config_path}")
            if not wl["keywords"]:
                print("（还没有监控词，用 --add \"关键词\" 添加）")
            for kw in wl["keywords"]:
                terms = "/".join(kw["terms"])
                src = "全部来源" if "*" in kw["sources"] else ",".join(kw["sources"])
                print(f"  - {kw['id']}: {terms}  [{kw['match']}]  来源={src}")
            print(f"上次运行：{st.get('lastRun') or '从未'}")
            print(f"已见条目：{len(st.get('seen') or {})}")
            return 0

        # ---- 追加监控词 ----
        if args.add:
            wl = load_watchlist(config_path)
            added = add_terms(wl, args.add)
            save_watchlist(config_path, wl)
            if added:
                log(f"已添加监控词：{', '.join(added)}")
            else:
                log("没有新增（这些词已存在）")
            if not args.sources and not args.all_sources:
                # 只是加词就结束，不顺手抓一轮 —— 用户没要求，抓取可能很慢
                return 0

        wl = load_watchlist(config_path)
        if not wl["keywords"]:
            log('错误：还没有任何监控词。先用 --add "关键词" 添加，或用 --list 查看。')
            return 1

        cutoff = parse_since(args.since)
        ctx = ctx_from_args(args)
        # 同 fetch.py：`only` 必须过 resolve_sources 校验，否则打错的源 id
        # 会退化成「该源抓取失败」，而不是用法错误。
        ids = resolve_sources(ctx.extra["only"], args.all_sources)
        if not ids:
            log("错误：没有选中任何信源")
            return 1

        fields = [f.strip() for f in args.fields.split(",")] if args.fields else None

        with FileLock(lock_path):
            log(f"抓取 {len(ids)} 个源，时间范围 {args.since}…")

            def report(h: dict) -> None:
                flag = "ok  " if h["ok"] else "FAIL"
                log(f"  [{flag}] {h['id']:<16} {h['count']:>3} 条 {h['ms']:>5}ms {h['error'] or ''}")

            health, items = fetch_all(ids, ctx, cutoff, on_source=report if args.verbose else None)

            state = read_json_with_backup(state_path) or {}
            first_run = args.reset_state or not state.get("seen")
            seen: dict = {} if args.reset_state else dict(state.get("seen") or {})

            # 先算增量、后更新 state：中途崩溃宁可下轮重复报，也不能丢报。
            fresh = []
            for it in items:
                key = dedup_key(it, args.dedup_by)
                if key in seen:
                    continue
                hits = matched_terms(it, wl, match_fields)
                if hits:
                    fresh.append({**it, "matched": hits, "firstSeenAt": now_iso()})

            baseline = bool(first_run)
            if baseline:
                # 首次运行/state 丢失时，把当前所有条目都当「新增」会直接刷屏。
                # 策略是：全部标记为已见（建立基线），但只回报监控词命中的前 N 条。
                log(
                    f"首次运行或 state 已重置：把当前 {len(items)} 条记为基线，"
                    f"本轮最多回报 {args.first_run_limit} 条命中项。"
                )
                reported = fresh[: max(0, args.first_run_limit)]
            else:
                reported = fresh

            new_seen = dict(seen)
            stamp = now_iso()
            for it in items:
                new_seen[dedup_key(it, args.dedup_by)] = stamp
            new_seen = prune_seen(new_seen, parse_retain(args.retain))

            atomic_write_json(
                state_path,
                {
                    "schema": SCHEMA_STATE,
                    "lastRun": stamp,
                    "runs": int(state.get("runs") or 0) + 1,
                    "seen": new_seen,
                },
            )

        if fields:
            reported = [project(it, fields + ["matched", "firstSeenAt"]) for it in reported]

        payload = {
            "schema": SCHEMA_WATCH,
            "generatedAt": now_iso(),
            "baseline": baseline,
            "dedupBy": args.dedup_by,
            "watchedTerms": [k["id"] for k in wl["keywords"]],
            "fetchedCount": len(items),
            "newCount": len(reported),
            "totalMatched": len(fresh),
            "new": reported,
            "sources": health,
        }
        emit(payload, args.out, ascii_only=args.ascii, pretty=not args.compact)

        failed = [h["id"] for h in health if not h["ok"]]
        if failed:
            log(f"警告：{len(failed)} 个源失败 — {', '.join(failed)}")

        return exit_code_for(health)

    except RadarError as e:
        log(f"错误：{e}")
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
