"""可选：把跨 Agent 的适配文件装到仓库根 / .github/。

**默认什么都不做。** 本技能的默认形态是「只新增 skills/hotspot-radar 一个目录」，
不碰仓库里的任何其他位置。

但有些 Agent 只在固定路径找指令文件，放在技能目录里它们扫不到：

    AGENTS.md                         Codex / Cursor / Amp / Windsurf
    .github/copilot-instructions.md   GitHub Copilot

想用哪个就跑哪个：

    py scripts/install-shims.py --agents-md
    py scripts/install-shims.py --copilot
    py scripts/install-shims.py --all
    py scripts/install-shims.py --uninstall

生成的都是**几行的指针**，内容本体仍只在 skills/hotspot-radar/ 下，
不会出现两份需要同步维护的副本。

注意：`.github/copilot-instructions.md` 会对该仓库里**所有人**的 Copilot 请求生效。
公开仓库上跑 --copilot 前请想清楚这一点。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import RadarError, log, setup_stdio_early  # noqa: E402

SHIM_MARK = "<!-- hotspot-radar-shim -->"
SKILL_DIR_NAME = "skills/hotspot-radar"

AGENTS_MD = f"""{SHIM_MARK}
# AGENTS.md

本仓库内含一个自包含的热点监控技能：`{SKILL_DIR_NAME}/`。

当用户问到 **AI 热点 / 今日热点 / 科技资讯 / 热搜 / trending / 舆情 / 盯盘 /
watchlist diff / 日报周报** 这类需求时，先读
[`{SKILL_DIR_NAME}/AGENTS.md`]({SKILL_DIR_NAME}/AGENTS.md)，
再按 [`{SKILL_DIR_NAME}/references/cli.md`]({SKILL_DIR_NAME}/references/cli.md)
里的命令签名执行。

该技能只用 Python 3 标准库，不需要 API Key、不需要 pip 安装、不启动任何服务，
也**不调用任何 LLM** —— 抓取和归一化由脚本完成，去重/聚类/排序/摘要由你来做。

<!-- 本节由 hotspot-radar/scripts/install-shims.py 生成；删除本文件即可卸载。 -->
"""

COPILOT_MD = f"""{SHIM_MARK}
# Copilot instructions

本仓库内含一个自包含的热点监控技能：`{SKILL_DIR_NAME}/`。

当用户问到 **AI 热点 / 今日热点 / 科技资讯 / 热搜 / trending / 舆情 / 盯盘 /
watchlist diff / 日报周报** 这类需求时，遵循 `{SKILL_DIR_NAME}/AGENTS.md`，
并在执行前阅读 `{SKILL_DIR_NAME}/references/cli.md`。

该技能是纯 Python 3 标准库实现，不需要 API Key、不需要安装依赖、不启动服务，
也不做 LLM 调用 —— 分析工作由你（Agent）在脚本产出的 JSON 上完成。

<!-- 本节由 hotspot-radar/scripts/install-shims.py 生成；删除本文件即可卸载。 -->
"""


def find_repo_root(start: Path) -> Path:
    """从技能目录往上找到仓库根（含 .git 的那一层）。"""
    for p in [start, *start.parents]:
        if (p / ".git").exists():
            return p
    raise RadarError(
        f"从 {start} 往上没找到 .git —— 这个技能像是被单独拷出来的，"
        "那就没有「仓库根」可装。此时请把 AGENTS.md 的内容手工交给你的 Agent。"
    )


def install(path: Path, content: str, force: bool) -> None:
    if path.exists():
        existing = path.read_text(encoding="utf-8", errors="replace")
        if SHIM_MARK not in existing and not force:
            log(f"跳过 {path}：已存在同名文件且不是本工具生成的。要覆盖请加 --force。")
            return
        log(f"更新 {path}")
    else:
        log(f"新建 {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def uninstall(path: Path) -> None:
    if not path.exists():
        log(f"跳过 {path}：不存在")
        return
    if SHIM_MARK not in path.read_text(encoding="utf-8", errors="replace"):
        log(f"跳过 {path}：不是本工具生成的，不删。")
        return
    path.unlink()
    log(f"已删除 {path}")
    # 顺手收掉因此变空的父目录（比如 .github/），别留下一个空壳
    try:
        if path.parent.name == ".github" and not any(path.parent.iterdir()):
            path.parent.rmdir()
            log(f"已删除空目录 {path.parent}")
    except OSError:
        pass


def main(argv=None) -> int:
    setup_stdio_early(argv)  # 必须早于 argparse，否则 --help 的中文会乱码
    p = argparse.ArgumentParser(
        prog="install-shims.py",
        description="可选地安装/卸载跨 Agent 适配文件",
    )
    p.add_argument("--agents-md", action="store_true", help="在仓库根写 AGENTS.md")
    p.add_argument("--copilot", action="store_true", help="写 .github/copilot-instructions.md")
    p.add_argument("--all", action="store_true", help="两个都装")
    p.add_argument("--uninstall", action="store_true", help="删除本工具生成的适配文件")
    p.add_argument("--force", action="store_true", help="覆盖已存在的、非本工具生成的文件")
    args = p.parse_args(argv)

    if not any([args.agents_md, args.copilot, args.all, args.uninstall]):
        p.print_help()
        log("\n没有指定动作 —— 什么也没做。这是有意的：本技能默认不碰技能目录以外的任何位置。")
        return 0

    try:
        root = find_repo_root(Path(__file__).resolve().parent)
    except RadarError as e:
        log(f"错误：{e}")
        return 1

    log(f"仓库根：{root}")
    targets: list[tuple[Path, str]] = []
    if args.all or args.agents_md:
        targets.append((root / "AGENTS.md", AGENTS_MD))
    if args.all or args.copilot:
        targets.append((root / ".github" / "copilot-instructions.md", COPILOT_MD))

    if args.uninstall:
        for path, _ in targets:
            uninstall(path)
        return 0

    for path, content in targets:
        install(path, content, args.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
