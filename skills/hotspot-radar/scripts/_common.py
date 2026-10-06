"""hotspot-radar 引擎：信源注册表、HTTP 抓取、归一化、RSS/Atom 解析。

**只用 Python 3 标准库**，不依赖任何第三方包。
支持 Python 3.8+，跨平台（Windows / macOS / Linux）。

设计原则
--------
1. 脚本只负责「抓取 + 归一化」，分析（去重 / 聚类 / 排序 / 摘要）交给调用它的 Agent。
   这里不调用任何 LLM。
2. 一个信源挂掉**不能**影响整轮 —— 所有网络异常都被收敛成一条 `ok: false` 的
   健康记录，而不是让进程崩掉。
3. **结构缺失一律报错，绝不返回空数组。**
   空的含义必须是「真的没有内容」。如果 B 站改版让 `data.list` 消失了，
   返回 `[]` 会让这个源静默假死好几天 —— 报错至少能在 sources 健康块里看见。
"""

from __future__ import annotations

import email.utils
import gzip
import html
import http.client
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree

SCHEMA_FETCH = "hotspot-radar/fetch/v1"
SCHEMA_WATCH = "hotspot-radar/watch/v1"
SCHEMA_WATCHLIST = "hotspot-radar/watchlist/v1"
SCHEMA_STATE = "hotspot-radar/state/v1"

DEFAULT_LIMIT = 50
DEFAULT_TIMEOUT = 15
DEFAULT_RETRIES = 1

# 真实浏览器 UA。默认的 `Python-urllib/3.x` 会被 GitHub 直接 403、
# 被百度/B站判定为爬虫触发风控，所以每个源都必须带上它。
UA_CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# 显式要求不压缩。若邀请 gzip 就得自己解压；更糟的是某些 CDN 会回 Brotli，
# 而标准库没有 Brotli 解码器。发 identity 一次绕开两个问题。
_ACCEPT_ENCODING = "identity"

# ---------------------------------------------------------------------------
# 异常
# ---------------------------------------------------------------------------


class RadarError(Exception):
    """本工具所有可预期错误的基类。"""


class SourceError(RadarError):
    """网络层 / HTTP 层失败（超时、DNS、403、5xx…）。"""


class SchemaError(SourceError):
    """HTTP 200，但响应结构不是我们认识的样子。

    单独成类是为了在排查时能区分「源挂了」和「源改版了」——
    前者等一会儿会自己好，后者需要改代码。
    """


# ---------------------------------------------------------------------------
# 控制台编码
# ---------------------------------------------------------------------------


def setup_stdio(ascii_only: bool = False) -> None:
    """把 stdout/stderr 切到 UTF-8。

    Windows 中文版下 Python 默认按控制台代码页（cp936）写 stdout，
    `print("中文")` 会输出乱码。这不是可选的美化 —— 是正确性问题。
    所有脚本入口都必须先调这个。
    """
    enc = "ascii" if ascii_only else "utf-8"
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding=enc, errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError, OSError):
            # 被重定向到不支持 reconfigure 的对象时忽略即可
            pass


def setup_stdio_early(argv=None) -> None:
    """在 `argparse` **之前**调用。

    必须在解析参数前切编码：`--help` 是在 `parse_args()` 内部打印并直接退出的，
    等解析完再调 `setup_stdio()` 就太晚了 —— 中文说明在中文 Windows 上会整段乱码。
    这是 `--help` 这条最高频路径上的用户可见问题，不能只靠"用户自己加 --ascii"。

    此时还没有解析结果，所以直接扫一遍 argv 找 `--ascii`。
    """
    args = sys.argv[1:] if argv is None else argv
    setup_stdio(ascii_only="--ascii" in args)


def log(msg: str) -> None:
    """诊断信息一律走 stderr，保证 stdout 只有 JSON。"""
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------------------
# 时间
# ---------------------------------------------------------------------------

_WS_RE = re.compile(r"\s+")


def parse_since(spec: str):
    """`'24h'` / `'6h'` / `'7d'` / `'30d'` / `'all'` → 时间下限，或 None 表示不限。"""
    if not spec or spec == "all":
        return None
    m = re.fullmatch(r"(\d+)\s*([hdm])", spec.strip().lower())
    if not m:
        raise RadarError(f"--since 格式不对：{spec!r}（应为 6h / 24h / 7d / all）")
    n, unit = int(m.group(1)), m.group(2)
    delta = {"m": timedelta(minutes=n), "h": timedelta(hours=n), "d": timedelta(days=n)}[unit]
    return datetime.now(timezone.utc) - delta


def parse_date(raw) -> str | None:
    """尽最大努力把各种日期格式解析成 ISO-8601 UTC 字符串。

    解析不出来就返回 None —— **绝不猜、绝不编造时间**。
    调用方据此决定是否丢弃该条（`publishedAt` 为 None 的条目会被保留，
    因为「不知道时间」和「时间很旧」是两回事）。

    真实踩过的坑：36氪的 `pubDate` 是 `"2026-10-05 16:36:43  +0800"`
    （双空格、无星期），`email.utils.parsedate_to_datetime` 会直接抛 ValueError。
    """
    if raw is None:
        return None

    # epoch 秒 / 毫秒（B站 pubdate、掘金 ctime）
    if isinstance(raw, (int, float)):
        return _from_epoch(float(raw))
    if isinstance(raw, str) and re.fullmatch(r"\d{9,13}", raw.strip()):
        return _from_epoch(float(raw.strip()))

    s = _WS_RE.sub(" ", str(raw).strip())
    if not s:
        return None

    # RFC 822 / RFC 1123（绝大多数 RSS）
    try:
        dt = email.utils.parsedate_to_datetime(s)
        if dt is not None:
            return _to_iso(dt)
    except (TypeError, ValueError, IndexError):
        pass

    # 36氪式：`2026-10-05 16:36:43 +0800`（空格已在上方压平）
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return _to_iso(datetime.strptime(s, fmt))
        except ValueError:
            continue

    # ISO-8601（Atom published/updated）
    try:
        return _to_iso(datetime.fromisoformat(s.replace("Z", "+00:00")))
    except ValueError:
        pass

    return None


def _from_epoch(v: float) -> str:
    # 13 位当毫秒。阈值取 1e11 秒 ≈ 公元 5138 年，真实秒级时间戳不会误伤。
    if v > 1e11:
        v = v / 1000.0
    return _to_iso(datetime.fromtimestamp(v, tz=timezone.utc))


def _to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        # 无时区的按 UTC 解读。多数源会带时区，走到这里说明源本身不规范，
        # 与其猜本地时区不如统一按 UTC —— 至少跨机器结果是稳定的。
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def build_opener(proxy: str | None = None, no_proxy: bool = False, insecure: bool = False):
    """构造 opener，代理优先级：`--proxy` > `--no-proxy` > 环境变量 > 直连。

    注意 urllib **不支持 SOCKS 代理**（标准库没有 PySocks）。
    用 Clash 时必须给 HTTP 端口（通常 7890），不是 SOCKS 端口（7891）。
    """
    handlers: list = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    elif no_proxy:
        handlers.append(urllib.request.ProxyHandler({}))
    # 两者都没有时不加 ProxyHandler：默认的那个会自己读 HTTP(S)_PROXY / ALL_PROXY

    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        handlers.append(urllib.request.HTTPSHandler(context=ctx))

    return urllib.request.build_opener(*handlers)


def _short_error_body(text: str, limit: int = 160) -> str:
    """把错误响应体压成一行短摘要，供 `error` 字段使用。

    两个理由：
    1. 有的站点（Reddit 的 403 就是）返回整页 HTML，原样内联会让 `error`
       膨胀到几百字符。而读这份 JSON 的通常是 Agent —— 这是纯烧 token。
    2. HTML 里没有任何可诊断的信息（都是 `<style>` 和布局标签），
       所以直接报类型，不报内容。

    JSON 错误体则**保留**：`{"code":-412,"message":"请求被拦截"}` 这类
    恰恰是最有用的线索。
    """
    t = " ".join((text or "").split())
    if not t:
        return ""
    if t.startswith("<"):
        return "（HTML 响应，略）"
    return t[:limit] + ("…" if len(t) > limit else "")


def http_request(
    url: str,
    *,
    headers: dict | None = None,
    method: str = "GET",
    body: bytes | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    opener=None,
    accept: str | None = None,
) -> tuple[int, str, str]:
    """发一个请求，返回 `(status, content_type, text)`。

    失败抛 `SourceError`。重试**网络层错误**和 **HTTP 5xx**；4xx（403/422 等
    风控与限流）不重试 —— 重试一个 403 只会浪费一次超时。

    5xx 要重试是因为它**真的是瞬时的**：实测 `github.com/trending` 会以约 1/4 的
    概率回 500（同一时刻、同一请求头，连续发就会时而 200 时而 500），
    不重试就整个源失败了。
    """
    hdrs = {
        "user-agent": UA_CHROME,
        "accept": accept or "*/*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "accept-encoding": _ACCEPT_ENCODING,
    }
    if headers:
        hdrs.update({k.lower(): v for k, v in headers.items()})
    if body is not None and "content-type" not in hdrs:
        hdrs["content-type"] = "application/json"

    opener = opener or urllib.request.build_opener()
    last_err: Exception | None = None

    for attempt in range(retries + 1):
        if attempt:
            time.sleep(1.0 * attempt)  # 线性退避，够用且不拖慢整轮
        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        try:
            with opener.open(req, timeout=timeout) as resp:
                raw = resp.read()
                ctype = resp.headers.get("content-type", "") or ""
                raw = _maybe_decompress(raw, resp.headers.get("content-encoding", ""))
                return resp.status, ctype, _decode(raw, ctype)
        except urllib.error.HTTPError as e:
            # HTTPError 是异常也是响应，读掉 body 方便报错时带上片段
            detail = ""
            try:
                detail = _decode(_maybe_decompress(e.read(), e.headers.get("content-encoding", "")), "")
            except Exception:
                pass
            snippet = _short_error_body(detail)
            err = SourceError(f"HTTP {e.code} {e.reason}{' — ' + snippet if snippet else ''}")
            if not 500 <= e.code < 600:
                raise err from e
            # 5xx 是服务端瞬时故障，值得再试一次；4xx 不是（见 docstring）。
            last_err = err
        except http.client.IncompleteRead as e:
            # 服务端在响应中途断连（实测 github.com/trending 会这样：约 540KB 的
            # 页面读了一半就断）。同样是瞬时的，重试即可。
            last_err = SourceError(f"IncompleteRead: 只读到 {len(e.partial)} 字节")
        except urllib.error.URLError as e:
            last_err = SourceError(f"URLError: {e.reason}")
        except (socket.timeout, TimeoutError) as e:
            last_err = SourceError(f"超时（{timeout}s）")
        except ssl.SSLError as e:
            last_err = SourceError(f"TLS 失败: {e}")
        except OSError as e:
            last_err = SourceError(f"网络错误: {e}")

    raise last_err or SourceError("未知网络错误")


def _maybe_decompress(raw: bytes, encoding: str) -> bytes:
    enc = (encoding or "").lower()
    if "gzip" in enc:
        try:
            return gzip.decompress(raw)
        except OSError:
            return raw
    if "deflate" in enc:
        try:
            return zlib.decompress(raw)
        except zlib.error:
            try:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
            except zlib.error:
                return raw
    return raw


def _decode(raw: bytes, content_type: str) -> str:
    m = re.search(r'charset=["\']?([\w-]+)', content_type or "", re.I)
    enc = m.group(1) if m else "utf-8"
    try:
        return raw.decode(enc, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def json_of(text: str, ctype: str = "") -> object:
    """解析 JSON，失败时给出「源改版了」而不是「源挂了」的诊断。"""
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        # 有些源用 HTML 页面冒充接口（36kr 漏掉 www 就是这样），
        # 报错里带上开头一小段，一眼能看出来拿到的是网页还是 JSON。
        head = _WS_RE.sub(" ", text.strip())[:120]
        raise SchemaError(f"响应不是合法 JSON（Content-Type={ctype or '?'}）：{head!r}") from e


# ---------------------------------------------------------------------------
# RSS / Atom
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_FEED_CTYPES = ("xml", "rss", "atom")


def require_feed_content_type(ctype: str) -> None:
    """RSS 源必须真的返回 XML。

    36kr 不带 www 时会**静默**返回 HTML 首页（HTTP 200），
    不校验的话会被当成「零条目的正常源」，永远查不出问题。
    """
    if ctype and not any(k in ctype.lower() for k in _FEED_CTYPES):
        raise SchemaError(f"期望 XML/RSS，实际 Content-Type={ctype}")


def strip_html(s, limit: int = 300) -> str | None:
    if not s:
        return None
    text = html.unescape(_TAG_RE.sub(" ", str(s)))
    text = _WS_RE.sub(" ", text).strip()
    if not text:
        return None
    return text[:limit]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _child_text(el, *names: str) -> str | None:
    wanted = set(names)
    for child in el:
        if _local(child.tag) in wanted:
            txt = (child.text or "").strip()
            if txt:
                return txt
    return None


def _atom_link(el) -> str | None:
    """Atom 的链接在 href 属性上，且可能有多个 rel；优先取 alternate。"""
    fallback = None
    for child in el:
        if _local(child.tag) != "link":
            continue
        href = child.get("href")
        if not href:
            continue
        if child.get("rel", "alternate") == "alternate":
            return href.strip()
        fallback = fallback or href.strip()
    return fallback


def parse_feed(text: str) -> list[dict]:
    """解析 RSS 2.0 / Atom，返回未归一化的条目字典。

    自己解析而不是用 feedparser —— 后者是第三方依赖，而本技能要求零安装。
    """
    try:
        root = ElementTree.fromstring(text.strip())
    except ElementTree.ParseError as e:
        head = _WS_RE.sub(" ", text.strip())[:120]
        raise SchemaError(f"XML 解析失败：{e} — 开头是 {head!r}") from e

    kind = _local(root.tag)
    out: list[dict] = []

    if kind == "rss":
        for el in root.iter():
            if _local(el.tag) != "item":
                continue
            link = _child_text(el, "link") or _child_text(el, "guid")
            out.append(
                {
                    "native_id": _child_text(el, "guid") or link,
                    "title": _child_text(el, "title"),
                    "url": link,
                    "summary": _child_text(el, "description", "summary", "encoded"),
                    "author": _child_text(el, "creator", "author"),
                    "published": _child_text(el, "pubDate", "date", "published"),
                }
            )
    elif kind == "feed":
        for el in root.iter():
            if _local(el.tag) != "entry":
                continue
            author_el = next((c for c in el if _local(c.tag) == "author"), None)
            out.append(
                {
                    "native_id": _child_text(el, "id") or _atom_link(el),
                    "title": _child_text(el, "title"),
                    "url": _atom_link(el),
                    "summary": _child_text(el, "summary", "content"),
                    "author": (author_el is not None and _child_text(author_el, "name")) or None,
                    "published": _child_text(el, "published", "updated"),
                }
            )
    else:
        raise SchemaError(f"未知的 feed 根元素：<{kind}>")

    return out


# ---------------------------------------------------------------------------
# 归一化
# ---------------------------------------------------------------------------


def make_item(
    *,
    source: str,
    native_id,
    title,
    url: str | None,
    rank: int,
    lang: str,
    summary=None,
    author=None,
    published=None,
    heat=None,
    raw: dict | None = None,
) -> dict | None:
    """构造一条归一化条目。标题为空则返回 None（调用方过滤掉）。"""
    title = strip_html(title, 200) if title else None
    if not title:
        return None

    native_id = str(native_id).strip() if native_id else ""
    if native_id.startswith(("http://", "https://")):
        # 很多 RSS 的 `<guid>` 本身就是带跟踪参数的 URL（36氪 `?f=rss`、
        # InfoQ `?utm_source=rss&utm_medium=article`）。这些参数会随分发渠道变化，
        # 原样当 id 会让同一条内容每轮抓取都被判成「新增」，盯盘直接变成刷屏。
        native_id = normalize_url(native_id) or native_id
    elif not native_id:
        # 没有任何原生 id 的源用 URL 兜底，再没有就用标题 ——
        # 总比在 id 里塞随机数好，随机 id 会让盯盘每次都报新增。
        native_id = normalize_url(url) or url or title

    return {
        "id": f"{source}:{native_id}",
        "source": source,
        "title": title,
        "url": url,
        "summary": strip_html(summary),
        "author": (str(author).strip() or None) if author else None,
        "publishedAt": parse_date(published),
        "heat": as_int(heat),
        "rank": rank,
        "lang": lang,
        "raw": raw or {},
    }


def as_int(v):
    """把热度值转成 int。

    百度热搜的 `hotScore` 是**字符串**（`"7981234"`），B站是 int，
    掘金是 int —— 不统一强转的话，Agent 排序时会拿到混合类型。
    """
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str) and re.fullmatch(r"-?\d+", v.strip()):
        return int(v.strip())
    return None


# 需要剥掉的跟踪/渠道参数。前缀匹配的见表，其余精确匹配。
#
# 刻意**不含** `source` / `src`：这两个名字足够通用，某些站点拿它表达真实语义
# （不同来源的视频/文章是不同的条目），剥掉会把两条内容悄悄合并成一条 ——
# 那比多报一次更难发现。只剥我们确证过是纯跟踪用途的那些。
_TRACKING_PREFIXES = ("utm_", "share_", "spm_")
_TRACKING_EXACT = {
    "f",  # 36氪 RSS：`?f=rss`
    "from",
    "from_source",
    "ref",
    "refer",
    "spm_id_from",
}


def normalize_url(url: str | None) -> str | None:
    """剥掉跟踪参数并去掉 fragment，得到一个稳定的 URL。

    只用于**生成 id / 比对**，绝不改写返回给用户看的 `url` ——
    用户点进去时那些参数可能就是必须的。
    """
    if not url:
        return None
    try:
        parts = urllib.parse.urlsplit(url.strip())
    except ValueError:
        return url.strip()

    kept = []
    for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        lk = k.lower()
        if lk in _TRACKING_EXACT or lk.startswith(_TRACKING_PREFIXES):
            continue
        kept.append((k, v))
    query = urllib.parse.urlencode(kept)

    return urllib.parse.urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path, query, "")
    )


def filter_since(items: list[dict], cutoff) -> list[dict]:
    """按发布时间过滤。

    `publishedAt` 为 None 的条目**保留** —— 「不知道什么时候发的」不等于
    「很旧」。百度热搜这类源根本没有时间字段，丢掉它们等于把这个源废掉。
    """
    if cutoff is None:
        return items
    kept = []
    for it in items:
        ts = it.get("publishedAt")
        if ts is None:
            kept.append(it)
            continue
        try:
            dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            kept.append(it)
            continue
        if dt >= cutoff:
            kept.append(it)
    return kept


def dedupe(items: list[dict]) -> list[dict]:
    """同一条目在多轮/多源里重复时保留首个。id 是唯一键。"""
    seen: set[str] = set()
    out = []
    for it in items:
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        out.append(it)
    return out


def project(item: dict, fields: list[str] | None) -> dict:
    """`--fields` 字段裁剪，用来省 token。"""
    if not fields:
        return item
    return {k: item.get(k) for k in fields if k in item}


# ---------------------------------------------------------------------------
# 状态目录
# ---------------------------------------------------------------------------

_STATE_ENV = "HOTSPOT_RADAR_HOME"


def default_state_dir() -> Path:
    """状态目录：环境变量 > `~/.hotspot-radar`。

    **刻意不放在技能目录里** —— 技能目录受 git 管理，升级时可能整体替换或只读，
    用户数据放进去会丢。
    """
    env = os.environ.get(_STATE_ENV)
    if env:
        return Path(env).expanduser()
    return Path.home() / ".hotspot-radar"


def ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def atomic_write_json(path: Path, data) -> None:
    """先写临时文件再 `os.replace` 原子替换，避免半截文件。

    同时留一份 `.bak`：state 损坏时还有上一次的好副本可用。
    """
    ensure_dir(path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    tmp.write_text(payload, encoding="utf-8")
    if path.exists():
        try:
            os.replace(path, path.with_suffix(path.suffix + ".bak"))
        except OSError:
            pass
    os.replace(tmp, path)


def read_json(path: Path):
    """读 JSON，损坏返回 None（调用方决定兜底策略）。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def read_json_with_backup(path: Path):
    """先读主文件，坏了再试 `.bak`。都失败返回 None。"""
    data = read_json(path)
    if data is not None:
        return data
    bak = path.with_suffix(path.suffix + ".bak")
    return read_json(bak)


class FileLock:
    """跨进程互斥锁，用于保护 state 的「读-改-写」。

    盯盘最常见的部署方式是 cron / 定时任务，两轮重叠时若不加锁，
    后写入的那轮会覆盖前一轮的 `seen` 集合，导致**漏报** ——
    而漏报恰恰是监控类工具最难被发现的失败模式。

    过期的锁会被回收（默认 10 分钟）：进程被 kill -9 时锁文件会残留，
    不回收的话这个功能就永久卡死了。
    """

    def __init__(self, path: Path, stale_seconds: float = 600.0):
        self.path = path
        self.stale_seconds = stale_seconds
        self.acquired = False

    def __enter__(self):
        ensure_dir(self.path.parent)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            self.acquired = True
        except FileExistsError:
            try:
                age = time.time() - self.path.stat().st_mtime
            except OSError:
                age = 0.0
            if age > self.stale_seconds:
                log(f"回收过期的锁文件（{int(age)}s 前，可能是上次被强杀）：{self.path}")
                try:
                    self.path.unlink()
                    return self.__enter__()
                except OSError:
                    pass
            raise RadarError(f"另一个 hotspot-radar 进程正在运行（锁：{self.path}）。稍后重试。")
        return self

    def __exit__(self, *exc):
        if self.acquired:
            try:
                self.path.unlink()
            except OSError:
                pass
        return False


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def emit(payload, out: str | None, ascii_only: bool = False, pretty: bool = True) -> None:
    """写结果。`out` 为 None 或 `-` 时写 stdout；否则写文件。

    写文件时 stdout 只回一行「收据」，避免大 JSON 被塞进 Agent 上下文两遍。
    """
    text = json.dumps(
        payload,
        ensure_ascii=ascii_only,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    if out in (None, "-"):
        sys.stdout.write(text + "\n")
        return

    path = Path(out).expanduser()
    ensure_dir(path.parent)
    path.write_text(text, encoding="utf-8")
    receipt = {
        "out": str(path),
        "count": payload.get("count", payload.get("newCount")),
        "sourcesOk": sum(1 for s in payload.get("sources", []) if s.get("ok")),
        "sourcesFailed": sum(1 for s in payload.get("sources", []) if not s.get("ok")),
    }
    sys.stdout.write(json.dumps(receipt, ensure_ascii=ascii_only) + "\n")


def exit_code_for(sources: list[dict]) -> int:
    """0 全部成功 / 2 部分失败 / 3 全失败。

    只是给 shell 用的提示；**JSON 内容才是准**（Agent 应该读 JSON）。
    """
    if not sources:
        return 3
    ok = sum(1 for s in sources if s.get("ok"))
    if ok == len(sources):
        return 0
    return 2 if ok else 3
