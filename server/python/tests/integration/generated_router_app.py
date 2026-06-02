"""SP-F Unit 4 — boot the GENERATED FastAPI router over HTTP.

Unlike ``api_contract_server.py`` (the hand-rolled reference lane, which mirrors
what ``router_generator`` emits), this harness runs the REAL generators
(``render_router`` + ``render_filter_allowlist``) for the corpus ``Author``
entity, writes the emitted modules to a temp package, imports the generated
router UNMODIFIED, and mounts it on a FastAPI app. The generated router is the
artifact under test.

The generated router declares a consumer-supplied persistence seam
(``get_repository`` raising ``NotImplementedError``, overridden via
``app.dependency_overrides``). MetaObjects intentionally does NOT generate the
repository impl. We fill it with a minimal in-memory ``AuthorRepository`` that
faithfully applies the controller-passed ``FilterPredicate``s / sort / paging to
a seeded list — so the generated router's qs→predicate translation, allowlist
validation, pagination, status codes, and error envelopes are genuinely
exercised. The repo is the ONLY hand-written piece, and it sits behind the
generated router's seam — it is test scaffolding, not a conformance subject
(real DB behavior is owned by persistence-conformance).

No Testcontainers: the controller is the artifact, not the DB.
"""
from __future__ import annotations

import importlib.util
import re
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.runtime.filter_parser import FilterPredicate
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


# ---------------------------------------------------------------------------
# Generate → write temp package → import the EMITTED router unmodified
# ---------------------------------------------------------------------------


def _find_author_entity(meta_json: Path) -> MetaObject:
    """Load the corpus metadata and return the ``Author`` MetaObject."""
    # Load just meta.json (copied into its own dir) so the loader doesn't try to
    # parse the sibling seed.json / scenario yaml as metadata.
    tmp = Path(tempfile.mkdtemp(prefix="apic-meta-"))
    shutil.copy(meta_json, tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    if result.errors:
        msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
        raise RuntimeError(f"corpus meta.json failed to load: {msgs}")
    objects = [
        c for c in result.root.children()
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
    ]
    for obj in objects:
        if obj.name == "Author" or obj.name.endswith("::Author"):
            return obj
    raise RuntimeError(f"Author entity not found among {[o.name for o in objects]}")


def build_generated_app(corpus_root: Path) -> tuple[FastAPI, "InMemoryAuthorRepository"]:
    """Generate the Author router, import it, mount it, and wire the seam.

    Returns ``(app, repo)``; the test resets/seeds ``repo`` per scenario.
    """
    author = _find_author_entity(corpus_root / "meta.json")

    router_src = render_router(author)
    allowlist_src = render_filter_allowlist(author)
    if router_src is None or allowlist_src is None:
        raise RuntimeError("router_generator / filter_allowlist_generator returned None for Author")

    # Emit into a uniquely-named temp package so the router's relative import
    # `from .author_filter_allowlist import ...` resolves, and repeated imports
    # don't collide in sys.modules.
    pkg_name = f"genapi_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "author_filter_allowlist.py").write_text(allowlist_src)
    (pkg_dir / "author_router.py").write_text(router_src)

    sys.path.insert(0, str(tmp))
    spec = importlib.util.spec_from_file_location(
        f"{pkg_name}.author_router", pkg_dir / "author_router.py"
    )
    # Register the package so the relative import has a parent.
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.author_router"] = router_mod
    spec.loader.exec_module(router_mod)

    repo = InMemoryAuthorRepository()
    app = FastAPI()
    app.include_router(router_mod.router)
    # Override the generated consumer seam with the in-memory repo.
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return app, repo


# ---------------------------------------------------------------------------
# Minimal in-memory repo behind the generated `AuthorRepository` seam.
# Faithfully applies the generated-router-supplied predicates / sort / paging.
# ---------------------------------------------------------------------------


def _like_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate a SQL LIKE pattern (% = any run, _ = any char) to a regex."""
    out = ["^"]
    for ch in pattern:
        if ch == "%":
            out.append(".*")
        elif ch == "_":
            out.append(".")
        else:
            out.append(re.escape(ch))
    out.append("$")
    return re.compile("".join(out))


class InMemoryAuthorRepository:
    """In-memory impl of the GENERATED ``AuthorRepository`` Protocol (test seam)."""

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []

    # --- seeding / reset (test harness, not part of the generated Protocol) ---
    def reset(self) -> None:
        self._rows = []

    def seed(self, rows: list[dict[str, Any]]) -> None:
        self._rows = [dict(r) for r in rows]

    # --- value coercion: predicate values arrive as str; coerce to the column's
    #     native type so comparisons match the seeded data (id is int). ---
    def _field_type(self, field: str) -> type:
        for r in self._rows:
            v = r.get(field)
            if v is not None:
                return type(v)
        return str

    def _coerce(self, field: str, raw: str) -> Any:
        t = self._field_type(field)
        if t is int:
            return int(raw)
        if t is float:
            return float(raw)
        return raw

    def _matches(self, row: dict[str, Any], p: FilterPredicate) -> bool:
        actual = row.get(p.field)
        if p.op == "isNull":
            want_null = bool(p.value)
            return (actual is None) == want_null
        # SQL NULL semantics: any non-isNull comparison against NULL is not true.
        if actual is None:
            return False
        if p.op == "in":
            wants = {self._coerce(p.field, str(v)) for v in p.value}
            return actual in wants
        if p.op == "like":
            return _like_to_regex(str(p.value)).match(str(actual)) is not None
        want = self._coerce(p.field, str(p.value))
        if p.op == "eq":
            return actual == want
        if p.op == "ne":
            return actual != want
        if p.op == "gt":
            return actual > want
        if p.op == "gte":
            return actual >= want
        if p.op == "lt":
            return actual < want
        if p.op == "lte":
            return actual <= want
        raise ValueError(f"unsupported op: {p.op}")

    def _filtered(self, filters: list[FilterPredicate]) -> list[dict[str, Any]]:
        rows = self._rows
        for p in filters:
            rows = [r for r in rows if self._matches(r, p)]
        return rows

    # --- the GENERATED AuthorRepository Protocol surface ---
    def list(self, limit: int, offset: int, sort: Any, filters: list[FilterPredicate]) -> list[Any]:
        rows = self._filtered(filters)
        if sort is not None:
            rows = sorted(
                rows,
                key=lambda r: (r.get(sort.field) is None, r.get(sort.field)),
                reverse=(sort.direction == "desc"),
            )
        else:
            rows = sorted(rows, key=lambda r: r["id"])
        return [dict(r) for r in rows[offset : offset + limit]]

    def count(self, filters: list[FilterPredicate]) -> int:
        return len(self._filtered(filters))

    def find_by_id(self, id: int) -> Any | None:
        for r in self._rows:
            if r["id"] == id:
                return dict(r)
        return None

    def create(self, dto: Any) -> Any:
        row = dict(dto)
        if row.get("id") is None:
            row["id"] = (max((r["id"] for r in self._rows), default=0)) + 1
        self._rows.append(dict(row))
        return row

    def update(self, id: int, dto: Any) -> Any | None:
        for r in self._rows:
            if r["id"] == id:
                r.update({k: v for k, v in dict(dto).items() if k != "id"})
                return dict(r)
        return None

    def delete(self, id: int) -> bool:
        before = len(self._rows)
        self._rows = [r for r in self._rows if r["id"] != id]
        return len(self._rows) != before
