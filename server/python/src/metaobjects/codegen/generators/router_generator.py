"""FastAPI router codegen — one ``<entity>_router.py`` per routed object.

A writable object (``source.rdb @kind="table"``, or a write-through entity) gets
the full CRUD router. A VIEW-backed object — an ``object.projection`` whose only
source is ``@kind="view"`` / ``"materializedView"`` — gets a READ-ONLY router:
GET list + GET by id, with every write verb answering the cross-port
``405 {"error": "method_not_allowed"}`` (F22). ``storedProc`` /
``tableFunction`` are invocations rather than collections and are still skipped.

FR-008 §2.3. Conforms to the cross-port REST API contract
(see ``docs/features/api-contract.md``):

* Routes: ``/api/<entity-plural-lowercase>`` (e.g. ``/api/authors``).
* 5 CRUD verbs: GET list, GET by id, POST create, PATCH+PUT update, DELETE.
* ``?withCount=1`` switches list response to ``{"rows", "total"}``.
* ``?sort=field:asc|desc`` parsed via a static per-entity allowlist
  (HTTP 400 envelope ``{"error": "invalid_sort"}`` on unknown field).
* ``?limit=N&offset=N`` pagination with defaults (limit=50, offset=0).
* HTTP 404 envelope: ``{"error": "not_found"}``.

``storedProc`` / ``tableFunction`` kinds are skipped — they have no
collection-and-item shape to mount.

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

from metaobjects.apidocs.naming import route_path as _route_path
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
from metaobjects.source_resolution import primary_rdb_source
from metaobjects.codegen.type_map import PyType, py_type_for
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.loader.validate_field_mutability import (
    is_read_only_mutability,
    is_write_once_mutability,
)
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.persistence.db import db_constants as dbc
from metaobjects.meta.core.identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_SUBTYPE_REFERENCE,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.relationship.relationship_references import (
    reference_target_entity,
)
from metaobjects.meta.persistence.source.source_constants import (
    SOURCE_KIND_MATERIALIZED_VIEW,
    SOURCE_KIND_TABLE,
    SOURCE_KIND_VIEW,
)
from metaobjects.naming import DEFAULT_COLUMN_NAMING
from metaobjects.shared.base_types import TYPE_IDENTITY
from metaobjects.shared.separators import PACKAGE_SEP


def _effective_fqn(entity: MetaObject) -> str:
    """``package::name`` via the canonical :meth:`MetaData.resolution_key` (own
    package, else file-default, else ancestor) — multi-file-merge safe. Mirrors the
    entity-model generator's helper of the same name."""
    return entity.resolution_key()


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
    # #203/ADR-0045: an @autoSet field is server-owned — never a caller-facing PATCH field, so
    # it is not present-null-checked (a caller-sent null is ignored/stamped, not a 400). Mirrors
    # the Kotlin controller (which excludes @autoSet from its patch-settable set).
    return [f.name for f in entity.fields() if is_required(f) and not _is_auto_set(f)]


# --- #203 / ADR-0045: @autoSet stamping in the generated router (above the repo seam) ----------

_AUTO_SET_TEMPORAL_SUBTYPES = (
    fc.FIELD_SUBTYPE_DATE,
    fc.FIELD_SUBTYPE_TIME,
    fc.FIELD_SUBTYPE_TIMESTAMP,
)


def _is_auto_set(field: MetaField) -> bool:
    """True iff *field* is a server-owned ``@autoSet`` column (ADR-0039 resolving read)."""
    return field.get_meta_attr(fc.FIELD_ATTR_AUTO_SET) in (
        fc.AUTO_SET_ON_CREATE,
        fc.AUTO_SET_ON_UPDATE,
    )


def _frozen_names(entity: MetaObject) -> list[str]:
    """FR-037 R1 — the field names a PATCH must never write: `@mutability`
    ``readOnly`` (nobody writes it) and ``writeOnce`` (frozen after create).

    ADR-0045: the OUTERMOST generated write artifact enforces the mode, and for
    FastAPI that is the ROUTER, not the ``<Entity>Patch`` model — the handler binds
    ``dto: dict[str, Any]`` (the raw body) and passes THAT to the repository, so a
    field merely absent from the patch model still reaches the row. @autoSet gets
    away with it because the router OVERWRITES its key server-side; a writeOnce
    field has no server value to overwrite, so it must be popped explicitly."""
    return [
        f.name
        for f in entity.fields()
        if is_read_only_mutability(f) or is_write_once_mutability(f)
    ]


def _frozen_strip_lines(entity: MetaObject, indent: str = "    ") -> list[str]:
    """The pop-loop for :func:`_frozen_names`. Empty for an entity declaring no
    non-readWrite mode — so output stays byte-identical for every existing model."""
    names = _frozen_names(entity)
    if not names:
        return []
    return [
        f"{indent}# FR-037 R1: @mutability readOnly / writeOnce are not PATCH-settable.",
        f"{indent}# STRIPPED, never 400'd — the uniform behaviour of every excluded key",
        f"{indent}# on this path. Popping also covers the FR-035 present-null arm, since",
        f"{indent}# clearing a column is itself a write.",
        f"{indent}for _frozen in _FROZEN_FIELDS:",
        f"{indent}    dto.pop(_frozen, None)",
    ]


def _auto_set_split(entity: MetaObject) -> tuple[list[MetaField], list[MetaField]]:
    """The entity's ``@autoSet`` temporal fields split into ``(onCreate, onUpdate)``.

    Reads the RESOLVING ``@autoSet`` (ADR-0039) so an inherited
    ``BaseEntity.createdAt/updatedAt`` is honored; a non-temporal field is skipped.
    Both lists are empty for an entity that declares none, keeping its router
    byte-identical to the pre-#203 output."""
    on_create: list[MetaField] = []
    on_update: list[MetaField] = []
    for f in entity.fields():
        if f.sub_type not in _AUTO_SET_TEMPORAL_SUBTYPES:
            continue
        mode = f.get_meta_attr(fc.FIELD_ATTR_AUTO_SET)  # ADR-0039 resolving: may be inherited via extends
        if mode == fc.AUTO_SET_ON_CREATE:
            on_create.append(f)
        elif mode == fc.AUTO_SET_ON_UPDATE:
            on_update.append(f)
    return on_create, on_update


def _auto_set_stamp_expr(field: MetaField, base_var: str) -> str:
    """The inline now()-expression for an ``@autoSet`` *field*, derived from one shared
    tz-aware *base_var* datetime so every column stamped in one op is equal (a fresh
    row's created == updated). Keyed off the COLUMN's temporal type: ``field.date`` →
    ``.date()``; ``field.time`` → ``.time()``; ``field.timestamp`` → the tz-aware base
    (``@localTime`` → a naive wall-clock value). Mirrors ObjectManager._auto_set_stamp."""
    sub = field.sub_type
    if sub == fc.FIELD_SUBTYPE_DATE:
        return f"{base_var}.date()"
    if sub == fc.FIELD_SUBTYPE_TIME:
        return f"{base_var}.time()"
    is_tz = field.get_meta_attr(dbc.FIELD_ATTR_LOCAL_TIME) is not True  # ADR-0039 resolving
    return base_var if is_tz else f"{base_var}.replace(tzinfo=None)"


def _auto_set_stamp_lines(fields: list[MetaField], comment: str) -> list[str]:
    """Router-handler body lines stamping *fields* into ``dto`` from ONE captured base
    instant (so all same-op columns are equal), led by *comment*. Empty for no fields
    (so the call site spreads to nothing — a non-@autoSet router stays byte-identical)."""
    if not fields:
        return []
    lines = [f"    # {comment}", "    _asnow = _dt.datetime.now(_dt.timezone.utc)"]
    lines += [f'    dto["{f.name}"] = {_auto_set_stamp_expr(f, "_asnow")}' for f in fields]
    return lines


def _m2m_target_discs(mounts: list[M2mDescriptor]) -> dict[str, set[str | None]]:
    """Per relation NAME, the set of target discriminators every mount of that
    name resolves to (``None`` = a non-TPH target) — the ONE decision both the
    ``find_related_<relation>`` seam signature and every call site derive from.
    A name mounted more than once (a TPH hierarchy serves it at the base path and
    under subtype segments, and a subtype may legally SHADOW a base-declared
    relationship with a target of different TPH-ness) must not let one mount's
    descriptor decide the seam for all of them."""
    out: dict[str, set[str | None]] = {}
    for d in mounts:
        out.setdefault(d.relation_name, set()).add(d.target_discriminator)
    return out


def _target_subtype_param(discs: set[str | None]) -> str:
    """FW-8 follow-up: the ``target_subtype`` clause of a
    ``find_related_<relation>`` Protocol signature, decided per relation NAME
    from *discs* (:func:`_m2m_target_discs`): empty when no mount of the name
    targets a TPH subtype (byte-identical output for the overwhelming common
    case); ``, target_subtype: str`` when every mount does; and
    ``, target_subtype: str | None`` when only some do — the parameter then
    threads UNIFORMLY for the name, the non-TPH mounts passing an explicit
    ``None``, so the seam and every call site agree on arity."""
    if not discs or discs == {None}:
        return ""
    if None in discs:
        return ", target_subtype: str | None"
    return ", target_subtype: str"


def _target_subtype_arg(d: M2mDescriptor, discs: set[str | None]) -> str:
    """The call-site counterpart of :func:`_target_subtype_param`, derived from
    the SAME per-name decision: nothing when the name has no parameter, this
    mount's resolved ``@discriminatorValue`` literal when it does, and an
    explicit ``None`` literal for a non-TPH mount of a name that threads it."""
    if not discs or discs == {None}:
        return ""
    if d.target_discriminator is None:
        return ", None"
    return f', "{d.target_discriminator}"'


def _py_set_literal(names: list[str], *, frozen: bool = False) -> str:
    """A Python set/frozenset literal from field names, matching the generated
    allowlist idiom (one quoted name per line). Empty → ``frozenset()`` / ``set()``."""
    empty = "frozenset()" if frozen else "set()"
    if not names:
        return empty
    body = "{\n" + "".join(f'    "{name}",\n' for name in names) + "}"
    return f"frozenset({body})" if frozen else body


def _py_sort_default_order_literal(fields: list[MetaField]) -> str:
    """A ``dict[str, str]`` literal of each field's DECLARED ``@sortableDefaultOrder``.

    Declared orders only — a field with no ``@sortableDefaultOrder`` is absent and the
    generated ``_parse_sort`` supplies ``"asc"``. That split matches the other four
    ports: one place per port spells the fallback, so no port can drift by baking a
    different default into its map.

    ADR-0039: ``attrs()`` is the RESOLVING accessor in Python (``attr()`` is own-only),
    so an ``@sortableDefaultOrder`` inherited via ``extends`` is honoured.
    """
    rows = []
    for f in fields:
        v = f.attrs().get(fc.FIELD_ATTR_SORTABLE_DEFAULT_ORDER)
        if v in ("asc", "desc"):
            rows.append(f'    "{f.name}": "{v}",\n')
    if not rows:
        return "{}"
    return "{\n" + "".join(rows) + "}"


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


#: The ``except`` arm every generated WRITE handler carries, emitted verbatim.
#:
#: A generated CRUD route had no try/except around its write, so a driver failure reached
#: FastAPI's default handler and the caller got a bare 500 — for what is a CLIENT error
#: (a foreign key that does not exist, a value duplicating a unique one), both declared by
#: the same metadata the route already validates against. An UNRECOGNISED exception is
#: re-raised bare, so the operator keeps the full diagnostic and the caller gets a plain
#: 500 carrying none of it. See ``runtime/constraint_errors.py``.
_CONSTRAINT_EXCEPT: tuple[str, ...] = (
    "    except Exception as exc:",
    "        failure = classify_constraint_error(exc)",
    "        if failure is None:",
    "            raise",
    "        return JSONResponse(status_code=failure.status, content=failure.body())",
)


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
        # #368 fallout: @references may be the dotted `Entity.field` /
        # `Entity.fieldA,fieldB` explicit-fields form (e.g. "acme::sport::Team.id"),
        # not just a bare/qualified entity name. reference_target_entity() already
        # drops that dotted tail (ADR-0039: resolving); strip_package here then bares
        # the remaining qualified entity name, same as the pre-existing package strip.
        target = reference_target_entity(c)
        if isinstance(target, str) and PACKAGE_SEP in target:
            target = target[target.rfind(PACKAGE_SEP) + len(PACKAGE_SEP):]
        if not fk_field or not target:
            continue
        out.append(ReverseFk(fk_field=fk_field, target_entity=target))
    return out


# F22 — the read-only source kinds that still get a REST surface. A view (and a
# materialized view) is a collection of rows addressable by the identity the
# projection inherits, which is exactly the shape a collection-and-item REST
# resource needs. `storedProc` / `tableFunction` are invocations, not collections:
# they have no such shape and stay skipped, as they are for the writable router.
_READ_ONLY_ROUTED_KINDS = frozenset({SOURCE_KIND_VIEW, SOURCE_KIND_MATERIALIZED_VIEW})


def emits_router(entity: MetaObject) -> bool:
    """Whether this object gets a generated router — writable CRUD or read-only.

    THE single source of truth for the router emit set, exported so
    ``filter_allowlist_generator`` can gate on the same answer instead of a
    second copy of the rule. The generated router does ``from
    .<snake>_filter_allowlist import ...``, so an allowlist emitted for a
    different set than the routers is not a cosmetic mismatch — the module is
    missing at import and the app fails to start. That failure mode is already
    recorded in this codebase for the write-through case; keeping two copies of
    the predicate is what let it happen, so there is now one.
    """
    if not emits_instance_artifacts(entity):
        return False
    src = primary_rdb_source(entity)
    if src is None:
        return False
    kind = src.effective_kind()
    return (
        entity.is_write_through()
        or kind == SOURCE_KIND_TABLE
        or kind in _READ_ONLY_ROUTED_KINDS
    )


def _sort_type_and_tables_lines(sort_field_nodes: list[MetaField]) -> list[str]:
    """The `_SortClause` model + the two sort lookup tables.

    Shared by the writable and read-only routers. Split from the parse function
    below only because the writable module emits `_REQUIRED_FIELDS` /
    `_FROZEN_FIELDS` between the two, and moving them would churn every writable
    entity's generated file for no behavioural gain."""
    sort_fields = [f.name for f in sort_field_nodes]
    return [
        "class _SortClause(BaseModel):",
        '    """GENERATED — parsed sort directive (field + asc/desc)."""',
        "    field: str",
        "    direction: str",
        "",
        "",
        f"_SORT_ALLOWLIST: set[str] = {_py_set_literal(sort_fields)}",
        "",
        "",
        f"_SORT_DEFAULT_ORDER: dict[str, str] = {_py_sort_default_order_literal(sort_field_nodes)}",
    ]


def _sort_parse_fn_lines() -> list[str]:
    """The `_parse_sort` helper. Shared by the writable and read-only routers, so a
    projection cannot answer `?sort` differently from a table entity."""
    return [
        'def _parse_sort(raw: str) -> _SortClause | None:',
        '    """Parse `field:asc|desc`; return None for malformed / disallowed input."""',
        '    parts = raw.split(":", 1)',
        "    if not parts or parts[0] not in _SORT_ALLOWLIST:",
        "        return None",
        # `?sort=field` with no `:order` takes the field's DECLARED
        # @sortableDefaultOrder. The "asc" fallback stays at the READ, one place.
        '    direction = (',
        '        parts[1].lower() if len(parts) == 2',
        '        else _SORT_DEFAULT_ORDER.get(parts[0], "asc")',
        '    )',
        '    if direction not in ("asc", "desc"):',
        "        return None",
        "    return _SortClause(field=parts[0], direction=direction)",
    ]


class RouterGenerator:
    """One ``<entity_snake>_router.py`` per routed object (FastAPI ``APIRouter``):
    full CRUD for a writable source, read-only for a view-backed one.

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
    * ``_emit_tph_m2m_route(d, ..., subtype_expr)`` — one M:N traversal route
      INSIDE a TPH hierarchy (FW-8), threading the discriminator scope through
      the subtype-keyed ``find_related_*`` seam.
    * ``render_router(entity, object_index)`` — the whole module (last resort).

    Skips objects without a ``source.rdb`` child, and the non-collection
    read-only kinds (storedProc / tableFunction). See :func:`emits_router`.
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
        discs = _m2m_target_discs(m2m)
        for d in m2m:
            lines.append(
                f"    def find_related_{d.relation_name}(self, id: {pk_type}"
                f"{_target_subtype_param(discs[d.relation_name])}) -> list[Any]: ..."
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
        create_autoset: list[str] = (),
        update_autoset: list[str] = (),
        frozen_strip: list[str] = (),
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
                '            return JSONResponse(status_code=400, content={"error": "invalid_sort", "field": sort.split(":", 1)[0]})',
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
                # #203/ADR-0045: the generated router (the API surface) stamps @autoSet columns
                # ABOVE the consumer repo seam — onCreate + onUpdate both stamped from one instant
                # (a fresh row's createdAt == updatedAt), ignoring any caller-supplied value.
                *create_autoset,
                "    try:",
                "        return repo.create(dto)",
                *_CONSTRAINT_EXCEPT,
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
                # #203/ADR-0045: bump onUpdate @autoSet columns (server-owned) on EVERY patch,
                # above the repo seam — a server-inserted present key (compatible with the PATCH
                # present-key tristate); onCreate columns are never touched here.
                *update_autoset,
                *frozen_strip,
                "    try:",
                f"        saved = repo.update({pk_param}, dto)",
                *_CONSTRAINT_EXCEPT,
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
                "    try:",
                f"        deleted = repo.delete({pk_param})",
                *_CONSTRAINT_EXCEPT,
                "    if not deleted:",
                '        return JSONResponse(status_code=404, content={"error": "not_found"})',
            ]
        raise ValueError(f"unknown route handler '{name}'")

    def _emit_m2m_route(
        self, d: M2mDescriptor, snake: str, pk_param: str, pk_type: str, repo_class: str
    ) -> list[str]:
        """One M:N traversal route ``GET /{id}/<relationName>`` — a thin pass-through
        to the repository's ``find_related_*`` finder. Override to add filtering /
        pagination on the traversal. FW-8 follow-up: when the target resolves to a
        TPH subtype, the call also carries the resolved ``target_subtype`` literal
        (see :func:`_target_subtype_arg`) — empty for a vanilla target. A vanilla
        render mounts a name exactly once, so the name's decision set is the
        mount's own singleton."""
        return [
            f'@router.get("/{{{pk_param}}}/{d.relation_name}")',
            f"def list_{snake}_{d.relation_name}(",
            f"    {pk_param}: {pk_type},",
            f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
            ") -> list[Any]:",
            f"    return repo.find_related_{d.relation_name}"
            f"({pk_param}{_target_subtype_arg(d, {d.target_discriminator})})",
        ]

    def _emit_tph_m2m_route(
        self,
        d: M2mDescriptor,
        *,
        handler_name: str,
        route: str,
        pk_param: str,
        pk_type: str,
        repo_class: str,
        subtype_expr: str,
        gated: bool,
        target_discs: set[str | None],
    ) -> list[str]:
        """One M:N traversal route INSIDE a TPH hierarchy (FW-8) — ``GET`` *route*
        delegating to the subtype-keyed ``find_related_<relation>(subtype, id)`` seam,
        the same discriminator-first shape every other TPH Protocol method already
        uses (``find_by_id(subtype, id)``, ...).

        *subtype_expr* is the Python literal threaded as the discriminator scope:
        ``"None"`` for a mount at the BASE path (every row of the shared table is a
        legitimate source — rule a), or a quoted ``@discriminatorValue`` for a mount
        under a subtype's segment (rule b).

        *target_discs* is the relation NAME's decision set across EVERY mount of
        that name in the hierarchy (:func:`_m2m_target_discs`) — the same decision
        the Protocol seam signature derives from, so this call site and the seam
        cannot disagree on the ``target_subtype`` parameter's arity.

        *gated* — True for a subtype mount — composes the seam's OWN
        ``find_by_id(subtype, id)`` (the exact lookup the per-subtype GET route
        already calls, and the ``tph-cross-subtype-404`` conformance scenario
        already gates) as a subtype-ownership check BEFORE the join: a miss
        returns ``[]`` (HTTP 200), never 404 and never the ``find_related_*`` call.
        This ENFORCES rule (c) in generated code rather than delegating it to the
        consumer — a ``find_related_*`` implementation that forgets to filter by
        subtype can no longer leak a sibling's rows, because it is never reached
        for a mismatched id. No new query strategy: it reuses a method the
        consumer must already implement correctly. False (the BASE mount) skips
        the gate — a redundant lookup there would be pure overhead, since every
        row of the shared table is already a legitimate source (rule a)."""
        lines = [
            f'@router.get("{route}")',
            f"def {handler_name}(",
            f"    {pk_param}: {pk_type},",
            f"    repo: Annotated[{repo_class}, Depends(get_repository)],",
            ") -> list[Any]:",
        ]
        if gated:
            lines += [
                f"    if repo.find_by_id({subtype_expr}, {pk_param}) is None:",
                "        return []",
            ]
        lines.append(
            f"    return repo.find_related_{d.relation_name}"
            f"({subtype_expr}, {pk_param}{_target_subtype_arg(d, target_discs)})"
        )
        return lines

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
            '            return JSONResponse(status_code=400, content={"error": "invalid_sort", "field": sort.split(":", 1)[0]})',
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

    def _render_tph_router(
        self,
        entity: MetaObject,
        plan: TphPlan,
        object_index: dict[str, MetaObject],
        column_naming: str = DEFAULT_COLUMN_NAMING,
    ) -> str:
        """FR-017 TPH: emit the discriminator base's router — a polymorphic collection
        at the base path + a full per-subtype CRUD set at /<base>/<segment>. The repo
        seam is subtype-keyed (the ``@discriminatorValue``, or ``None`` for the base);
        the consumer's repo applies the single-table discriminator scope.

        FW-8: also emits M:N traversal routes — one for every relationship the BASE
        resolves (rule a), and one for every relationship each CONCRETE SUBTYPE
        resolves, INHERITED ones included (rule b/d). ``resolve_m2m_descriptors`` is
        called directly against the base and against each subtype's entity (never via
        ``render_router``, which returns ``None`` for a TPH subtype before reaching
        M:N resolution at all — the two independent gaps this fix closes)."""
        short_name = entity.name
        snake = _snake_case(short_name)
        plural = _route_path(short_name)
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

        # #203/ADR-0045: @autoSet columns live on the BASE entity and are shared by every
        # subtype (RESOLVING _auto_set_split(entity) picks up an inherited BaseEntity
        # column too) — computed once here and threaded into each per-subtype handler
        # below (empty for a non-@autoSet hierarchy → byte-identical output).
        on_create_auto, on_update_auto = _auto_set_split(entity)
        has_autoset = bool(on_create_auto or on_update_auto)
        create_autoset = _auto_set_stamp_lines(
            on_create_auto + on_update_auto,
            "#203/ADR-0045: stamp @autoSet columns (server-owned; caller ignored).",
        )
        update_autoset = [
            f'    dto.pop("{f.name}", None)  # onCreate @autoSet is write-once (server-owned)'
            for f in on_create_auto
        ] + _auto_set_stamp_lines(
            on_update_auto,
            "#203/ADR-0045: bump onUpdate @autoSet column(s) (server-owned).",
        )

        # Sort allowlist = base scalar fields ∪ every subtype's own scalar fields, so a
        # per-subtype list can sort on a subtype-only column too. Stable order.
        sort_field_nodes = list(_scalar_fields(entity))
        sort_fields: list[str] = [f.name for f in sort_field_nodes]
        seen = set(sort_fields)
        for st in plan.subtypes:
            for f in _scalar_fields(st.entity):
                if f.name not in seen:
                    seen.add(f.name)
                    sort_fields.append(f.name)
                    sort_field_nodes.append(f)
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
        # FR-037 R1 — non-readWrite @mutability across the base AND every subtype.
        # Union, stable order: ADR-0045 says the OUTERMOST artifact enforces the mode,
        # and a TPH per-subtype handler is a SEPARATE code path (the 0.19.4 lesson).
        frozen_names: list[str] = _frozen_names(entity)
        frozen_seen = set(frozen_names)
        for st in plan.subtypes:
            for name in _frozen_names(st.entity):
                if name not in frozen_seen:
                    frozen_seen.add(name)
                    frozen_names.append(name)
        frozen_set_body = _py_set_literal(frozen_names, frozen=True)
        frozen_strip_tph = _frozen_strip_lines(entity) if frozen_names else []
        if frozen_names and not _frozen_names(entity):
            # A subtype-only frozen field still needs the strip emitted.
            frozen_strip_tph = [
                "    # FR-037 R1: @mutability readOnly / writeOnce are not PATCH-settable.",
                "    # STRIPPED, never 400'd — the uniform behaviour of every excluded key",
                "    # on this path. Popping also covers the FR-035 present-null arm, since",
                "    # clearing a column is itself a write.",
                "    for _frozen in _FROZEN_FIELDS:",
                "        dto.pop(_frozen, None)",
            ]

        # FW-8 — FR-018 x FR-017: M:N traversal inside a TPH hierarchy. Resolved
        # directly against the base and against each subtype's OWN entity (never via
        # `render_router`, which bails out for a TPH subtype before any M:N question
        # at all). `resolve_m2m_descriptors` reads the RESOLVING `children()`
        # (m2m_relationships), so a subtype's list already includes relationships
        # inherited from the base or an abstract intermediate level — that overlap
        # with the base's own list is rule (b), not a bug.
        base_m2m = resolve_m2m_descriptors(entity, object_index, column_naming)
        sub_m2m: dict[str, list[M2mDescriptor]] = {
            st.entity.name: resolve_m2m_descriptors(st.entity, object_index, column_naming)
            for st in plan.subtypes
        }
        # One `find_related_<relation>` Protocol seam per DISTINCT relation name
        # anywhere in the hierarchy — mirrors the sort/required/frozen unions above.
        # `subtype` threads through exactly like every other TPH seam method: `None`
        # from the base route, the @discriminatorValue from a subtype route.
        m2m_union: list[M2mDescriptor] = list(base_m2m)
        m2m_seen = {d.relation_name for d in m2m_union}
        for st in plan.subtypes:
            for d in sub_m2m[st.entity.name]:
                if d.relation_name not in m2m_seen:
                    m2m_seen.add(d.relation_name)
                    m2m_union.append(d)
        # `target_subtype` presence is decided per relation NAME across EVERY mount
        # of that name — base path and subtype segments together — never by the
        # first descriptor the union kept: a subtype may SHADOW a base-declared
        # relationship with a target of different TPH-ness, and the seam signature
        # and every call site below derive from this one map.
        m2m_target_discs = _m2m_target_discs(
            list(base_m2m)
            + [d for st in plan.subtypes for d in sub_m2m[st.entity.name]]
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
        if has_autoset:
            # #203/ADR-0045: the router stamps @autoSet columns inline (no runtime dependency).
            parts.append("import datetime as _dt")
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
        parts.append("from metaobjects.codegen.runtime.constraint_errors import (")
        parts.append("    classify_constraint_error,")
        parts.append(")")
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
        parts.extend(_sort_type_and_tables_lines(sort_field_nodes))
        parts.append("")
        parts.append("")
        parts.append(f"_REQUIRED_FIELDS: frozenset[str] = {required_set_body}")
        parts.append("")
        parts.append("")
        # FR-037 R1 — the names a PATCH must never write. Emitted even when EMPTY so
        # the generated module always carries the seam (an entity that later gains a
        # writeOnce field changes one literal, not the module's shape).
        parts.append(f"_FROZEN_FIELDS: frozenset[str] = {frozen_set_body}")
        parts.append("")
        parts.append("")
        parts.extend(_sort_parse_fn_lines())
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
        # FW-8: one find_related_<relation> seam per relation name resolved ANYWHERE
        # in the hierarchy (base ∪ every subtype) — `subtype` scopes the traversal the
        # same way every method above does; the consumer verifies a subtype-scoped id
        # really is that subtype's, answering [] rather than a sibling's rows.
        for d in m2m_union:
            parts.append(
                f"    def find_related_{d.relation_name}(self, subtype: str | None, id: {pk_type}"
                f"{_target_subtype_param(m2m_target_discs[d.relation_name])}) -> list[Any]: ..."
            )
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
            # #203/ADR-0045: stamp @autoSet columns ABOVE the repo seam (empty for a
            # non-@autoSet hierarchy — byte-identical output).
            parts.extend(create_autoset)
            parts.append("    try:")
            parts.append(f'        return repo.create("{val}", dto)')
            parts.extend(_CONSTRAINT_EXCEPT)
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
            # #203/ADR-0045: pop the write-once onCreate column(s), bump onUpdate — ABOVE
            # the repo seam (empty for a non-@autoSet hierarchy — byte-identical output).
            parts.extend(update_autoset)
            parts.extend(frozen_strip_tph)
            parts.append("    try:")
            parts.append(f'        saved = repo.update("{val}", {pk_param}, dto)')
            parts.extend(_CONSTRAINT_EXCEPT)
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
            parts.append("    try:")
            parts.append(f'        deleted = repo.delete("{val}", {pk_param})')
            parts.extend(_CONSTRAINT_EXCEPT)
            parts.append("    if not deleted:")
            parts.append('        return JSONResponse(status_code=404, content={"error": "not_found"})')
            parts.append("")
            parts.append("")

            # FW-8 rule (b)/(d): every relationship THIS subtype resolves — inherited
            # from the base or an abstract intermediate level included — mounted under
            # its own segment. Stays inside the subtype loop (registered before the
            # base's `/{id}` routes below) for the same reason the CRUD block above
            # does: a literal segment must be tried before a dynamic one, or FastAPI's
            # path-param coercion 422s before a later, more specific route is tried.
            for d in sub_m2m[sub]:
                parts.extend(self._emit_tph_m2m_route(
                    d,
                    handler_name=f"list_{plural}_{sfx}_{d.relation_name}",
                    route=f"/{seg}/{{{pk_param}}}/{d.relation_name}",
                    pk_param=pk_param,
                    pk_type=pk_type,
                    repo_class=repo_class,
                    subtype_expr=f'"{val}"',
                    gated=True,
                    target_discs=m2m_target_discs[d.relation_name],
                ))
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

        # FW-8 rule (a): every relationship the BASE resolves — every row of the
        # shared table is a legitimate source, so this is the same shape a vanilla
        # entity's mount gets (subtype=None, no discriminator gate).
        for d in base_m2m:
            parts.append("")
            parts.extend(self._emit_tph_m2m_route(
                d,
                handler_name=f"list_{snake}_{d.relation_name}",
                route=f"/{{{pk_param}}}/{d.relation_name}",
                pk_param=pk_param,
                pk_type=pk_type,
                repo_class=repo_class,
                subtype_expr="None",
                gated=False,
                target_discs=m2m_target_discs[d.relation_name],
            ))
            parts.append("")

        return "\n".join(parts)

    def render_router(
        self,
        entity: MetaObject,
        object_index: dict[str, MetaObject] | None = None,
        column_naming: str = DEFAULT_COLUMN_NAMING,
    ) -> str | None:
        """Render an entity as a FastAPI ``APIRouter`` module.

        Returns ``None`` when the object gets no router at all — no ``source.rdb``
        child, or a non-collection read-only kind (storedProc / tableFunction). A
        view-backed object returns a READ-ONLY router instead of ``None`` (F22);
        :func:`emits_router` is the predicate.

        When *object_index* is supplied, each M:N navigation on the entity
        (``relationship.* @cardinality:"many" + @through``) also emits a FastAPI
        traversal route ``GET /<source-plural>/{id}/<relationName>`` returning the
        related target rows, plus a typed ``find_related_<relation>`` finder on the
        repository ``Protocol`` seam (the consumer joins through the junction). The
        source URL segment is the ENTITY name pluralized (cross-port grammar), NOT
        the physical ``@table``. Without an index, only CRUD is emitted (back-compat).

        *column_naming* is ``GenConfig.column_naming`` for this run — passed through
        to :func:`resolve_m2m_descriptors` so the M:N descriptor's physical junction
        columns are resolved by the SAME strategy the ``names`` generator applies to
        every other column on the same fields. Nothing this generator currently emits
        reads the descriptor's physical-name fields (only ``.target_entity`` /
        ``.relation_name``), so this has no effect on today's output — it exists so
        the descriptor itself never gives two different answers for one column
        within one run.
        """
        if not emits_instance_artifacts(entity):
            return None
        # FR-017 TPH: a concrete subtype is folded into its base's single table — it
        # emits no standalone router (its CRUD lives under the base's per-subtype segment).
        if object_index is not None and is_tph_subtype(entity):
            return None
        src = primary_rdb_source(entity)
        if src is None:
            return None
        # FR-024 §7 (#214): a write-through entity read-view is writable (owns a table
        # source) and MUST emit its CRUD router regardless of source declaration order —
        # the first-source gate below would wrongly skip a view-source-first write-through
        # entity. Reads route to the replica view in the ObjectManager (not here).
        if not entity.is_write_through() and src.effective_kind() != SOURCE_KIND_TABLE:
            # F22: a VIEW-only object is not write-through, and used to stop here —
            # emitting no router at all, while TypeScript and C# served it. It gets a
            # READ-ONLY router instead: GET list + GET by id, every write verb
            # answering the cross-port 405 envelope. Gated by
            # fixtures/api-contract-conformance/projection/.
            if src.effective_kind() in _READ_ONLY_ROUTED_KINDS:
                return self._render_readonly_router(entity, column_naming)
            return None

        # FR-017 TPH: a discriminator base emits a polymorphic collection at the base
        # path PLUS a full per-subtype CRUD set at /<base>/<discriminatorValue lowercased>.
        if object_index is not None:
            plan = tph_plan_for(entity, object_index)
            if plan is not None:
                return self._render_tph_router(entity, plan, object_index, column_naming)

        m2m: list[M2mDescriptor] = (
            resolve_m2m_descriptors(entity, object_index, column_naming)
            if object_index is not None
            else []
        )

        short_name = entity.name
        snake = _snake_case(short_name)
        plural = _route_path(short_name)
        pk_param = f"{snake}_id"
        pk = _pk_py_type(entity)
        pk_type = pk.expr
        repo_class = f"{short_name}Repository"
        sort_field_nodes = list(_scalar_fields(entity))
        upper = short_name.upper()
        fields_const = f"{upper}_FILTER_FIELDS"
        ops_const = f"{upper}_FILTER_OPS_BY_FIELD"
        allowlist_module = f"{snake}_filter_allowlist"

        # FR-035 PATCH-2: an explicit null on a @required field (scalar or jsonb)
        # is a 400 — the update handler guards these before the repo call.
        required_set_body = _py_set_literal(_required_field_names(entity), frozen=True)
        # FR-037 R1 — the names a PATCH must never write (readOnly / writeOnce).
        frozen_set_body = _py_set_literal(_frozen_names(entity), frozen=True)

        # #203/ADR-0045: @autoSet stamp lines for the create/update handlers (empty for a
        # non-@autoSet entity → byte-identical output). insert stamps onCreate+onUpdate from one
        # instant; a patch bumps onUpdate only (createdAt stays immutable).
        _on_create_auto, _on_update_auto = _auto_set_split(entity)
        create_autoset = _auto_set_stamp_lines(
            _on_create_auto + _on_update_auto,
            "#203/ADR-0045: stamp @autoSet columns (server-owned; caller ignored).",
        )
        # #203/ADR-0045 (integrity): onCreate @autoSet columns are write-once — strip any
        # caller-supplied value on PATCH before the repo call (a caller cannot mutate createdAt via
        # the deployed API). Mirrors ObjectManager.update (`data.pop(...)`) + the Kotlin controller
        # (which excludes @autoSet from its patch-settable set).
        update_autoset = [
            f'    dto.pop("{f.name}", None)  # onCreate @autoSet is write-once (server-owned)'
            for f in _on_create_auto
        ] + _auto_set_stamp_lines(
            _on_update_auto,
            "#203/ADR-0045: bump onUpdate @autoSet column(s) (server-owned).",
        )
        has_autoset = bool(_on_create_auto or _on_update_auto)

        parts: list[str] = []
        parts.append(
            generated_header(short_name, _effective_fqn(entity)).rstrip() + "\n"
            + f'"""GENERATED — REST router for {short_name} entity. Implements the cross-port API contract."""\n'
        )
        parts.append("from __future__ import annotations")
        parts.append("")
        if has_autoset:
            # #203/ADR-0045: the router stamps @autoSet columns inline (no runtime dependency).
            parts.append("import datetime as _dt")
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
        parts.append("from metaobjects.codegen.runtime.constraint_errors import (")
        parts.append("    classify_constraint_error,")
        parts.append(")")
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
        parts.extend(_sort_type_and_tables_lines(sort_field_nodes))
        parts.append("")
        parts.append("")
        parts.append(f"_REQUIRED_FIELDS: frozenset[str] = {required_set_body}")
        parts.append("")
        parts.append("")
        # FR-037 R1 — the names a PATCH must never write. Emitted even when EMPTY so
        # the generated module always carries the seam (an entity that later gains a
        # writeOnce field changes one literal, not the module's shape).
        parts.append(f"_FROZEN_FIELDS: frozenset[str] = {frozen_set_body}")
        parts.append("")
        parts.append("")
        parts.extend(_sort_parse_fn_lines())
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
            create_autoset=create_autoset,
            update_autoset=update_autoset,
            # FR-037 R1 — ADR-0045: the ROUTER is the outermost write artifact for
            # FastAPI (the handler binds the RAW body dict and hands THAT to the
            # repository), so the strip has to live here, not in <Entity>Patch.
            frozen_strip=_frozen_strip_lines(entity),
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

    def _emit_readonly_reject_handlers(self, snake: str, plural: str, pk_param: str) -> list[str]:
        """The write verbs on a read-only projection, each answering the cross-port
        405 envelope.

        405 and not 404: the resource plainly exists — the same path answers GET —
        and 404 would tell a caller the collection is absent when it is merely not
        writable. Mounted EXPLICITLY rather than left to FastAPI, which answers an
        unmatched method with its own ``{"detail": "Method Not Allowed"}`` and so
        would put a fifth body shape on a wire the other ports spell one way.

        PUT is here because the writable router serves it; a projection has to
        refuse every verb the writable surface offers, or the one it forgets falls
        through to a 404 (which is exactly what TypeScript did until F22)."""
        lines: list[str] = []
        for i, (verb, path, fn) in enumerate((
            ("post", '""', f"create_{snake}"),
            ("patch", f'"/{{{pk_param}}}"', f"update_{snake}"),
            ("put", f'"/{{{pk_param}}}"', f"replace_{snake}"),
            ("delete", f'"/{{{pk_param}}}"', f"delete_{snake}"),
        )):
            if i > 0:
                lines.append("")
                lines.append("")
            lines.append(f"@router.{verb}({path})")
            lines.append(f"def {fn}() -> Any:")
            lines.append(f'    """GENERATED — {plural} is a read-only projection; writes are rejected."""')
            lines.append("    return JSONResponse(")
            lines.append("        status_code=405,")
            lines.append('        content={')
            lines.append('            "error": "method_not_allowed",')
            lines.append(f'            "message": "{verb.upper()} is not supported on a projection (read-only).",')
            lines.append("        },")
            lines.append("    )")
        return lines

    def _render_readonly_router(
        self,
        entity: MetaObject,
        column_naming: str = DEFAULT_COLUMN_NAMING,
    ) -> str:
        """Render a read-only (`@kind: view` / `materializedView`) object as a FastAPI
        ``APIRouter``: GET list + GET by id, and the four write verbs answering 405.

        Deliberately a separate assembly from the writable path rather than a pile of
        ``if writable`` branches through it. The writable router carries create/update
        DTO validation, the FR-035 tristate, @autoSet stamping, the FR-037 frozen-field
        strip and constraint-error classification — every one of which is meaningless
        here, and threading a flag through all of them is how the read-only surface
        would drift into carrying write machinery it can never run. The two paths share
        what they genuinely share (the list + get handlers, the sort helper, the filter
        allowlist wiring) by calling the same emitters."""
        short_name = entity.name
        snake = _snake_case(short_name)
        plural = _route_path(short_name)
        pk_param = f"{snake}_id"
        pk = _pk_py_type(entity)
        pk_type = pk.expr
        repo_class = f"{short_name}Repository"
        sort_field_nodes = list(_scalar_fields(entity))
        upper = short_name.upper()
        fields_const = f"{upper}_FILTER_FIELDS"
        ops_const = f"{upper}_FILTER_OPS_BY_FIELD"
        allowlist_module = f"{snake}_filter_allowlist"

        parts: list[str] = []
        parts.append(
            generated_header(short_name, _effective_fqn(entity)).rstrip() + "\n"
            + f'"""GENERATED — read-only REST router for the {short_name} projection.\n\n'
            + "Implements the cross-port API contract: GET list + GET by id; every write\n"
            + 'verb answers 405 {"error": "method_not_allowed"}."""\n'
        )
        parts.append("from __future__ import annotations")
        parts.append("")
        for import_line in sorted(pk.imports):
            parts.append(import_line)
        if pk.imports:
            parts.append("")
        parts.append("from typing import Annotated, Any, Protocol")
        parts.append("")
        parts.append("from fastapi import APIRouter, Depends, Query, Request")
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
        parts.extend(_sort_type_and_tables_lines(sort_field_nodes))
        parts.append("")
        parts.append("")
        parts.extend(_sort_parse_fn_lines())
        parts.append("")
        parts.append("")
        parts.append(f"class {repo_class}(Protocol):")
        parts.append('    """GENERATED — consumer implements with their preferred persistence layer.')
        parts.append("")
        parts.append("    Read-only: a projection is not writable, so the seam offers no")
        parts.append('    create / update / delete."""')
        parts.append("    def list(")
        parts.append("        self,")
        parts.append("        limit: int,")
        parts.append("        offset: int,")
        parts.append("        sort: _SortClause | None,")
        parts.append("        filters: list[FilterPredicate],")
        parts.append("    ) -> list[Any]: ...")
        parts.append("    def count(self, filters: list[FilterPredicate]) -> int: ...")
        parts.append(f"    def find_by_id(self, id: {pk_type}) -> Any | None: ...")
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
            # The projection has no create / patch validation model. The list + get
            # handlers do not read these; they are required by the shared signature.
            model_name="",
            patch_model="",
        )
        for i, hname in enumerate(("list", "get")):
            if i > 0:
                parts.append("")
                parts.append("")
            parts.extend(self._emit_route_handler(hname, **_handler_kwargs))
        parts.append("")
        parts.append("")
        parts.extend(self._emit_readonly_reject_handlers(snake, plural, pk_param))
        parts.append("")
        return "\n".join(parts)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        index = build_object_index(ctx.entities)

        def emit(entity: MetaObject, c: GenContext) -> list[EmittedFile]:
            # The run's column-naming strategy — same seam `names_generator.py`
            # reads (`c.config.column_naming`) — so the M:N descriptor built here
            # and the per-field constants built there can't disagree about a
            # column name within one run.
            source = self.render_router(entity, index, c.config.column_naming)
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
    entity: MetaObject,
    object_index: dict[str, MetaObject] | None = None,
    column_naming: str = DEFAULT_COLUMN_NAMING,
) -> str | None:
    """Module-level back-compat wrapper. Delegates to a default
    :class:`RouterGenerator` instance so existing callers (and tests) are
    unaffected. Subclass :class:`RouterGenerator` to customize."""
    return RouterGenerator().render_router(entity, object_index, column_naming)


def router_generator() -> Generator:
    """Generator factory: one ``<entity_snake>_router.py`` per routed object —
    full CRUD for a writable source, read-only for a view-backed one.

    Returns a :class:`RouterGenerator` (subclassable extension seam). Skips objects
    without a ``source.rdb`` child and the non-collection read-only kinds
    (storedProc / tableFunction)."""
    return RouterGenerator()
