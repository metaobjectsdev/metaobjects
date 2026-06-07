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
from metaobjects.codegen.generators.m2m_codegen import (
    M2mDescriptor,
    build_object_index,
    resolve_m2m_descriptors,
)
from metaobjects.codegen.generators.tph_plan import TphPlan, is_tph_subtype, tph_plan_for
from metaobjects.codegen.instance_artifacts import emits_instance_artifacts
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


class RouterGenerator:
    """``object.entity`` + ``source.rdb @kind="table"`` → one
    ``<entity_snake>_router.py`` per writable entity (FastAPI ``APIRouter``).

    EXTENSION SEAM (open-for-extension). Adopters subclass this and override one of
    the protected ``_emit_*`` hooks to customize the emitted router without forking.
    The factory ``router_generator()`` and the module-level ``render_router()`` both
    delegate to a default instance, so the default suite stays byte-identical.

    Override points:

    * ``_emit_repository_protocol(repo_class, m2m)`` — the consumer-implemented
      ``Repository`` ``Protocol`` block (CRUD finders + M:N ``find_related_*``).
    * ``_emit_route_handler(name, ...)`` — the CRUD route handlers (list / get /
      create / update / delete), keyed by ``name``.
    * ``_emit_m2m_route(d, snake, pk_param, repo_class)`` — one M:N traversal route.
    * ``render_router(entity, object_index)`` — the whole module (last resort).

    Skips entities without a ``source.rdb`` child and read-only kinds
    (view / materializedView / storedProc / tableFunction).
    """

    name = "router-generator"

    def _emit_repository_protocol(
        self, repo_class: str, m2m: list[M2mDescriptor]
    ) -> list[str]:
        """The repository ``Protocol`` block. Returns/accepts ``Any`` so this module
        stays decoupled from the entity-model import. Override to add custom finder
        signatures or change the seam shape."""
        lines: list[str] = [
            f"class {repo_class}(Protocol):",
            '    """GENERATED — consumer implements with their preferred persistence layer."""',
            "    def list(",
            "        self,",
            "        limit: int,",
            "        offset: int,",
            "        sort: _SortClause | None,",
            "        filters: list[FilterPredicate],",
            "    ) -> list[Any]: ...",
            "    def count(self, filters: list[FilterPredicate]) -> int: ...",
            "    def find_by_id(self, id: int) -> Any | None: ...",
            "    def create(self, dto: Any) -> Any: ...",
            "    def update(self, id: int, dto: Any) -> Any | None: ...",
            "    def delete(self, id: int) -> bool: ...",
        ]
        for d in m2m:
            lines.append(
                f"    def find_related_{d.relation_name}(self, id: int) -> list[Any]: ..."
            )
        return lines

    def _emit_route_handler(
        self,
        name: str,
        *,
        snake: str,
        plural: str,
        pk_param: str,
        repo_class: str,
        fields_const: str,
        ops_const: str,
    ) -> list[str]:
        """One CRUD route handler block, dispatched by *name*
        (``list`` / ``get`` / ``create`` / ``update`` / ``delete``). Override to
        change a handler's body / decorators / response shape."""
        if name == "list":
            return [
                '@router.get("")',
                f"def list_{plural}(",
                "    request: Request,",
                f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
                "    limit: int | None = Query(None),",
                "    offset: int | None = Query(None),",
                "    sort: str | None = Query(None),",
                '    with_count: int | None = Query(None, alias="withCount"),',
                ") -> Any:",
                "    actual_limit = limit if limit is not None else 50",
                "    actual_offset = offset if offset is not None else 0",
                "    sort_clause: _SortClause | None = None",
                "    if sort is not None:",
                "        sort_clause = _parse_sort(sort)",
                "        if sort_clause is None:",
                '            return JSONResponse(status_code=400, content={"error": "invalid_sort"})',
                f"    filter_result = parse_filter(request.query_params, {fields_const}, {ops_const})",
                "    if filter_result.error_envelope is not None:",
                "        return JSONResponse(status_code=400, content=filter_result.error_envelope)",
                "    predicates = filter_result.predicates",
                "    rows = repo.list(actual_limit, actual_offset, sort_clause, predicates)",
                "    if with_count == 1:",
                "        total = repo.count(predicates)",
                '        return {"rows": rows, "total": total}',
                "    return rows",
            ]
        if name == "get":
            return [
                f'@router.get("/{{{pk_param}}}")',
                f"def get_{snake}(",
                f"    {pk_param}: int,",
                f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
                ") -> Any:",
                f"    row = repo.find_by_id({pk_param})",
                "    if row is None:",
                '        return JSONResponse(status_code=404, content={"error": "not_found"})',
                "    return row",
            ]
        if name == "create":
            return [
                '@router.post("", status_code=status.HTTP_201_CREATED)',
                f"def create_{snake}(",
                "    dto: dict[str, Any],",
                f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
                ") -> Any:",
                "    return repo.create(dto)",
            ]
        if name == "update":
            return [
                f'@router.patch("/{{{pk_param}}}")',
                f'@router.put("/{{{pk_param}}}")',
                f"def update_{snake}(",
                f"    {pk_param}: int,",
                "    dto: dict[str, Any],",
                f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
                ") -> Any:",
                f"    saved = repo.update({pk_param}, dto)",
                "    if saved is None:",
                '        return JSONResponse(status_code=404, content={"error": "not_found"})',
                "    return saved",
            ]
        if name == "delete":
            return [
                f'@router.delete("/{{{pk_param}}}", status_code=status.HTTP_204_NO_CONTENT)',
                f"def delete_{snake}(",
                f"    {pk_param}: int,",
                f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
                ") -> None:",
                f"    if not repo.delete({pk_param}):",
                '        return JSONResponse(status_code=404, content={"error": "not_found"})',
            ]
        raise ValueError(f"unknown route handler '{name}'")

    def _emit_m2m_route(
        self, d: M2mDescriptor, snake: str, pk_param: str, repo_class: str
    ) -> list[str]:
        """One M:N traversal route ``GET /{id}/<relationName>`` — a thin pass-through
        to the repository's ``find_related_*`` finder. Override to add filtering /
        pagination on the traversal."""
        return [
            f'@router.get("/{{{pk_param}}}/{d.relation_name}")',
            f"def list_{snake}_{d.relation_name}(",
            f"    {pk_param}: int,",
            f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
            ") -> list[Any]:",
            f"    return repo.find_related_{d.relation_name}({pk_param})",
        ]

    def _emit_tph_list_body(
        self, subtype_expr: str, fields_const: str, ops_const: str, repo_var: str = "repo"
    ) -> list[str]:
        """The shared list-handler body (sort + filter parse → repo.list). *subtype_expr*
        is the Python literal threaded as the discriminator scope: ``None`` for the
        polymorphic base, or a quoted ``@discriminatorValue`` for a per-subtype route."""
        return [
            "    actual_limit = limit if limit is not None else 50",
            "    actual_offset = offset if offset is not None else 0",
            "    sort_clause: _SortClause | None = None",
            "    if sort is not None:",
            "        sort_clause = _parse_sort(sort)",
            "        if sort_clause is None:",
            '            return JSONResponse(status_code=400, content={"error": "invalid_sort"})',
            f"    filter_result = parse_filter(request.query_params, {fields_const}, {ops_const})",
            "    if filter_result.error_envelope is not None:",
            "        return JSONResponse(status_code=400, content=filter_result.error_envelope)",
            "    predicates = filter_result.predicates",
            f"    rows = {repo_var}.list({subtype_expr}, actual_limit, actual_offset, sort_clause, predicates)",
            "    if with_count == 1:",
            f"        total = {repo_var}.count({subtype_expr}, predicates)",
            '        return {"rows": rows, "total": total}',
            "    return rows",
        ]

    def _render_tph_router(self, entity: MetaObject, plan: TphPlan) -> str:
        """FR-017 TPH: emit the discriminator base's router — a polymorphic collection
        at the base path + a full per-subtype CRUD set at /<base>/<segment>. The repo
        seam is subtype-keyed (the ``@discriminatorValue``, or ``None`` for the base);
        the consumer's repo applies the single-table discriminator scope."""
        short_name = entity.name
        snake = _snake_case(short_name)
        plural = _plural_lowercase(short_name)
        pk_param = f"{snake}_id"
        repo_class = f"{short_name}Repository"
        upper = short_name.upper()
        fields_const = f"{upper}_FILTER_FIELDS"
        ops_const = f"{upper}_FILTER_OPS_BY_FIELD"
        allowlist_module = f"{snake}_filter_allowlist"

        # Sort allowlist = base scalar fields ∪ every subtype's own scalar fields, so a
        # per-subtype list can sort on a subtype-only column too. Stable order.
        sort_fields: list[str] = [f.name for f in _scalar_fields(entity)]
        seen = set(sort_fields)
        for st in plan.subtypes:
            for f in _scalar_fields(st.entity):
                if f.name not in seen:
                    seen.add(f.name)
                    sort_fields.append(f.name)
        sort_set_body = "set()" if not sort_fields else (
            "{\n" + "".join(f'    "{name}",\n' for name in sort_fields) + "}"
        )

        h = generated_header(short_name, _effective_fqn(entity)).rstrip()
        parts: list[str] = []
        parts.append(
            h + "\n"
            + f'"""GENERATED — TPH polymorphic REST router for the {short_name} hierarchy '
            + '(single-table inheritance: polymorphic base + per-subtype CRUD)."""\n'
        )
        parts.append("from __future__ import annotations")
        parts.append("")
        parts.append("from typing import Annotated, Any, Protocol")
        parts.append("")
        parts.append("from fastapi import APIRouter, Depends, Query, Request, status")
        parts.append("from fastapi.responses import JSONResponse")
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
        parts.append("class _SortClause(BaseModel):")
        parts.append('    """GENERATED — parsed sort directive (field + asc/desc)."""')
        parts.append("    field: str")
        parts.append("    direction: str")
        parts.append("")
        parts.append("")
        parts.append(f"_SORT_ALLOWLIST: set[str] = {sort_set_body}")
        parts.append("")
        parts.append("")
        parts.append("def _parse_sort(raw: str) -> _SortClause | None:")
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
        # Subtype-keyed repository Protocol (None == the polymorphic base).
        parts.append(f"class {repo_class}(Protocol):")
        parts.append('    """GENERATED — TPH seam. `subtype` is the @discriminatorValue, or None for')
        parts.append('    the polymorphic base; the consumer scopes the single table accordingly."""')
        parts.append("    def list(")
        parts.append("        self,")
        parts.append("        subtype: str | None,")
        parts.append("        limit: int,")
        parts.append("        offset: int,")
        parts.append("        sort: _SortClause | None,")
        parts.append("        filters: list[FilterPredicate],")
        parts.append("    ) -> list[Any]: ...")
        parts.append("    def count(self, subtype: str | None, filters: list[FilterPredicate]) -> int: ...")
        parts.append("    def find_by_id(self, subtype: str | None, id: int) -> Any | None: ...")
        parts.append("    def create(self, subtype: str, dto: Any) -> Any: ...")
        parts.append("    def update(self, subtype: str, id: int, dto: Any) -> Any | None: ...")
        parts.append("    def delete(self, subtype: str, id: int) -> bool: ...")
        parts.append("")
        parts.append("")
        parts.append(f"def get_repository() -> {repo_class}:")
        parts.append('    """GENERATED — consumer overrides via `app.dependency_overrides[get_repository]`."""')
        parts.append('    raise NotImplementedError("Override get_repository via FastAPI dependency_overrides in the consumer app")')
        parts.append("")
        parts.append("")

        def list_sig(fn: str, route: str) -> list[str]:
            return [
                f'@router.get("{route}")',
                f"def {fn}(",
                "    request: Request,",
                f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
                "    limit: int | None = Query(None),",
                "    offset: int | None = Query(None),",
                "    sort: str | None = Query(None),",
                '    with_count: int | None = Query(None, alias="withCount"),',
                ") -> Any:",
            ]

        # --- Per-subtype routes FIRST (literal segments match before /{id:int}). ---
        for st in plan.subtypes:
            seg = st.route_segment
            val = st.value
            sfx = st.route_segment  # handler-name suffix = URL segment (e.g. "bridge"), matches the route
            parts.extend(list_sig(f"list_{plural}_{sfx}", f"/{seg}"))
            parts.extend(self._emit_tph_list_body(f'"{val}"', fields_const, ops_const))
            parts.append("")
            parts.append("")
            parts.append(f'@router.post("/{seg}", status_code=status.HTTP_201_CREATED)')
            parts.append(f"def create_{plural}_{sfx}(")
            parts.append("    dto: dict[str, Any],")
            parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
            parts.append(") -> Any:")
            parts.append(f'    return repo.create("{val}", dto)')
            parts.append("")
            parts.append("")
            parts.append(f'@router.get("/{seg}/{{{pk_param}}}")')
            parts.append(f"def get_{plural}_{sfx}(")
            parts.append(f"    {pk_param}: int,")
            parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
            parts.append(") -> Any:")
            parts.append(f'    row = repo.find_by_id("{val}", {pk_param})')
            parts.append("    if row is None:")
            parts.append('        return JSONResponse(status_code=404, content={"error": "not_found"})')
            parts.append("    return row")
            parts.append("")
            parts.append("")
            parts.append(f'@router.patch("/{seg}/{{{pk_param}}}")')
            parts.append(f'@router.put("/{seg}/{{{pk_param}}}")')
            parts.append(f"def update_{plural}_{sfx}(")
            parts.append(f"    {pk_param}: int,")
            parts.append("    dto: dict[str, Any],")
            parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
            parts.append(") -> Any:")
            parts.append(f'    saved = repo.update("{val}", {pk_param}, dto)')
            parts.append("    if saved is None:")
            parts.append('        return JSONResponse(status_code=404, content={"error": "not_found"})')
            parts.append("    return saved")
            parts.append("")
            parts.append("")
            parts.append(f'@router.delete("/{seg}/{{{pk_param}}}", status_code=status.HTTP_204_NO_CONTENT)')
            parts.append(f"def delete_{plural}_{sfx}(")
            parts.append(f"    {pk_param}: int,")
            parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
            parts.append(") -> None:")
            parts.append(f'    if not repo.delete("{val}", {pk_param}):')
            parts.append('        return JSONResponse(status_code=404, content={"error": "not_found"})')
            parts.append("")
            parts.append("")

        # --- Polymorphic base routes LAST (so /{id:int} doesn't shadow /<segment>). ---
        parts.extend(list_sig(f"list_{plural}", ""))
        parts.extend(self._emit_tph_list_body("None", fields_const, ops_const))
        parts.append("")
        parts.append("")
        parts.append(f'@router.get("/{{{pk_param}}}")')
        parts.append(f"def get_{snake}(")
        parts.append(f"    {pk_param}: int,")
        parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
        parts.append(") -> Any:")
        parts.append(f"    row = repo.find_by_id(None, {pk_param})")
        parts.append("    if row is None:")
        parts.append('        return JSONResponse(status_code=404, content={"error": "not_found"})')
        parts.append("    return row")
        parts.append("")

        return "\n".join(parts)

    def render_router(
        self, entity: MetaObject, object_index: dict[str, MetaObject] | None = None
    ) -> str | None:
        """Render an entity as a FastAPI ``APIRouter`` module.

        Returns ``None`` when the entity has no ``source.rdb`` child or the source
        is not a writable table (view / materializedView / storedProc / tableFunction
        are skipped — read-only kinds need a different shape).

        When *object_index* is supplied, each M:N navigation on the entity
        (``relationship.* @cardinality:"many" + @through``) also emits a FastAPI
        traversal route ``GET /<source-plural>/{id}/<relationName>`` returning the
        related target rows, plus a typed ``find_related_<relation>`` finder on the
        repository ``Protocol`` seam (the consumer joins through the junction). The
        source URL segment is the ENTITY name pluralized (cross-port grammar), NOT
        the physical ``@table``. Without an index, only CRUD is emitted (back-compat).
        """
        if not emits_instance_artifacts(entity):
            return None
        # FR-017 TPH: a concrete subtype is folded into its base's single table — it
        # emits no standalone router (its CRUD lives under the base's per-subtype segment).
        if object_index is not None and is_tph_subtype(entity):
            return None
        src = _primary_source_rdb(entity)
        if src is None:
            return None
        if src.effective_kind() != SOURCE_KIND_TABLE:
            return None

        # FR-017 TPH: a discriminator base emits a polymorphic collection at the base
        # path PLUS a full per-subtype CRUD set at /<base>/<discriminatorValue lowercased>.
        if object_index is not None:
            plan = tph_plan_for(entity, object_index)
            if plan is not None:
                return self._render_tph_router(entity, plan)

        m2m: list[M2mDescriptor] = (
            resolve_m2m_descriptors(entity, object_index)
            if object_index is not None
            else []
        )

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
        parts.append("from fastapi import APIRouter, Depends, Query, Request, status")
        parts.append("from fastapi.responses import JSONResponse")
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
        parts.extend(self._emit_repository_protocol(repo_class, m2m))
        parts.append("")
        parts.append("")
        parts.append(f"def get_repository() -> {repo_class}:")
        parts.append('    """GENERATED — consumer overrides via `app.dependency_overrides[get_repository]`."""')
        parts.append('    raise NotImplementedError("Override get_repository via FastAPI dependency_overrides in the consumer app")')
        parts.append("")
        parts.append("")

        _handler_kwargs = dict(
            snake=snake,
            plural=plural,
            pk_param=pk_param,
            repo_class=repo_class,
            fields_const=fields_const,
            ops_const=ops_const,
        )
        for i, hname in enumerate(("list", "get", "create", "update", "delete")):
            if i > 0:
                parts.append("")
                parts.append("")
            parts.extend(self._emit_route_handler(hname, **_handler_kwargs))
        parts.append("")

        # FR-018 — M:N traversal routes: GET /{id}/<relationName> returns the
        # related target rows reached through the junction. The repository seam
        # owns the join (derived source/target FK columns + symmetric union-on-read);
        # the route is a thin pass-through returning the related collection (empty
        # array for an orphan source — never a 404).
        for d in m2m:
            parts.append("")
            parts.extend(self._emit_m2m_route(d, snake, pk_param, repo_class))
            parts.append("")

        return "\n".join(parts)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        index = build_object_index(ctx.entities)

        def emit(entity: MetaObject, _c: GenContext) -> list[EmittedFile]:
            source = self.render_router(entity, index)
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


def render_router(
    entity: MetaObject, object_index: dict[str, MetaObject] | None = None
) -> str | None:
    """Module-level back-compat wrapper. Delegates to a default
    :class:`RouterGenerator` instance so existing callers (and tests) are
    unaffected. Subclass :class:`RouterGenerator` to customize."""
    return RouterGenerator().render_router(entity, object_index)


def router_generator() -> Generator:
    """Generator factory: ``object.entity`` + ``source.rdb @kind="table"`` → one
    ``<entity_snake>_router.py`` per writable entity.

    Returns a :class:`RouterGenerator` (subclassable extension seam). Skips entities
    without a ``source.rdb`` child and read-only kinds (view / materializedView /
    storedProc / tableFunction)."""
    return RouterGenerator()
