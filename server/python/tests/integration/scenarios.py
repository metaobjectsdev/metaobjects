"""Parse scenario YAML into typed records. Mirrors C# / TS scenario types.

Migration scenarios are TS-only now that schema migrations are consolidated to
the TypeScript toolchain (ADR-0015); this module only models query scenarios.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


# ----------------------------------------------------------------------------
# Records (kept dict-shaped where the YAML structure varies — Filter, expect,
# rows — so the runners don't have to manhandle every fixture corner case).
# ----------------------------------------------------------------------------


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
    relation: str | None = None
    #: For ``op: roundtrip``: the field-keyed row to INSERT via the runtime write
    #: path (native authoring forms — a decimal/uuid/temporal as a string, a
    #: ``field.object`` as a dict). The runner inserts it, reads it back by PK,
    #: drops the PK, and asserts the wire-normalized read-back equals ``expect``.
    insert: dict[str, Any] | None = None


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


def load_queries(directory: Path) -> list[QueryScenario]:
    return [_parse_query(p) for p in sorted(directory.glob("*.yaml"))]


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
            relation=q.get("relation"),
            insert=q.get("insert"),
        ))
    return QueryScenario(
        name=raw["name"],
        description=raw.get("description", ""),
        source_path=str(path),
        seed_data=raw.get("seed-data"),
        queries=queries,
    )
