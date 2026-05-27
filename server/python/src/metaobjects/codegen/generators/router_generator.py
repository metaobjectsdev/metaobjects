"""FastAPI router codegen — one ``<entity>_router.py`` per writable entity
(``source.rdb`` with ``@kind="table"``).

FR-008 §2.3. Conforms to the cross-port REST API contract
(see ``docs/features/api-contract.md``):

* Routes: ``/api/<entity-plural-lowercase>`` (e.g. ``/api/authors``).
* 5 CRUD verbs: GET list, GET by id, POST create, PATCH+PUT update, DELETE.
* ``?withCount=1`` switches list response to ``{"rows", "total"}``.
* ``?sort=field:asc|desc`` parsed via a static per-entity allowlist
  (HTTP 400 envelope ``{"error": "invalid_sort"}`` on unknown field).
* ``?limit=N&offset=N`` pagination with defaults (limit=50, offset=0).
* HTTP 404 envelope: ``{"error": "not_found"}``.

View / materializedView / storedProc / tableFunction kinds are skipped
(read-only — would need a different router shape).

Filter operators are wired by delegating to the per-entity
``<entity_snake>_filter_allowlist.py`` module (FR-009 §3.5) and the
shared ``metaobjects.codegen.runtime.filter_parser`` helper. Only fields
with ``@filterable: true`` appear in the allowlist; everything else
returns ``invalid_filter_field`` per the cross-port wire envelope. The
generated ``list`` handler accepts the FastAPI ``Request`` to read raw
query params, calls ``parse_filter`` against the allowlist, and threads
the resulting predicate list through the repository ``Protocol``.

The generated router declares a ``Protocol`` interface for the consumer's
repository — the consumer wires SQLAlchemy / asyncpg / etc. via FastAPI's
``app.dependency_overrides`` mechanism. This keeps the generator framework-
neutral (no SQLAlchemy import in the emitted module) and lets the consumer
pick their preferred persistence layer.
"""
from __future__ import annotations

from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator, per_entity
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import SOURCE_KIND_TABLE
from metaobjects.shared.base_types import TYPE_SOURCE
from metaobjects.shared.separators import PACKAGE_SEP


def _effective_fqn(entity: MetaObject) -> str:
    """``package::name``, resolving package from the nearest ancestor that carries
    one. Mirrors the entity-model generator's helper of the same name."""
    pkg = entity.package
    parent = entity.parent
    while pkg is None and parent is not None:
        pkg = parent.package
        parent = parent.parent
    return f"{pkg}{PACKAGE_SEP}{entity.name}" if pkg else entity.name


def _snake_case(name: str) -> str:
    """``Author`` → ``author``; ``AuthorBrief`` → ``author_brief``.

    Used for both the file name (``author_router.py``) and the path-parameter
    name (``/{author_id}``). Trivial PascalCase → snake_case (no acronym
    handling — matches the cross-port pluralization rule).
    """
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _plural_lowercase(name: str) -> str:
    """``Author`` → ``authors``. Cross-port-aligned trivial pluralization
    (TS / Java / Kotlin / C# use the same rule for the default route segment).
    Consumers needing irregular plurals can hand-edit the generated file."""
    return name.lower() + "s"


def _primary_source_rdb(entity: MetaObject) -> MetaSource | None:
    """Return the entity's ``source.rdb`` child (own only), or ``None``."""
    for c in entity.own_children():
        if c.type == TYPE_SOURCE and isinstance(c, MetaSource):
            return c
    return None


def _scalar_fields(entity: MetaObject) -> list[MetaField]:
    """All effective fields minus ObjectField — same gate the Java/Kotlin
    controllers use for the sort allowlist (object fields have no plain
    column to sort on)."""
    return [f for f in entity.fields() if f.sub_type != fc.FIELD_SUBTYPE_OBJECT]


def render_router(entity: MetaObject) -> str | None:
    """Render an entity as a FastAPI ``APIRouter`` module.

    Returns ``None`` when the entity has no ``source.rdb`` child or the source
    is not a writable table (view / materializedView / storedProc / tableFunction
    are skipped — read-only kinds need a different shape).
    """
    src = _primary_source_rdb(entity)
    if src is None:
        return None
    if src.effective_kind() != SOURCE_KIND_TABLE:
        return None

    short_name = entity.name
    snake = _snake_case(short_name)
    plural = _plural_lowercase(short_name)
    pk_param = f"{snake}_id"
    repo_class = f"{short_name}Repository"
    sort_fields = [f.name for f in _scalar_fields(entity)]
    upper = short_name.upper()
    fields_const = f"{upper}_FILTER_FIELDS"
    ops_const = f"{upper}_FILTER_OPS_BY_FIELD"
    allowlist_module = f"{snake}_filter_allowlist"

    sort_set_body = "set()" if not sort_fields else (
        "{\n" + "".join(f'    "{name}",\n' for name in sort_fields) + "}"
    )

    parts: list[str] = []
    parts.append(
        generated_header(short_name, _effective_fqn(entity)).rstrip() + "\n"
        + f'"""GENERATED — REST router for {short_name} entity. Implements the cross-port API contract."""\n'
    )
    parts.append("from __future__ import annotations")
    parts.append("")
    parts.append("from typing import Annotated, Any, Protocol")
    parts.append("")
    parts.append("from fastapi import APIRouter, Depends, HTTPException, Query, Request, status")
    parts.append("from pydantic import BaseModel")
    parts.append("")
    parts.append("from metaobjects.codegen.runtime.filter_parser import (")
    parts.append("    FilterPredicate,")
    parts.append("    parse_filter,")
    parts.append(")")
    parts.append("")
    parts.append(f"from .{allowlist_module} import {fields_const}, {ops_const}")
    parts.append("")
    parts.append(f'router = APIRouter(prefix="/api/{plural}", tags=["{plural}"])')
    parts.append("")
    parts.append("")
    # Sort allowlist + parse helper — per-entity, closed over the allowlist set so
    # callers don't need to thread the set through a runtime argument.
    parts.append("class _SortClause(BaseModel):")
    parts.append('    """GENERATED — parsed sort directive (field + asc/desc)."""')
    parts.append("    field: str")
    parts.append("    direction: str")
    parts.append("")
    parts.append("")
    parts.append(f"_SORT_ALLOWLIST: set[str] = {sort_set_body}")
    parts.append("")
    parts.append("")
    parts.append('def _parse_sort(raw: str) -> _SortClause | None:')
    parts.append('    """Parse `field:asc|desc`; return None for malformed / disallowed input."""')
    parts.append('    parts = raw.split(":", 1)')
    parts.append("    if not parts or parts[0] not in _SORT_ALLOWLIST:")
    parts.append("        return None")
    parts.append('    direction = parts[1].lower() if len(parts) == 2 else "asc"')
    parts.append('    if direction not in ("asc", "desc"):')
    parts.append("        return None")
    parts.append("    return _SortClause(field=parts[0], direction=direction)")
    parts.append("")
    parts.append("")
    # Repository Protocol. Returns/accepts Any so this module stays decoupled
    # from the entity-model import (the consumer is free to use the generated
    # Pydantic model — or any duck-typed shape — without us forcing an import
    # cycle between sibling generated files).
    parts.append(f"class {repo_class}(Protocol):")
    parts.append(f'    """GENERATED — consumer implements with their preferred persistence layer."""')
    parts.append("    def list(")
    parts.append("        self,")
    parts.append("        limit: int,")
    parts.append("        offset: int,")
    parts.append("        sort: _SortClause | None,")
    parts.append("        filters: list[FilterPredicate],")
    parts.append("    ) -> list[Any]: ...")
    parts.append("    def count(self, filters: list[FilterPredicate]) -> int: ...")
    parts.append("    def find_by_id(self, id: int) -> Any | None: ...")
    parts.append("    def create(self, dto: Any) -> Any: ...")
    parts.append("    def update(self, id: int, dto: Any) -> Any | None: ...")
    parts.append("    def delete(self, id: int) -> bool: ...")
    parts.append("")
    parts.append("")
    parts.append(f"def get_repository() -> {repo_class}:")
    parts.append('    """GENERATED — consumer overrides via `app.dependency_overrides[get_repository]`."""')
    parts.append('    raise NotImplementedError("Override get_repository via FastAPI dependency_overrides in the consumer app")')
    parts.append("")
    parts.append("")
    # GET / — list with pagination, sort, filter, withCount envelope.
    parts.append('@router.get("")')
    parts.append(f"def list_{plural}(")
    parts.append("    request: Request,")
    parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
    parts.append("    limit: int | None = Query(None),")
    parts.append("    offset: int | None = Query(None),")
    parts.append("    sort: str | None = Query(None),")
    parts.append('    with_count: int | None = Query(None, alias="withCount"),')
    parts.append(") -> Any:")
    parts.append("    actual_limit = limit if limit is not None else 50")
    parts.append("    actual_offset = offset if offset is not None else 0")
    parts.append("    sort_clause: _SortClause | None = None")
    parts.append("    if sort is not None:")
    parts.append("        sort_clause = _parse_sort(sort)")
    parts.append("        if sort_clause is None:")
    parts.append('            raise HTTPException(status_code=400, detail={"error": "invalid_sort"})')
    parts.append(f"    filter_result = parse_filter(request.query_params, {fields_const}, {ops_const})")
    parts.append("    if filter_result.error_envelope is not None:")
    parts.append("        raise HTTPException(status_code=400, detail=filter_result.error_envelope)")
    parts.append("    predicates = filter_result.predicates")
    parts.append("    rows = repo.list(actual_limit, actual_offset, sort_clause, predicates)")
    parts.append("    if with_count == 1:")
    parts.append("        total = repo.count(predicates)")
    parts.append('        return {"rows": rows, "total": total}')
    parts.append("    return rows")
    parts.append("")
    parts.append("")
    # GET /{id}
    parts.append(f'@router.get("/{{{pk_param}}}")')
    parts.append(f"def get_{snake}(")
    parts.append(f"    {pk_param}: int,")
    parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
    parts.append(") -> Any:")
    parts.append(f"    row = repo.find_by_id({pk_param})")
    parts.append("    if row is None:")
    parts.append('        raise HTTPException(status_code=404, detail={"error": "not_found"})')
    parts.append("    return row")
    parts.append("")
    parts.append("")
    # POST
    parts.append('@router.post("", status_code=status.HTTP_201_CREATED)')
    parts.append(f"def create_{snake}(")
    parts.append("    dto: dict[str, Any],")
    parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
    parts.append(") -> Any:")
    parts.append("    return repo.create(dto)")
    parts.append("")
    parts.append("")
    # PATCH + PUT — stacked on a single handler (per API contract).
    parts.append(f'@router.patch("/{{{pk_param}}}")')
    parts.append(f'@router.put("/{{{pk_param}}}")')
    parts.append(f"def update_{snake}(")
    parts.append(f"    {pk_param}: int,")
    parts.append("    dto: dict[str, Any],")
    parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
    parts.append(") -> Any:")
    parts.append(f"    saved = repo.update({pk_param}, dto)")
    parts.append("    if saved is None:")
    parts.append('        raise HTTPException(status_code=404, detail={"error": "not_found"})')
    parts.append("    return saved")
    parts.append("")
    parts.append("")
    # DELETE
    parts.append(f'@router.delete("/{{{pk_param}}}", status_code=status.HTTP_204_NO_CONTENT)')
    parts.append(f"def delete_{snake}(")
    parts.append(f"    {pk_param}: int,")
    parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
    parts.append(") -> None:")
    parts.append(f"    if not repo.delete({pk_param}):")
    parts.append('        raise HTTPException(status_code=404, detail={"error": "not_found"})')
    parts.append("")

    return "\n".join(parts)


def router_generator() -> Generator:
    """Generator factory: ``object.entity`` + ``source.rdb @kind="table"`` → one
    ``<entity_snake>_router.py`` per writable entity.

    Skips entities without a ``source.rdb`` child and read-only kinds
    (view / materializedView / storedProc / tableFunction).
    """

    class _Gen:
        name = "router-generator"

        def generate(self, ctx: GenContext) -> list[EmittedFile]:
            def emit(entity: MetaObject, _c: GenContext) -> list[EmittedFile]:
                source = render_router(entity)
                if source is None:
                    return []
                snake = _snake_case(entity.name)
                return [
                    EmittedFile(
                        path=f"{snake}_router.py",
                        content=ruff_format(source),
                    )
                ]

            return per_entity(emit)(ctx)

    return _Gen()
