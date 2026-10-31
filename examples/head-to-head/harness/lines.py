"""Count the lines each setup makes you write, by one rule on both sides.

The rule: every file under a setup directory is committed source unless it is a
dependency directory, a cache, a lock file or machine-generated output (the GENERATED
list below). Each remaining file falls in exactly one category; a file that matches no
category is an error, so nothing can escape the count. Blank lines and comment-only
lines are not counted.
"""
from __future__ import annotations

import fnmatch
from pathlib import Path

SKIP_DIRS = {"node_modules", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ci-logs"}

# Machine-written or machine-resolved: not counted, and listed so the reader can see them.
GENERATED = {
    "baseline": [
        "generated/*",
        "atlas/migrations/*",
        "contract/released/openapi.yaml",
        "package-lock.json",
        "requirements.txt",
    ],
    "metaobjects": [
        "api/src/generated/*",
        "worker/generated/*",
        ".metaobjects/migrations/*",
        ".metaobjects/.gen-state/*",
        "package-lock.json",
        "requirements.txt",
    ],
}

# Probe files are the same in both setups (the end-to-end smoke probe).
PROBE = ["smoke.sh", "api/smoke.ts"]

CATEGORIES = {
    "baseline": {
        "model": ["spec/main.tsp", "atlas/schema.sql"],
        "config": ["tspconfig.yaml", "atlas.hcl", "mypy.ini", "api/tsconfig.json"],
        "checks": ["ci.sh", "gen.sh", "atlas.sh", "db-apply.sh", "live-drift.sh", "tests/*"],
        "app": ["api/src/*", "worker/*", "prompts/*"],
        "manifest": ["package.json", "requirements.in"],
        "ignore": [".gitignore"],
    },
    "metaobjects": {
        "model": ["metaobjects/*"],
        "config": [
            "metaobjects.config.ts",
            "metaobjects.config.yaml",
            ".metaobjects/config.json",
            "mypy.ini",
            "api/tsconfig.json",
        ],
        "checks": ["ci.sh", "db-apply.sh", "live-drift.sh"],
        "app": ["api/src/*", "worker/*", "prompts/*"],
        "manifest": ["package.json", "requirements.in"],
        "ignore": [".gitignore"],
    },
}
LINE_COMMENT = {".sh": "#", ".py": "#", ".yaml": "#", ".yml": "#", ".hcl": "#", ".ini": "#",
                ".sql": "--", ".ts": "//", ".tsp": "//"}


def _match(rel: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(rel, p) for p in patterns)


def count_file(path: Path) -> int:
    marker = LINE_COMMENT.get(path.suffix)
    n = 0
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or (marker and line.startswith(marker)):
            continue
        n += 1
    return n


def count_setup(root: Path, setup: str) -> dict:
    cats = CATEGORIES[setup]
    totals = {c: 0 for c in cats if c != "ignore"}
    files: dict[str, list[tuple[str, int]]] = {c: [] for c in totals}
    generated: list[str] = []
    probe: list[tuple[str, int]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        rel = path.relative_to(root).as_posix()
        if _match(rel, GENERATED[setup]):
            generated.append(rel)
        elif rel in PROBE:
            probe.append((rel, count_file(path)))
        else:
            for cat, patterns in cats.items():
                if _match(rel, patterns):
                    if cat != "ignore":
                        n = count_file(path)
                        totals[cat] += n
                        files[cat].append((rel, n))
                    break
            else:
                raise SystemExit(f"lines.py: {setup}/{rel} matches no category; add it to CATEGORIES or GENERATED")
    gen_lines = sum(len((root / g).read_text(encoding="utf-8").splitlines()) for g in generated
                    if not g.endswith(("package-lock.json", "requirements.txt")))
    return {"totals": totals, "files": files, "generated_files": len(generated),
            "generated_lines": gen_lines, "probe": probe}
