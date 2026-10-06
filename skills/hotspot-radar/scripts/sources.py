"""信源注册表 + 适配器 + `sources.py` 命令行。

每个适配器负责两件事：
  1. `request(ctx)` → `(url, method, body, headers)`，或直接给一个 URL 字符串
  2. `parse(text, ctype, ctx)` → 未归一化的条目字典列表

归一化（`id` / `rank` / `lang` / 时间解析）统一由 `_common.make_item` 完成，
适配器**不需要**关心跨源一致性。

关于「大陆可达性」
------------------
下列可达性结论是在中国大陆网络下实测的结果（2026-10）。
默认开启的源全部直连可用；默认关闭的源要么被墙、要么需要代理。
详见 `../references/sources.md`。

所有端点**全部免密钥**，这是本技能「下载即用」的前提。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    DEFAULT_LIMIT,
    DEFAULT_RETRIES,
    DEFAULT_TIMEOUT,
    RadarError,
    SchemaError,
    SourceError,
    UA_CHROME,
    build_opener,
    dedupe,
    emit,
    filter_since,
    http_request,
    json_of,
    log,
    make_item,
    now_iso,
    parse_feed,
    require_feed_content_type,
    setup_stdio_early,
)

_BROWSER = {"user-agent": UA_CHROME}

# 无 token 时 GitHub 搜索接口限 10 次/分钟，这里给一个默认主题词，
# 保证「什么都不传」也能跑出内容。用户可用 --query 覆盖。
#
# **不要写成 `topic:ai OR topic:llm`。** 实测 GitHub 搜索 API 不支持限定符之间的
# OR：裸 OR 会返回 422「The search contains only logical operators (AND / OR / NOT)
# without any search terms」，加括号则**静默返回 0 条**（比报错更糟，看起来像源挂了）。
# 单个限定符 `topic:ai created:>=<30天前>` 有约 1 万条结果，按 stars 排序正好是
# 「最近冒头的 AI 项目」，这才是我们要的 trending 语义。
GITHUB_DEFAULT_QUERY = "topic:ai"
GITHUB_DEFAULT_WINDOW_DAYS = 30


# ---------------------------------------------------------------------------
# 各源适配器
# ---------------------------------------------------------------------------


def _req_bilibili(ctx):
    n = min(ctx.limit, 50)  # 该接口 ps 上限 50
    return (
        f"https://api.bilibili.com/x/web-interface/popular?ps={n}&pn=1",
        "GET",
        None,
        {**_BROWSER, "referer": "https://www.bilibili.com/"},
    )


def _parse_bilibili(text, ctype, ctx):
    data = json_of(text, ctype)
    if not isinstance(data, dict):
        raise SchemaError("期望顶层是对象")
    # **HTTP 200 + code:-412 是风控**，不是「没有内容」。
    # 如果这里返回空数组，这个源会静默假死，且没有任何地方会报警。
    if data.get("code") != 0:
        raise SchemaError(f"接口返回 code={data.get('code')} message={data.get('message')!r}")
    lst = (data.get("data") or {}).get("list")
    if not isinstance(lst, list):
        raise SchemaError("data.list 不存在（接口可能已改版）")

    out = []
    for i, v in enumerate(lst[: ctx.limit], 1):
        stat = v.get("stat") or {}
        owner = v.get("owner") or {}
        bvid = v.get("bvid")
        out.append(
            make_item(
                source="bilibili",
                native_id=bvid,
                title=v.get("title"),
                url=f"https://www.bilibili.com/video/{bvid}" if bvid else v.get("short_link"),
                rank=i,
                lang="zh",
                summary=v.get("desc"),
                author=owner.get("name"),
                published=v.get("pubdate"),
                heat=stat.get("view"),
                raw={
                    "view": stat.get("view"),
                    "like": stat.get("like"),
                    "reply": stat.get("reply"),
                    "bvid": bvid,
                },
            )
        )
    return out


_S_DATA_RE = re.compile(r"<!--\s*s-data:(.*?)-->", re.S)


def _parse_baidu(text, ctype, ctx):
    """百度热搜的数据藏在 HTML 注释 `<!--s-data:{...}-->` 里，没有 JSON 接口变体。

    实测结构是 `s-data → data → cards[0].content[]`（外面还套了一层 `data`）。
    这里对多套一层/少套一层都做兼容，避免百度调整包装层时整个源失效。
    """
    m = _S_DATA_RE.search(text)
    if not m:
        raise SchemaError("没找到 <!--s-data:--> 注释块（页面可能已改版）")
    data = json_of(m.group(1), "application/json")

    inner = (data or {}).get("data") if isinstance(data, dict) else None
    cards = (inner or {}).get("cards") if isinstance(inner, dict) else None
    if not cards and isinstance(data, dict):
        cards = data.get("cards")  # 兼容没有外层 data 的版本
    content = next((c.get("content") for c in (cards or []) if c.get("content")), None)
    if content is None:
        raise SchemaError("cards[].content 不存在（页面可能已改版）")

    out = []
    for i, v in enumerate(content[: ctx.limit], 1):
        word = v.get("query") or v.get("word")
        out.append(
            make_item(
                source="baidu",
                native_id=word,
                title=word,
                # rawUrl 通常已是绝对地址；没有就退回搜索页
                url=v.get("rawUrl") or v.get("url"),
                rank=i,
                lang="zh",
                summary=v.get("desc"),
                author=None,
                published=None,  # 榜单没有时间字段
                heat=v.get("hotScore"),
                raw={"hotScore": v.get("hotScore"), "hotChange": v.get("hotChange")},
            )
        )
    return out


def _req_juejin(ctx):
    body = json.dumps(
        {
            "id_type": 2,
            "client_type": 2608,
            "sort_type": 200,  # 200 = 推荐/热榜；300 = 最新
            "cursor": "0",
            "limit": min(ctx.limit, 50),
        }
    ).encode()
    return (
        "https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed",
        "POST",
        body,
        {**_BROWSER, "content-type": "application/json"},
    )


def _parse_juejin(text, ctype, ctx):
    data = json_of(text, ctype)
    if not isinstance(data, dict) or data.get("err_no") not in (0, None):
        raise SchemaError(f"接口返回 err_no={data.get('err_no') if isinstance(data, dict) else '?'}")
    rows = data.get("data")
    if not isinstance(rows, list):
        raise SchemaError("data 不是数组（接口可能已改版）")

    out = []
    for v in rows:
        # 该接口混合了文章和「沸点」等多种 item_type，只要文章
        if v.get("item_type") != 2:
            continue
        info = v.get("item_info") or {}
        art = info.get("article_info") or {}
        aid = art.get("article_id")
        out.append(
            make_item(
                source="juejin",
                native_id=aid,
                title=art.get("title"),
                url=f"https://juejin.cn/post/{aid}" if aid else None,
                rank=len(out) + 1,
                lang="zh",
                summary=art.get("brief_content"),
                author=(info.get("author_user_info") or {}).get("user_name"),
                published=art.get("ctime"),  # 毫秒时间戳，parse_date 会自动识别
                heat=art.get("hot_index") or art.get("view_count"),
                raw={
                    "view": art.get("view_count"),
                    "digg": art.get("digg_count"),
                    "comment": art.get("comment_count"),
                },
            )
        )
        if len(out) >= ctx.limit:
            break
    return out


def _req_github(ctx):
    query = ctx.query or GITHUB_DEFAULT_QUERY
    if ctx.query:
        q = query  # 用户显式给了查询词就原样用，不加时间窗，免得搜不到指定仓库
    else:
        since = (datetime.now(timezone.utc) - timedelta(days=GITHUB_DEFAULT_WINDOW_DAYS)).strftime(
            "%Y-%m-%d"
        )
        q = f"{query} created:>={since}"
    url = "https://api.github.com/search/repositories?" + (
        f"q={_quote(q)}&sort=stars&order=desc&per_page={min(ctx.limit, 100)}"
    )
    headers = {
        **_BROWSER,
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
    }
    # **可选**加速：限流是 10 次/分钟（无 token 时按 IP 算），连跑几次体检就会自己把自己打爆。
    # 带 token 能提到 30 次/分钟。本技能**不要求**任何 API Key —— 这里只是读环境变量，
    # 没有就照常匿名请求，绝不因此报错或提示配置。
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["authorization"] = f"Bearer {token.strip()}"
    return (url, "GET", None, headers)


def _quote(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="")


def _parse_github(text, ctype, ctx):
    data = json_of(text, ctype)
    items = (data or {}).get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise SchemaError("items 不存在（可能是限流或改版）")

    out = []
    for i, v in enumerate(items[: ctx.limit], 1):
        out.append(
            make_item(
                source="github",
                native_id=v.get("id"),
                title=v.get("full_name"),
                url=v.get("html_url"),
                rank=i,
                lang="en",
                summary=v.get("description"),
                author=(v.get("owner") or {}).get("login"),
                published=v.get("pushed_at") or v.get("created_at"),
                heat=v.get("stargazers_count"),
                raw={
                    "stars": v.get("stargazers_count"),
                    "forks": v.get("forks_count"),
                    "language": v.get("language"),
                },
            )
        )
    return out


def _parse_feed_items(source_id, lang, summary_limit=300):
    """RSS/Atom 源的通用解析器工厂。"""

    def _parse(text, ctype, ctx):
        require_feed_content_type(ctype)
        entries = parse_feed(text)
        out = []
        for i, e in enumerate(entries[: ctx.limit], 1):
            item = make_item(
                source=source_id,
                native_id=e.get("native_id"),
                title=e.get("title"),
                url=e.get("url"),
                rank=i,
                lang=lang,
                summary=(e.get("summary") or "")[:summary_limit],
                author=e.get("author"),
                published=e.get("published"),
                heat=None,
                raw={},
            )
            if item:
                out.append(item)
        return out

    return _parse


def _parse_v2ex(text, ctype, ctx):
    rows = json_of(text, ctype)
    if not isinstance(rows, list):
        raise SchemaError("期望顶层是数组")
    out = []
    for i, v in enumerate(rows[: ctx.limit], 1):
        out.append(
            make_item(
                source="v2ex",
                native_id=v.get("id"),
                title=v.get("title"),
                url=v.get("url"),
                rank=i,
                lang="zh",
                summary=v.get("content"),
                author=(v.get("member") or {}).get("username"),
                published=v.get("created"),  # epoch 秒
                heat=v.get("replies"),
                raw={"replies": v.get("replies"), "node": (v.get("node") or {}).get("name")},
            )
        )
    return out


def _parse_hn(text, ctype, ctx):
    data = json_of(text, ctype)
    hits = (data or {}).get("hits") if isinstance(data, dict) else None
    if not isinstance(hits, list):
        raise SchemaError("hits 不存在")
    out = []
    for i, v in enumerate(hits[: ctx.limit], 1):
        out.append(
            make_item(
                source="hn",
                native_id=v.get("objectID"),
                title=v.get("title") or v.get("story_title"),
                url=v.get("url") or f"https://news.ycombinator.com/item?id={v.get('objectID')}",
                rank=i,
                lang="en",
                summary=v.get("story_text"),
                author=v.get("author"),
                published=v.get("created_at_i") or v.get("created_at"),
                heat=v.get("points"),
                raw={"points": v.get("points"), "comments": v.get("num_comments")},
            )
        )
    return out


def _parse_lobsters(text, ctype, ctx):
    rows = json_of(text, ctype)
    if not isinstance(rows, list):
        raise SchemaError("期望顶层是数组")
    out = []
    for i, v in enumerate(rows[: ctx.limit], 1):
        out.append(
            make_item(
                source="lobsters",
                native_id=v.get("short_id"),
                title=v.get("title"),
                url=v.get("url") or f"https://lobste.rs/s/{v.get('short_id')}",
                rank=i,
                lang="en",
                summary=v.get("description_plain"),
                author=(v.get("submitter_user") or {}).get("username")
                if isinstance(v.get("submitter_user"), dict)
                else v.get("submitter_user"),
                published=v.get("created_at"),
                heat=v.get("score"),
                raw={
                    "score": v.get("score"),
                    "comments": v.get("comment_count"),
                    "tags": v.get("tags"),
                },
            )
        )
    return out


def _req_reddit(ctx):
    sub = ctx.extra.get("subreddit") or "MachineLearning"
    return (
        f"https://www.reddit.com/r/{sub}/hot.json?limit={min(ctx.limit, 100)}&raw_json=1",
        "GET",
        None,
        _BROWSER,
    )


def _parse_reddit(text, ctype, ctx):
    data = json_of(text, ctype)
    children = ((data or {}).get("data") or {}).get("children")
    if not isinstance(children, list):
        raise SchemaError("data.children 不存在")
    out = []
    for c in children:
        v = c.get("data") or {}
        if v.get("stickied"):  # 置顶帖不是热点
            continue
        out.append(
            make_item(
                source="reddit",
                native_id=v.get("id"),
                title=v.get("title"),
                url="https://www.reddit.com" + (v.get("permalink") or ""),
                rank=len(out) + 1,
                lang="en",
                summary=v.get("selftext"),
                author=v.get("author"),
                published=v.get("created_utc"),
                heat=v.get("score"),
                raw={"score": v.get("score"), "comments": v.get("num_comments")},
            )
        )
        if len(out) >= ctx.limit:
            break
    return out


_TRENDING_ARTICLE_RE = re.compile(r"<article\b.*?</article>", re.S)
_TRENDING_REPO_RE = re.compile(r'<h2[^>]*>\s*<a[^>]+href="/([^"/]+/[^"]+?)"')
# 总 star 数在 `<svg …></svg>` 之后、`</a>` 之前（不能假设它紧跟 `>`，
# 中间隔着一整个 svg 图标）。
_TRENDING_STARS_RE = re.compile(r'/stargazers".*?</svg>\s*([\d,]+)\s*</a>', re.S)
# 「今日新增 star」才是 trending 的真正热度信号
_TRENDING_TODAY_RE = re.compile(r"([\d,]+)\s+stars?\s+today")


def _parse_github_trending(text, ctype, ctx):
    """GitHub Trending 只能抓 HTML（官方不提供 API）。

    按 `<article>` 切块而不是在整个页面里全局匹配 —— 否则标题和 star 数
    会串行错位（第 N 个仓库配上第 M 个 star 数），这种错误不会报错，
    只会静默给出错误数据。抓不到任何仓库就抛错，不返回空数组。
    """
    blocks = _TRENDING_ARTICLE_RE.findall(text)
    if not blocks:
        # 兜底：某些变体页面可能没有 article 标签，退回全局匹配
        blocks = [text]

    def _num(m):
        try:
            return int(m.group(1).replace(",", "")) if m else None
        except ValueError:
            return None

    out = []
    for block in blocks:
        m = _TRENDING_REPO_RE.search(block)
        if not m:
            continue
        full = m.group(1).strip()
        if any(it["raw"].get("repo") == full for it in out):
            continue

        stars = _num(_TRENDING_STARS_RE.search(block))
        stars_today = _num(_TRENDING_TODAY_RE.search(block))

        out.append(
            make_item(
                source="github-trending",
                native_id=full,
                title=full,
                url=f"https://github.com/{full}",
                # 从 "owner/repo" 里取 owner 当作者。trending 页面上没有独立的
                # 作者栏，但它就是仓库归属者 —— 不补的话 `--author openai`
                # 会**整个漏掉 trending 源**（该字段恒为 null）。与 `github` 源
                # 用 owner.login 的约定保持一致。
                author=full.split("/", 1)[0] or None,
                rank=len(out) + 1,
                lang="en",
                # 用「今日新增」而不是总 star 数：总 star 万级的仓库长期霸榜，
                # 反映不出「今天什么在涨」。取不到就退回总 star。
                heat=stars_today if stars_today is not None else stars,
                raw={"repo": full, "stars": stars, "starsToday": stars_today},
            )
        )
        if len(out) >= ctx.limit:
            break

    if not out:
        raise SchemaError("没解析出仓库（页面结构可能已改版）")
    return out


def _req_hn_firebase(ctx):
    return ("https://hacker-news.firebaseio.com/v0/topstories.json", "GET", None, _BROWSER)


# ---------------------------------------------------------------------------
# 注册表
# ---------------------------------------------------------------------------

REGISTRY: dict[str, dict] = {}


def _register(spec: dict) -> None:
    REGISTRY[spec["id"]] = spec


# ---- 默认开启：大陆直连可用，全部免密钥 ----

_register(
    {
        "id": "bilibili",
        "name": "B站热门视频",
        "kind": "api",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        "request": _req_bilibili,
        "parse": _parse_bilibili,
    }
)
_register(
    {
        "id": "baidu",
        "name": "百度热搜",
        "kind": "html-json",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        "request": "https://top.baidu.com/board?tab=realtime",
        "headers": {**_BROWSER, "referer": "https://top.baidu.com/"},
        "parse": _parse_baidu,
    }
)
_register(
    {
        "id": "juejin",
        "name": "掘金推荐",
        "kind": "api",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        "request": _req_juejin,
        "parse": _parse_juejin,
    }
)
_register(
    {
        "id": "github",
        "name": "GitHub 仓库搜索",
        "kind": "api",
        "default": True,
        "lang": "en",
        "reach": "cn",
        "request": _req_github,
        "parse": _parse_github,
    }
)
_register(
    {
        "id": "36kr",
        "name": "36氪",
        "kind": "rss",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        # 必须带 www. —— 不带会静默返回 HTML 首页（HTTP 200）
        "request": "https://www.36kr.com/feed",
        "headers": _BROWSER,
        "parse": _parse_feed_items("36kr", "zh"),
    }
)
_register(
    {
        "id": "infoq",
        "name": "InfoQ 中国",
        "kind": "rss",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        "request": "https://www.infoq.cn/feed",
        "headers": _BROWSER,
        "parse": _parse_feed_items("infoq", "zh"),
    }
)
_register(
    {
        "id": "sspai",
        "name": "少数派",
        "kind": "rss",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        "request": "https://sspai.com/feed",
        "headers": _BROWSER,
        "parse": _parse_feed_items("sspai", "zh"),
    }
)
_register(
    {
        "id": "ruanyifeng",
        "name": "阮一峰的网络日志",
        "kind": "atom",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        "request": "https://www.ruanyifeng.com/blog/atom.xml",
        "headers": _BROWSER,
        "parse": _parse_feed_items("ruanyifeng", "zh"),
    }
)
_register(
    {
        "id": "solidot",
        "name": "Solidot",
        "kind": "rss",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        "request": "https://www.solidot.org/index.rss",
        "headers": _BROWSER,
        "parse": _parse_feed_items("solidot", "zh"),
    }
)

# 注：v2ex 和 github-trending 曾被一度判定为「需代理」，但连续 3 轮实测
# 都稳定返回 200，因此按实测结论设为默认开启。可达性结论易变，以实测为准 ——
# `sources.py health` 才是判断当前网络下哪些源可用的唯一依据。

_register(
    {
        "id": "v2ex",
        "name": "V2EX 热帖",
        "kind": "api",
        "default": True,
        "lang": "zh",
        "reach": "cn",
        "request": "https://www.v2ex.com/api/topics/hot.json",
        "headers": _BROWSER,
        "parse": _parse_v2ex,
    }
)
_register(
    {
        "id": "github-trending",
        "name": "GitHub Trending",
        "kind": "html",
        "default": True,
        "lang": "en",
        "reach": "cn",
        "request": "https://github.com/trending?since=daily",
        "headers": _BROWSER,
        "parse": _parse_github_trending,
    }
)

# ---- 默认关闭：实测大陆直连不可达 ----

_register(
    {
        "id": "reddit",
        "name": "Reddit r/MachineLearning",
        "kind": "api",
        "default": False,
        "lang": "en",
        "reach": "proxy",  # 实测 HTTP 403 Blocked（数据中心 IP + 反爬）
        "request": _req_reddit,
        "parse": _parse_reddit,
    }
)
_register(
    {
        "id": "hn",
        "name": "Hacker News (Algolia)",
        "kind": "api",
        "default": True,
        "lang": "en",
        # 实测大陆直连可通。**默认开启**：节假日中文源会被社会新闻占满，
        # 那时 AI 内容基本只剩 HN 和 Lobsters —— 关着它俩就要多抓一轮。
        "reach": "intl",
        "request": f"https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage={DEFAULT_LIMIT}",
        "headers": _BROWSER,
        "parse": _parse_hn,
    }
)
_register(
    {
        "id": "lobsters",
        "name": "Lobsters",
        "kind": "api",
        "default": True,
        "lang": "en",
        "reach": "intl",  # 实测大陆直连可通，同上
        "request": "https://lobste.rs/hottest.json",
        "headers": _BROWSER,
        "parse": _parse_lobsters,
    }
)

# 显式不支持（写在这里是为了让 `--list` 和文档有据可依）：
#   zhihu        — 需要签名 Cookie（x-zse），无免密钥路径
#   jiqizhixin   — RSS 已失效（302 跳 HTML 页面）
#   rsshub.app   — 整站从大陆不通
UNSUPPORTED = {
    "zhihu": "需要签名 Cookie（x-zsh），无免密钥路径",
    "jiqizhixin": "RSS 已失效（/rss 302 跳到 data-service 页面）",
    "rsshub": "rsshub.app 从大陆不可达",
}


# ---------------------------------------------------------------------------
# 抓取
# ---------------------------------------------------------------------------


class Ctx:
    """一次抓取的全部上下文。适配器只读它，不改它。"""

    def __init__(self, *, limit, query, opener, timeout, retries, extra=None):
        self.limit = limit
        self.query = query
        self.opener = opener
        self.timeout = timeout
        self.retries = retries
        self.extra = extra or {}


def fetch_source(source_id: str, ctx: Ctx) -> tuple[dict, list[dict]]:
    """抓一个源。永远不抛异常 —— 失败被收敛成一条健康记录。

    返回 `(health, items)`。`items` 在失败时是空列表，
    但调用方必须看 `health["ok"]`，因为空列表也可能是源真的没内容。
    """
    spec = REGISTRY.get(source_id)
    if spec is None:
        return {"id": source_id, "ok": False, "count": 0, "ms": 0, "error": "未知信源"}, []

    t0 = time.monotonic()
    try:
        req = spec["request"]
        if callable(req):
            url, method, body, headers = req(ctx)
        else:
            url, method, body, headers = req, "GET", None, spec.get("headers", _BROWSER)

        _status, ctype, text = http_request(
            url,
            headers=headers,
            method=method,
            body=body,
            timeout=ctx.timeout,
            retries=ctx.retries,
            opener=ctx.opener,
            accept=spec.get("accept"),
        )

        raw_items = spec["parse"](text, ctype, ctx)
        items = [it for it in raw_items if it]
        ms = int((time.monotonic() - t0) * 1000)
        return {"id": source_id, "ok": True, "count": len(items), "ms": ms, "error": None}, items

    except SourceError as e:
        ms = int((time.monotonic() - t0) * 1000)
        return {"id": source_id, "ok": False, "count": 0, "ms": ms, "error": str(e)}, []
    except Exception as e:  # 适配器自身的 bug 也不该拖垮整轮
        ms = int((time.monotonic() - t0) * 1000)
        return {
            "id": source_id,
            "ok": False,
            "count": 0,
            "ms": ms,
            "error": f"{type(e).__name__}: {e}",
        }, []


def fetch_all(ids: list[str], ctx: Ctx, cutoff=None, on_source=None) -> tuple[list[dict], list[dict]]:
    """并发抓取一批源，返回 `(health, items)`。

    每个源有自己的超时和 try/except，所以**一个源挂掉不影响其他** ——
    这是刻意的：热点监控最常见的场景就是某几个源临时不可用。

    `on_source(health)` 在每个源结算后回调一次（用于 verbose 日志）。
    日志放在这一层而不是 worker 里，是因为只有这里才同时知道
    「抓到多少条」和「按时间过滤后剩多少条」。
    """
    workers = max(1, min(len(ids), 8))
    results: dict[str, tuple[dict, list[dict]]] = {}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_source, sid, ctx): sid for sid in ids}
        for fut, sid in futures.items():
            try:
                results[sid] = fut.result()
            except Exception as e:  # 理论上 fetch_source 不抛，兜底防线程池炸掉整轮
                results[sid] = (
                    {
                        "id": sid,
                        "ok": False,
                        "count": 0,
                        "fetched": 0,
                        "ms": 0,
                        "error": f"{type(e).__name__}: {e}",
                    },
                    [],
                )

    # 按传入顺序汇总，让输出对不同轮次保持稳定
    health: list[dict] = []
    items: list[dict] = []
    for sid in ids:
        h, got = results.get(
            sid, ({"id": sid, "ok": False, "count": 0, "fetched": 0, "ms": 0, "error": "未执行"}, [])
        )
        kept = filter_since(got, cutoff)
        h = {**h, "count": len(kept), "fetched": len(got)}
        health.append(h)
        items.extend(kept)
        if on_source:
            on_source(h)

    return health, dedupe(items)


def resolve_sources(only: list[str] | None, all_sources: bool) -> list[str]:
    if only:
        unknown = [s for s in only if s not in REGISTRY]
        if unknown:
            raise RadarError(
                f"未知信源：{', '.join(unknown)}；可用的是：{', '.join(REGISTRY)}"
            )
        return only
    if all_sources:
        return list(REGISTRY)
    return [k for k, v in REGISTRY.items() if v["default"]]


def source_display_name(source_id: str | None) -> str | None:
    spec = REGISTRY.get(source_id) if source_id else None
    return spec.get("name") if spec else None


def filter_items(
    items: list[dict],
    *,
    authors: list[str] | None = None,
    greps: list[str] | None = None,
    grep_all: bool = False,
) -> list[dict]:
    """按发布者 / 关键词做**确定性子串过滤**，返回保留的条目。

    这是本技能里**唯一**在脚本侧做的筛选，所以要划清界线：它只回答
    「这个字符串在不在」（不区分大小写、字面子串、**不是正则**），
    不判断「这条到底相不相关」。相关性排序、跨源去重、可信度分级、写摘要
    仍然是 Agent 的活儿 —— 见 references/taxonomy.md。

    - `authors`：命中 `author` 字段**或**该信源显示名，任一即算命中。
      带上信源名是为了让**机构名**在 RSS 源上也能用 —— RSS 的 `author`
      往往是记者个人而不是媒体名，只比 author 会让 `--author 36氪` 一条都搜不到。
      副作用：`--author github` 会同时命中两个 GitHub 源，这是预期行为。
    - `greps`：命中 `title` 或 `summary` 任一即算命中；`grep_all=True` 则要求全部命中。
    - `authors` 与 `greps` 同时给 = **取交集**（「某人**发布的**、**讲某话题的**」）。
    - 每个保留条目附 `matched`：命中的作者词 + 关键词的**去重并集**（保序）。
      只记 grep 词的话，`--author 36氪` 的命中就没有 provenance，
      分不清是命中记者名还是信源名。

    **必须在 fetch_all() 之后调用。** 过滤是抓取后动作，召回受 `--limit`
    （每源上限）和 `--since` 限制 —— 排在源内靠后的命中项捞不到。
    """
    authors = [a for a in (authors or []) if a]
    greps = [g for g in (greps or []) if g]
    if not authors and not greps:
        return items

    a_low = [a.casefold() for a in authors]
    g_low = [g.casefold() for g in greps]

    out: list[dict] = []
    for it in items:
        # " \n " 拼接而不是直接相接：否则跨字段的假邻接会误命中
        # （同 watch.py 的 item_matches）。
        a_hay = " \n ".join(
            v for v in (it.get("author"), source_display_name(it.get("source")))
            if isinstance(v, str)
        ).casefold()
        a_hits = [a for a, low in zip(authors, a_low) if low in a_hay]
        if a_low and not a_hits:
            continue

        g_hits: list[str] = []
        if g_low:
            g_hay = " \n ".join(
                v for v in (it.get("title"), it.get("summary")) if isinstance(v, str)
            ).casefold()
            g_hits = [g for g, low in zip(greps, g_low) if low in g_hay]
            if grep_all:
                if len(g_hits) != len(g_low):
                    continue
            elif not g_hits:
                continue

        out.append({**it, "matched": list(dict.fromkeys(a_hits + g_hits))})
    return out


def add_source_args(parser: argparse.ArgumentParser, *, default_limit: int = DEFAULT_LIMIT) -> None:
    """抓取相关的公共参数。fetch.py 和 watch.py 共用，保证两边签名一致。"""
    g = parser.add_argument_group("抓取")
    g.add_argument("--sources", help="逗号分隔的信源 id；默认用所有默认开启的源")
    g.add_argument("--all-sources", action="store_true", help="包含默认关闭的信源（目前只剩 reddit，实测 403，需代理）")
    g.add_argument("--no-github", action="store_true", help="跳过 GitHub 源")
    g.add_argument("--since", default="24h", help="时间范围：6h / 24h / 7d / 30d / all（默认 24h）")
    g.add_argument("--limit", type=int, default=default_limit, help=f"每源条数上限（默认 {default_limit}）")
    g.add_argument("--query", help="GitHub 搜索词；不传则用内置 AI 主题默认词")
    g.add_argument("--proxy", help="HTTP 代理，如 http://127.0.0.1:7890（不支持 SOCKS）")
    g.add_argument("--no-proxy", action="store_true", help="忽略环境变量里的代理，强制直连")
    g.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help=f"单源超时秒数（默认 {DEFAULT_TIMEOUT}）")
    g.add_argument("--retries", type=int, default=DEFAULT_RETRIES, help=f"网络错误与 5xx 重试次数（默认 {DEFAULT_RETRIES}；4xx 不重试）")
    g.add_argument("--verbose", action="store_true", help="把每个源的抓取进度打到 stderr")


def ctx_from_args(args) -> Ctx:
    opener = build_opener(proxy=args.proxy, no_proxy=args.no_proxy)
    only = [s.strip() for s in args.sources.split(",") if s.strip()] if args.sources else None
    if args.no_github and only:
        only = [s for s in only if s != "github"]
    elif args.no_github:
        only = [s for s in resolve_sources(None, args.all_sources) if s != "github"]
    return Ctx(
        limit=max(1, args.limit),
        query=args.query,
        opener=opener,
        timeout=args.timeout,
        retries=max(0, args.retries),
        extra={"only": only, "all_sources": args.all_sources, "verbose": args.verbose},
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cmd_list(args) -> int:
    rows = []
    for spec in REGISTRY.values():
        rows.append(
            {
                "id": spec["id"],
                "name": spec["name"],
                "kind": spec["kind"],
                "default": spec["default"],
                "lang": spec["lang"],
                "reach": spec["reach"],
                "url": spec["request"] if isinstance(spec["request"], str) else "(动态构造)",
            }
        )
    if args.json:
        print(json.dumps({"sources": rows, "unsupported": UNSUPPORTED}, ensure_ascii=not args.ascii))
        return 0

    w_id = max(len(r["id"]) for r in rows)
    w_name = max(_disp_len(r["name"]) for r in rows)
    print(f"{'id'.ljust(w_id)}  {'名称'.ljust(w_name)}  {'默认'.ljust(4)}  可达性")
    print("-" * (w_id + w_name + 24))
    for r in rows:
        pad = " " * max(0, w_name - _disp_len(r["name"]))
        print(
            f"{r['id'].ljust(w_id)}  {r['name']}{pad}  "
            f"{('开' if r['default'] else '关'):<4}  {_reach_label(r['reach'])}"
        )
    print()
    print("不可用（无免密钥路径）：")
    for k, v in UNSUPPORTED.items():
        print(f"  {k}: {v}")
    return 0


def _disp_len(s: str) -> int:
    """中文占两个显示宽度，用它来对齐表格。"""
    return sum(2 if ord(c) > 0x2E80 else 1 for c in s)


def _reach_label(reach: str) -> str:
    return {
        "cn": "大陆直连",
        "intl": "国际源（直连可通）",
        "proxy": "需代理",
    }.get(reach, reach)


def _cmd_health(args) -> int:
    ctx = ctx_from_args(args)
    # 同 fetch.py / watch.py：`only` 要过 resolve_sources 校验，
    # 否则 `health --sources <打错的 id>` 会把它当成一个抓取失败的源。
    ids = resolve_sources(ctx.extra["only"], args.all_sources)
    health = []
    for sid in ids:
        h, items = fetch_source(sid, ctx)
        health.append(h)
        flag = "ok  " if h["ok"] else "FAIL"
        log(f"[{flag}] {sid:<16} {h['count']:>3} 条 {h['ms']:>5}ms {h['error'] or ''}")

    payload = {
        "schema": "hotspot-radar/health/v1",
        "generatedAt": now_iso(),
        "ok": sum(1 for h in health if h["ok"]),
        "failed": sum(1 for h in health if not h["ok"]),
        "sources": health,
    }
    if args.json or args.out:
        emit(payload, args.out, ascii_only=args.ascii, pretty=not args.compact)
        return 0

    print(f"合计 {payload['ok']} 通 / {payload['failed']} 失败")
    return 0 if payload["failed"] == 0 else 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="sources.py",
        description="信源清单、健康探测、注册表导出",
    )
    p.add_argument("--ascii", action="store_true", help="输出纯 ASCII（兼容不支持 UTF-8 的旧终端）")
    p.add_argument("--compact", action="store_true", help="JSON 不缩进")

    sub = p.add_subparsers(dest="cmd")

    pl = sub.add_parser("list", help="列出所有信源（默认动作）")
    pl.add_argument("--json", action="store_true", help="输出 JSON 而不是表格")
    pl.set_defaults(func=_cmd_list)

    ph = sub.add_parser("health", help="探测每个源是否可用")
    add_source_args(ph)
    ph.add_argument("--json", action="store_true", help="以 JSON 输出完整结果")
    ph.add_argument("--out", help="结果写到文件")
    ph.set_defaults(func=_cmd_health)

    pe = sub.add_parser("export", help="导出注册表为 JSON")
    pe.set_defaults(func=_cmd_export)
    return p


def _cmd_export(args) -> int:
    payload = {
        "sources": [
            {
                "id": s["id"],
                "name": s["name"],
                "kind": s["kind"],
                "default": s["default"],
                "lang": s["lang"],
                "reach": s["reach"],
                "url": s["request"] if isinstance(s["request"], str) else None,
                "headers": s.get("headers", {}),
            }
            for s in REGISTRY.values()
        ],
        "unsupported": UNSUPPORTED,
    }
    print(json.dumps(payload, ensure_ascii=not args.ascii, indent=None if args.compact else 2))
    return 0


def main(argv=None) -> int:
    setup_stdio_early(argv)  # 必须早于 argparse，否则 --help 的中文会乱码
    parser = build_parser()
    args = parser.parse_args(argv)

    if not getattr(args, "func", None):
        args.func = _cmd_list
    try:
        return args.func(args)
    except RadarError as e:
        log(f"错误：{e}")
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
