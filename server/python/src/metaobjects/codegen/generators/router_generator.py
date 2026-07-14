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

from dataclasses import dataclass

from metaobjects.apidocs.naming import plural_lowercase as _plural_lowercase
from metaobjects.apidocs.naming import reverse_finder_fn, reverse_finder_in_fn
from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.fr010_field_mapping import is_required
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator, per_entity
from metaobjects.codegen.generators.m2m_codegen import (
    M2mDescriptor,
    build_object_index,
    pk_field_name,
    resolve_m2m_descriptors,
)
from metaobjects.codegen.generators.tph_plan import TphPlan, is_tph_subtype, tph_plan_for
from metaobjects.codegen.instance_artifacts import emits_instance_artifacts
from metaobjects.codegen.type_map import PyType, py_type_for
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_REFERENCE,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import SOURCE_KIND_TABLE
from metaobjects.shared.base_types import TYPE_IDENTITY, TYPE_SOURCE
from metaobjects.shared.separators import PACKAGE_SEP


def _effective_fqn(entity: MetaObject) -> str:
    """``package::name`` via the canonical :meth:`MetaData.resolution_key` (own
    package, else file-default, else ancestor) — multi-file-merge safe. Mirrors the
    entity-model generator's helper of the same name."""
    return entity.resolution_key()


def _primary_source_rdb(entity: MetaObject) -> MetaSource | None:
    """Return the entity's ``source.rdb`` child, or ``None``.

    ADR-0039 — RESOLVING (children()): an entity may inherit its source.rdb via
    ``extends`` (BaseEntity); own_children() would miss it. Mirrors TS dbTable.
    """
    for c in entity.children():
        if c.type == TYPE_SOURCE and isinstance(c, MetaSource):
            return c
    return None


def _scalar_fields(entity: MetaObject) -> list[MetaField]:
    """All effective fields minus ObjectField — same gate the Java/Kotlin
    controllers use for the sort allowlist (object fields have no plain
    column to sort on)."""
    return [f for f in entity.fields() if f.sub_type != fc.FIELD_SUBTYPE_OBJECT]


def _required_field_names(entity: MetaObject) -> list[str]:
    """Every @required field name — scalar AND object/jsonb (unlike
    _scalar_fields, which drops object fields for the sort allowlist). FR-035
    PATCH-2 guards present-null on any of these, and a @required jsonb column can
    be nulled just like a scalar one."""
    return [f.name for f in entity.fields() if is_required(f)]


def _py_set_literal(names: list[str], *, frozen: bool = False) -> str:
    """A Python set/frozenset literal from field names, matching the generated
    allowlist idiom (one quoted name per line). Empty → ``frozenset()`` / ``set()``."""
    empty = "frozenset()" if frozen else "set()"
    if not names:
        return empty
    body = "{\n" + "".join(f'    "{name}",\n' for name in names) + "}"
    return f"frozenset({body})" if frozen else body


def _pk_py_type(entity: MetaObject) -> PyType:
    """The Python type of the entity's primary-key path/id parameter, derived
    from the PK field's declared subtype via ``type_map.py_type_for`` — the same
    mapper the Pydantic entity model uses, so ``field.uuid`` binds ``uuid.UUID``
    on the route exactly as it does on the model (mirrors the C#
    RoutesGenerator's ``CSharpNaming.ScalarFor(pkField.SubType)``).

    Composite PK → ``@fields[0]`` (the TS ``getPkInfo`` behavior); no primary
    identity / unresolvable field → ``int`` (the ``field.long`` default).
    """
    name = pk_field_name(entity)
    pk_field = next((f for f in entity.fields() if f.name == name), None)
    if pk_field is None:
        return PyType("int")
    return py_type_for(pk_field)


@dataclass(frozen=True)
class ReverseFk:
    """One FK an entity ``E`` holds (ADR-0038): the FK FIELD name on ``E`` and the
    bare target entity (``T``) it references. Drives the reverse finder pair on
    ``E``'s repository so ``T`` can navigate to its referencing ``E`` rows."""

    fk_field: str
    target_entity: str


def reverse_fks_for(entity: MetaObject) -> list[ReverseFk]:
    """The entity's ``identity.reference`` FKs, in declaration order — the
    cross-port-canonical source for the reverse-finder pair (mirrors the TS
    ``reverseFksFor``). Each reference contributes one FK field + target entity;
    malformed references (no ``@fields`` / no ``@references``) are skipped.

    ADR-0039 — RESOLVING (children() + get_meta_attr): mirrors the TS
    ``entity.referenceIdentities()`` + ``ref.fields``/``ref.targetEntity`` (all
    resolving); an ``identity.reference`` inherited via ``extends`` is honored.
    """
    out: list[ReverseFk] = []
    for c in entity.children():
        if c.type != TYPE_IDENTITY or c.sub_type != IDENTITY_SUBTYPE_REFERENCE:
            continue
        fields = c.get_meta_attr(IDENTITY_ATTR_FIELDS)  # ADR-0039: resolving (identity attr)
        fk_field: str | None = None
        if isinstance(fields, (list, tuple)) and fields and isinstance(fields[0], str):
            fk_field = fields[0]
        elif isinstance(fields, str) and fields:
            fk_field = fields.split(",")[0].strip() or None
        references = c.get_meta_attr(IDENTITY_REFERENCE_ATTR_REFERENCES)  # ADR-0039: resolving (identity attr)
        target = (
            references[references.rfind(PACKAGE_SEP) + len(PACKAGE_SEP):]
            if isinstance(references, str) and PACKAGE_SEP in references
            else references
        )
        if not fk_field or not isinstance(target, str) or not target:
            continue
        out.append(ReverseFk(fk_field=fk_field, target_entity=target))
    return out


class RouterGenerator:
    """``object.entity`` + ``source.rdb @kind="table"`` → one
    ``<entity_snake>_router.py`` per writable entity (FastAPI ``APIRouter``).

    EXTENSION SEAM (open-for-extension). Adopters subclass this and override one of
    the protected ``_emit_*`` hooks to customize the emitted router without forking.
    The factory ``router_generator()`` and the module-level ``render_router()`` both
    delegate to a default instance, so the default suite stays byte-identical.

    Override points:

    * ``_emit_repository_protocol(repo_class, m2m, pk_type)`` — the consumer-
      implemented ``Repository`` ``Protocol`` block (CRUD finders + M:N
      ``find_related_*``); ``pk_type`` is the PK's Python annotation text.
    * ``_emit_reverse_finders(entity)`` — the ADR-0038 reverse-FK finder pair
      (``find_<e_plural>_by_<fk_segment>`` + ``…_in``) appended to the ``Protocol``.
    * ``_emit_route_handler(name, ...)`` — the CRUD route handlers (list / get /
      create / update / delete), keyed by ``name``.
    * ``_emit_m2m_route(d, snake, pk_param, pk_type, repo_class)`` — one M:N
      traversal route.
    * ``render_router(entity, object_index)`` — the whole module (last resort).

    Skips entities without a ``source.rdb`` child and read-only kinds
    (view / materializedView / storedProc / tableFunction).
    """

    name = "router-generator"

    def _emit_repository_protocol(
        self, repo_class: str, m2m: list[M2mDescriptor], pk_type: str
    ) -> list[str]:
        """The repository ``Protocol`` block. Returns/accepts ``Any`` so this module
        stays decoupled from the entity-model import; *pk_type* is the PK's Python
        annotation text (metadata-derived — e.g. ``uuid.UUID`` / ``int`` / ``str``).
        Override to add custom finder signatures or change the seam shape."""
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
            f"    def find_by_id(self, id: {pk_type}) -> Any | None: ...",
            "    def create(self, dto: Any) -> Any: ...",
            f"    def update(self, id: {pk_type}, dto: Any) -> Any | None: ...",
            f"    def delete(self, id: {pk_type}) -> bool: ...",
        ]
        for d in m2m:
            lines.append(
                f"    def find_related_{d.relation_name}(self, id: {pk_type}) -> list[Any]: ..."
            )
        return lines

    def _emit_reverse_finders(self, entity: MetaObject) -> list[str]:
        """ADR-0038 reverse-relationship finders for the repository ``Protocol`` — for
        each FK this entity (``E``) holds (``identity.reference``), a single-value
        ``find_<e_plural>_by_<fk_segment>`` + a batched (anti-N+1) ``…_in`` finder.

        Each is a framework-free single query (``WHERE <fk> = ?`` / ``WHERE <fk> IN (…)``)
        returning ``list[Any]`` (the ``E`` rows matching a given target id) — NOT a lazy
        ORM collection (ADR-0038). The name derives from the FK FIELD (unique within the
        entity), so same-pair FKs yield distinct finders with no collision. Returns
        ``Protocol``-body lines (each already 4-space indented). Override to customize."""
        lines: list[str] = []
        entity_name = entity.name
        for rfk in reverse_fks_for(entity):
            single = reverse_finder_fn(entity_name, rfk.fk_field)
            batched = reverse_finder_in_fn(entity_name, rfk.fk_field)
            arg = _snake_case(rfk.fk_field)
            lines.append(f"    def {single}(self, {arg}: Any) -> list[Any]: ...")
            lines.append(
                f"    def {batched}(self, {arg}_values: list[Any]) -> list[Any]: ..."
            )
        return lines

    def _emit_route_handler(
        self,
        name: str,
        *,
        snake: str,
        plural: str,
        pk_param: str,
        pk_type: str,
        repo_class: str,
        fields_const: str,
        ops_const: str,
        model_name: str,
        patch_model: str,
    ) -> list[str]:
        """One CRUD route handler block, dispatched by *name*
        (``list`` / ``get`` / ``create`` / ``update`` / ``delete``). Override to
        change a handler's body / decorators / response shape. *model_name* /
        *patch_model* are the generated create + all-optional PATCH Pydantic models
        used to run field constraints on POST / PATCH (FR-036)."""
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
                f"    {pk_param}: {pk_type},",
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
                "    # FR-036: run the generated field constraints (length / pattern /",
                "    # numeric bounds) before persisting; a violation is the cross-port 400.",
                "    try:",
                f"        {model_name}(**dto)",
                "    except ValidationError:",
                '        return JSONResponse(status_code=400, content={"error": "validation"})',
                "    return repo.create(dto)",
            ]
        if name == "update":
            return [
                f'@router.patch("/{{{pk_param}}}")',
                f'@router.put("/{{{pk_param}}}")',
                f"def update_{snake}(",
                f"    {pk_param}: {pk_type},",
                "    dto: dict[str, Any],",
                f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
                ") -> Any:",
                "    # FR-035 PATCH-2: an explicit null on a @required field is a 400 —",
                "    # a present null on a NON-required field falls through and clears it,",
                "    # and an OMITTED required field is untouched (never a 400).",
                "    for _k in _REQUIRED_FIELDS:",
                "        if _k in dto and dto[_k] is None:",
                '            return JSONResponse(status_code=400, content={"error": "validation"})',
                "    # FR-036: validate PRESENT, non-null values with the create rules (the",
                "    # all-optional patch model never fires required-checks on ABSENT fields).",
                "    try:",
                f"        {patch_model}(**dto)",
                "    except ValidationError:",
                '        return JSONResponse(status_code=400, content={"error": "validation"})',
                f"    saved = repo.update({pk_param}, dto)",
                "    if saved is None:",
                '        return JSONResponse(status_code=404, content={"error": "not_found"})',
                "    return saved",
            ]
        if name == "delete":
            return [
                f'@router.delete("/{{{pk_param}}}", status_code=status.HTTP_204_NO_CONTENT)',
                f"def delete_{snake}(",
                f"    {pk_param}: {pk_type},",
                f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
                ") -> None:",
                f"    if not repo.delete({pk_param}):",
                '        return JSONResponse(status_code=404, content={"error": "not_found"})',
            ]
        raise ValueError(f"unknown route handler '{name}'")

    def _emit_m2m_route(
        self, d: M2mDescriptor, snake: str, pk_param: str, pk_type: str, repo_class: str
    ) -> list[str]:
        """One M:N traversal route ``GET /{id}/<relationName>`` — a thin pass-through
        to the repository's ``find_related_*`` finder. Override to add filtering /
        pagination on the traversal."""
        return [
            f'@router.get("/{{{pk_param}}}/{d.relation_name}")',
            f"def list_{snake}_{d.relation_name}(",
            f"    {pk_param}: {pk_type},",
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
        # PK type from the BASE's declared primary key (subtypes share the
        # base's single table — mirrors the C# TPH pkType threading).
        pk = _pk_py_type(entity)
        pk_type = pk.expr
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
        sort_set_body = _py_set_literal(sort_fields)
        # FR-035 PATCH-2: @required fields across the base AND every subtype — an
        # explicit null on any of these is a 400 (the per-subtype update handlers
        # guard against it before the repo call). Union, stable order.
        required_names: list[str] = _required_field_names(entity)
        req_seen = set(required_names)
        for st in plan.subtypes:
            for name in _required_field_names(st.entity):
                if name not in req_seen:
                    req_seen.add(name)
                    required_names.append(name)
        required_set_body = _py_set_literal(required_names, frozen=True)

        h = generated_header(short_name, _effective_fqn(entity)).rstrip()
        parts: list[str] = []
        parts.append(
            h + "\n"
            + f'"""GENERATED — TPH polymorphic REST router for the {short_name} hierarchy '
            + '(single-table inheritance: polymorphic base + per-subtype CRUD)."""\n'
        )
        parts.append("from __future__ import annotations")
        parts.append("")
        for import_line in sorted(pk.imports):
            parts.append(import_line)
        if pk.imports:
            parts.append("")
        parts.append("from typing import Annotated, Any, Protocol")
        parts.append("")
        parts.append("from fastapi import APIRouter, Depends, Query, Request, status")
        parts.append("from fastapi.responses import JSONResponse")
        parts.append("from pydantic import BaseModel, ValidationError")
        parts.append("")
        parts.append("from metaobjects.codegen.runtime.filter_parser import (")
        parts.append("    FilterPredicate,")
        parts.append("    parse_filter,")
        parts.append(")")
        parts.append("")
        parts.append(f"from .{allowlist_module} import {fields_const}, {ops_const}")
        # FR-036: each concrete subtype's CREATE + all-optional PATCH validation models
        # drive the field constraints run on the per-subtype POST / PATCH (sibling
        # modules). These are the wire-shaped validation models, NOT the read model.
        for st in plan.subtypes:
            sub = st.entity.name
            parts.append(f"from .{sub} import {sub}Create, {sub}Patch")
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
        parts.append(f"_REQUIRED_FIELDS: frozenset[str] = {required_set_body}")
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
        parts.append(f"    def find_by_id(self, subtype: str | None, id: {pk_type}) -> Any | None: ...")
        parts.append("    def create(self, subtype: str, dto: Any) -> Any: ...")
        parts.append(f"    def update(self, subtype: str, id: {pk_type}, dto: Any) -> Any | None: ...")
        parts.append(f"    def delete(self, subtype: str, id: {pk_type}) -> bool: ...")
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

        # --- Per-subtype routes FIRST (literal segments match before /{id}). ---
        for st in plan.subtypes:
            seg = st.route_segment
            val = st.value
            sub = st.entity.name  # the subtype's generated create + PATCH model classes
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
            parts.append("    # FR-036: run the subtype's field constraints before persisting.")
            parts.append("    try:")
            parts.append(f"        {sub}Create(**dto)")
            parts.append("    except ValidationError:")
            parts.append('        return JSONResponse(status_code=400, content={"error": "validation"})')
            parts.append(f'    return repo.create("{val}", dto)')
            parts.append("")
            parts.append("")
            parts.append(f'@router.get("/{seg}/{{{pk_param}}}")')
            parts.append(f"def get_{plural}_{sfx}(")
            parts.append(f"    {pk_param}: {pk_type},")
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
            parts.append(f"    {pk_param}: {pk_type},")
            parts.append("    dto: dict[str, Any],")
            parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
            parts.append(") -> Any:")
            parts.append("    # FR-035 PATCH-2: an explicit null on a @required field is a 400.")
            parts.append("    for _k in _REQUIRED_FIELDS:")
            parts.append("        if _k in dto and dto[_k] is None:")
            parts.append('            return JSONResponse(status_code=400, content={"error": "validation"})')
            parts.append("    # FR-036: validate PRESENT, non-null values with the subtype's create rules.")
            parts.append("    try:")
            parts.append(f"        {sub}Patch(**dto)")
            parts.append("    except ValidationError:")
            parts.append('        return JSONResponse(status_code=400, content={"error": "validation"})')
            parts.append(f'    saved = repo.update("{val}", {pk_param}, dto)')
            parts.append("    if saved is None:")
            parts.append('        return JSONResponse(status_code=404, content={"error": "not_found"})')
            parts.append("    return saved")
            parts.append("")
            parts.append("")
            parts.append(f'@router.delete("/{seg}/{{{pk_param}}}", status_code=status.HTTP_204_NO_CONTENT)')
            parts.append(f"def delete_{plural}_{sfx}(")
            parts.append(f"    {pk_param}: {pk_type},")
            parts.append(f"    repo: Annotated[{repo_class}, Depends(get_repository)],")
            parts.append(") -> None:")
            parts.append(f'    if not repo.delete("{val}", {pk_param}):')
            parts.append('        return JSONResponse(status_code=404, content={"error": "not_found"})')
            parts.append("")
            parts.append("")

        # --- Polymorphic base routes LAST (so /{id} doesn't shadow /<segment>). ---
        parts.extend(list_sig(f"list_{plural}", ""))
        parts.extend(self._emit_tph_list_body("None", fields_const, ops_const))
        parts.append("")
        parts.append("")
        parts.append(f'@router.get("/{{{pk_param}}}")')
        parts.append(f"def get_{snake}(")
        parts.append(f"    {pk_param}: {pk_type},")
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
        pk = _pk_py_type(entity)
        pk_type = pk.expr
        repo_class = f"{short_name}Repository"
        sort_fields = [f.name for f in _scalar_fields(entity)]
        upper = short_name.upper()
        fields_const = f"{upper}_FILTER_FIELDS"
        ops_const = f"{upper}_FILTER_OPS_BY_FIELD"
        allowlist_module = f"{snake}_filter_allowlist"

        sort_set_body = _py_set_literal(sort_fields)
        # FR-035 PATCH-2: an explicit null on a @required field (scalar or jsonb)
        # is a 400 — the update handler guards these before the repo call.
        required_set_body = _py_set_literal(_required_field_names(entity), frozen=True)

        parts: list[str] = []
        parts.append(
            generated_header(short_name, _effective_fqn(entity)).rstrip() + "\n"
            + f'"""GENERATED — REST router for {short_name} entity. Implements the cross-port API contract."""\n'
        )
        parts.append("from __future__ import annotations")
        parts.append("")
        for import_line in sorted(pk.imports):
            parts.append(import_line)
        if pk.imports:
            parts.append("")
        parts.append("from typing import Annotated, Any, Protocol")
        parts.append("")
        parts.append("from fastapi import APIRouter, Depends, Query, Request, status")
        parts.append("from fastapi.responses import JSONResponse")
        parts.append("from pydantic import BaseModel, ValidationError")
        parts.append("")
        parts.append("from metaobjects.codegen.runtime.filter_parser import (")
        parts.append("    FilterPredicate,")
        parts.append("    parse_filter,")
        parts.append(")")
        parts.append("")
        parts.append(f"from .{allowlist_module} import {fields_const}, {ops_const}")
        # FR-036: the generated CREATE + all-optional PATCH validation models drive the
        # field constraints run on POST / PATCH. These are the WIRE-shaped validation
        # models (auto-gen PK / @readOnly omitted from create; PK omitted from patch;
        # both keyed by field.name), NOT the read/entity-shape model.
        parts.append(f"from .{short_name} import {short_name}Create, {short_name}Patch")
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
        parts.append(f"_REQUIRED_FIELDS: frozenset[str] = {required_set_body}")
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
        proto_lines = self._emit_repository_protocol(repo_class, m2m, pk_type)
        proto_lines.extend(self._emit_reverse_finders(entity))
        parts.extend(proto_lines)
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
            pk_type=pk_type,
            repo_class=repo_class,
            fields_const=fields_const,
            ops_const=ops_const,
            model_name=f"{short_name}Create",
            patch_model=f"{short_name}Patch",
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
            parts.extend(self._emit_m2m_route(d, snake, pk_param, pk_type, repo_class))
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
