"""Parse scenario YAML into typed records. Mirrors C# / TS scenario types."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


# ----------------------------------------------------------------------------
# Records (kept dict-shaped where the YAML structure varies — Filter, expect,
# rows — so the runners don't have to manhandle every fixture corner case).
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class BlockedChange:
    kind: str
    reason_contains: str


@dataclass(frozen=True)
class ApplyUpThenQuery:
    sql: str
    rows: list[dict[str, Any]]


@dataclass(frozen=True)
class MigrationExpect:
    blocked: list[BlockedChange] = field(default_factory=list)
    up_contains: list[str] = field(default_factory=list)
    up_empty: bool | None = None
    apply_up_then_query: ApplyUpThenQuery | None = None


@dataclass(frozen=True)
class MigrationScenario:
    name: str
    description: str
    source_path: str
    seed_metadata_dir: str | None
    seed_data: str | None
    target_metadata_dir: str | None
    target_metadata_inline: str | None
    expect: MigrationExpect


@dataclass(frozen=True)
class SortSpec:
    field: str
    dir: str


@dataclass(frozen=True)
class QuerySpec:
    name: str
    op: str
    entity: str
    by: dict[str, Any] | None
    filter: dict[str, Any] | None
    sort: list[SortSpec] | None
    limit: int | None
    offset: int | None
    expect: Any


@dataclass(frozen=True)
class QueryScenario:
    name: str
    description: str
    source_path: str
    seed_data: str | None
    queries: list[QuerySpec]


# ----------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------


def find_corpus_root(start: Path | None = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "persistence-conformance"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError(f"Could not find fixtures/persistence-conformance from {Path.cwd().resolve()}")


def load_migrations(directory: Path) -> list[MigrationScenario]:
    return [_parse_migration(p) for p in sorted(directory.glob("*.yaml"))]


def load_queries(directory: Path) -> list[QueryScenario]:
    return [_parse_query(p) for p in sorted(directory.glob("*.yaml"))]


def _parse_migration(path: Path) -> MigrationScenario:
    raw = yaml.safe_load(path.read_text())
    e = raw.get("expect") or {}
    auq_raw = e.get("apply-up-then-query")
    auq = ApplyUpThenQuery(
        sql=auq_raw.get("sql", ""),
        rows=auq_raw.get("rows", []) or [],
    ) if auq_raw else None
    return MigrationScenario(
        name=raw["name"],
        description=raw.get("description", ""),
        source_path=str(path),
        seed_metadata_dir=_resolve(path.parent, raw.get("seed-metadata")),
        seed_data=raw.get("seed-data"),
        target_metadata_dir=_resolve(path.parent, raw.get("target-metadata")),
        target_metadata_inline=raw.get("target-metadata-inline"),
        expect=MigrationExpect(
            blocked=[BlockedChange(b["kind"], b.get("reason-contains", "")) for b in e.get("blocked", []) or []],
            up_contains=e.get("up-contains", []) or [],
            up_empty=e.get("up-empty"),
            apply_up_then_query=auq,
        ),
    )


def _parse_query(path: Path) -> QueryScenario:
    raw = yaml.safe_load(path.read_text())
    queries = []
    for q in raw.get("queries", []) or []:
        sorts = q.get("sort")
        sort_specs = [SortSpec(s["field"], s.get("dir", "asc")) for s in sorts] if sorts else None
        queries.append(QuerySpec(
            name=q["name"],
            op=q["op"],
            entity=q["entity"],
            by=q.get("by"),
            filter=q.get("filter"),
            sort=sort_specs,
            limit=q.get("limit"),
            offset=q.get("offset"),
            expect=q.get("expect"),
        ))
    return QueryScenario(
        name=raw["name"],
        description=raw.get("description", ""),
        source_path=str(path),
        seed_data=raw.get("seed-data"),
        queries=queries,
    )


def _resolve(scenario_dir: Path, relative: str | None) -> str | None:
    if not relative:
        return None
    return str((scenario_dir / relative).resolve())
