"""object.* → Pydantic v2 model module (sub-project A)."""
from __future__ import annotations

import re

from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import (
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_VALUE,
)
from metaobjects.meta.core.field import field_constants as fc
# FR-037 R1 — THE mutability accessors. Every consumer deciding "may this be
# written, and when?" goes through these, so the absent-means-readWrite default
# lives in exactly one place per port.
from metaobjects.loader.validate_field_mutability import (
    is_read_only_mutability,
    is_write_once_mutability,
)
from metaobjects.meta.core.identity.identity_constants import (
    GENERATION_INCREMENT,
    GENERATION_UUID,
    IDENTITY_ATTR_FIELDS,
    IDENTITY_ATTR_GENERATION,
)
from metaobjects.meta.core.validator import validator_constants as vc
from metaobjects.meta.persistence.origin.origin_constants import (
    AGG_ALL,
    AGG_ANY,
    AGG_COLLECT,
    ORIGIN_ATTR_AGG,
    ORIGIN_SUBTYPE_AGGREGATE,
)
from metaobjects.shared.base_types import TYPE_ORIGIN, TYPE_VALIDATOR
from metaobjects.shared.separators import PACKAGE_SEP
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.type_map import field_is_array, py_type_for
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator, per_entity
from metaobjects.codegen.generators import fr019_shared_enum as fr019
from metaobjects.codegen.generators.m2m_codegen import (
    build_object_index,
    resolve_m2m_descriptors,
)
from metaobjects.codegen.generators.tph_plan import tph_subtype_binding


def _is_int(value: object) -> bool:
    """A real int (bool is an int subclass, so `@maxLength: true` etc. must not count)."""
    return isinstance(value, int) and not isinstance(value, bool)


# SQL expression defaults: anything matching is a SERVER-side default (the DB fills
# it), NOT a Python literal default — so `@default: gen_random_uuid()` must not emit
# `id: uuid.UUID = "gen_random_uuid()"`. Mirrors the TS column-mapper's
# SQL_EXPR_PATTERNS (and migrate-ts EXPR_DEFAULT_PATTERNS) so every port agrees on
# what counts as an expression.
_SQL_EXPR_DEFAULT_PATTERNS = (
    re.compile(r"^now$", re.I),
    re.compile(r"^now\(\)$", re.I),
    re.compile(r"^current_timestamp$", re.I),
    re.compile(r"^current_date$", re.I),
    re.compile(r"^current_time$", re.I),
    re.compile(r"\(\)$"),  # anything function-like, e.g. gen_random_uuid()
)


def _is_sql_expr_default(value: object) -> bool:
    """True iff *value* is a server-side SQL expression default (DB-filled), not a
    Python literal. Only string defaults can be expressions."""
    return isinstance(value, str) and any(p.search(value) for p in _SQL_EXPR_DEFAULT_PATTERNS)


# ADR-0036/0037 Wave 3 — the CANONICAL hostname matcher for @stringFormat: hostname.
# The matcher lives in codegen (NOT author validator.regex) so every port replicates
# the SAME canonical form — cross-language regex engines diverge, so this one
# expression is the byte-identical source of truth. RFC 1123 labels: 1–63 chars each,
# alphanumeric + internal hyphens, dot-separated; total length 1–253; anchored.
# Byte-identical to the TS zod-validators HOSTNAME_REGEX_LITERAL body.
_HOSTNAME_REGEX = (
    r"^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)"
    r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)


def _validators(field: MetaField, sub_type: str) -> list[MetaField]:
    """The field's own ``validator.<sub_type>`` children (effective, supers included)."""
    return [
        c
        for c in field.children()
        if c.type == TYPE_VALIDATOR and c.sub_type == sub_type
    ]


def _first_attr(field: MetaField, sub_type: str, attr_name: str) -> object | None:
    """First int-valued *attr_name* across the field's ``validator.<sub_type>`` children."""
    for v in _validators(field, sub_type):
        # ADR-0039 sanctioned own: a validator's @min/@max are its own declared
        # bounds (never inherited across a validator extends chain) — matches the TS
        # MetaValidator.min/.max ownAttr reads. The validator nodes are located via
        # the resolving field.children() in _validators().
        val = v.attr(attr_name)
        if _is_int(val):
            return val
    return None


def _validator_constraints(field: MetaField, *, wire: bool) -> dict[str, object]:
    """Map the field's ``validator.*`` children + field attrs to Pydantic ``Field``
    kwargs. Cross-port-canonical semantics (TS is the reference):

    - ``validator.regex @pattern`` -> ``pattern=``
    - ``validator.numeric @min/@max`` -> ``ge=``/``le=`` (numeric value bounds)
    - ``validator.length @min`` + field ``@maxLength`` -> ``min_length=``/``max_length=``
    - ``validator.array @min/@max`` -> list ``min_length=``/``max_length=`` (element count)

    *wire* gates FR-036 Pin 1 (#224): Pin 1 is a WIRE-TIER rule (it governs the
    generated Create/Patch input-validation models a router binds against), never
    an in-process one — an ``object.entity``/``object.value`` READ model applies
    every OTHER constraint above unconditionally but must not self-validate Pin 1
    at construction (that broke a downstream adopter's in-process prompt-payload
    ``object.value`` models on legitimately-empty slots). Callers building a read
    model (``_field_line``) pass ``wire=False``; callers building a wire model
    (``_create_field_line``/``_patch_field_line``) pass ``wire=True``.

    *wire* is keyword-only and REQUIRED (no default, item 5 of the #224
    cleanup): a forgotten flag at a future wire call site must fail loudly
    (``TypeError``) at generation time rather than silently falling back to a
    permissive read-model tier.
    """
    kwargs: dict[str, object] = {}

    # String length: validator.length @min/@max + field @maxLength (max wins per field attr).
    min_len = _first_attr(field, vc.VALIDATOR_SUBTYPE_LENGTH, vc.VALIDATOR_ATTR_MIN)
    max_len = _first_attr(field, vc.VALIDATOR_SUBTYPE_LENGTH, vc.VALIDATOR_ATTR_MAX)
    field_max = field.attrs().get(fc.FIELD_ATTR_MAX_LENGTH)
    if _is_int(field_max):
        # FR-036 A3 — strictest-wins: when BOTH a validator.length @max and a field
        # @maxLength cap a string, the smaller bound governs (never the field attr
        # unconditionally, which could loosen a tighter validator).
        max_len = field_max if max_len is None else min(max_len, field_max)
    if min_len is not None:
        kwargs["min_length"] = min_len
    if max_len is not None:
        kwargs["max_length"] = max_len

    # Array element count: validator.array @min/@max -> list min_length/max_length.
    arr_min = _first_attr(field, vc.VALIDATOR_SUBTYPE_ARRAY, vc.VALIDATOR_ATTR_MIN)
    arr_max = _first_attr(field, vc.VALIDATOR_SUBTYPE_ARRAY, vc.VALIDATOR_ATTR_MAX)
    if arr_min is not None:
        kwargs["min_length"] = arr_min
    if arr_max is not None:
        kwargs["max_length"] = arr_max

    # Numeric value bounds: validator.numeric @min/@max -> ge/le.
    num_min = _first_attr(field, vc.VALIDATOR_SUBTYPE_NUMERIC, vc.VALIDATOR_ATTR_MIN)
    num_max = _first_attr(field, vc.VALIDATOR_SUBTYPE_NUMERIC, vc.VALIDATOR_ATTR_MAX)
    if num_min is not None:
        kwargs["ge"] = num_min
    if num_max is not None:
        kwargs["le"] = num_max

    # Regex: validator.regex @pattern -> pattern.
    for v in _validators(field, vc.VALIDATOR_SUBTYPE_REGEX):
        # ADR-0039 sanctioned own: a validator's @pattern is its own declared value
        # (matches the TS MetaValidator.pattern ownAttr read); the validator node is
        # located via the resolving field.children() in _validators().
        pattern = v.attr(vc.VALIDATOR_ATTR_PATTERN)
        if isinstance(pattern, str):
            # FR-036 Pin 2 — a validator.regex is a FULL match. Pydantic v2 `pattern=`
            # is search/partial (un-anchored), so wrap the authored expression in an
            # anchored non-capturing group so alternation still spans the whole value
            # (a redundant anchor on an already-anchored pattern matches identically).
            kwargs["pattern"] = f"^(?:{pattern})$"
            break

    # ADR-0036/0037 Wave 3 — @stringFormat: hostname -> a codegen-owned canonical
    # hostname pattern= (the matcher lives HERE, never author validator.regex, so
    # every port replicates the byte-identical form). @stringFormat: email is bound
    # as EmailStr in _field_line (a type, not a pattern), so it is not handled here.
    if field.attrs().get(fc.FIELD_ATTR_STRING_FORMAT) == fc.STRING_FORMAT_HOSTNAME:
        kwargs["pattern"] = _HOSTNAME_REGEX

    # FR-036 Pin 1 (#224 — WIRE TIER ONLY) — a @required non-array string is
    # non-empty by default: reject null / "" but ACCEPT whitespace-only. Emit an
    # implicit min_length of 1 ONLY when no validator.length @min was authored.
    # Never applied to the in-process read model (wire=False).
    #
    # An explicitly authored @min is always AUTHORITATIVE over the implicit floor
    # (ADR-0044 ruling on #224) — @min: 0 restores "must be provided, may be
    # empty" by opting out of the non-empty floor entirely. Per the cross-port
    # emission pin, an authored @min: 0 emits NO minimum constraint at all
    # (cleanest, deterministic output across ports), so it is popped rather than
    # kept as min_length=0.
    if (
        wire
        and field.sub_type == fc.FIELD_SUBTYPE_STRING
        and not field_is_array(field)
        and field.attrs().get(fc.FIELD_ATTR_REQUIRED) is True
    ):
        if min_len is None:
            kwargs["min_length"] = 1
        elif min_len == 0:
            kwargs.pop("min_length", None)

    return kwargs


# Constraint kwargs are emitted in this fixed order so generated output is deterministic.
_CONSTRAINT_ORDER = ("pattern", "ge", "le", "min_length", "max_length")


def _constraint_parts(constraints: dict[str, object]) -> list[str]:
    """The ``Field(...)`` constraint kwargs rendered in the stable, deterministic order."""
    return [f"{k}={constraints[k]!r}" for k in _CONSTRAINT_ORDER if k in constraints]


def _type_expr_for_field(
    field: MetaField, imports: set[str], config: GenConfig, *, wire: bool
) -> tuple[str, str | None]:
    """The Python annotation text for *field* (arrays wrapped in ``list[...]``) plus the
    shared-enum class name when the field resolves to one (used to render an enum
    default). Collects any required imports into *imports*. Shared by the create-model
    and patch-model emitters so both carry byte-identical typing.

    FR-019: a field resolving to a package-level shared enum is typed by the materialized
    standalone class (imported from the shared ``enums`` module) or — when @provided — an
    external module; inline enums keep their ``Literal[...]`` (py_type_for).

    *wire* (#224): in a wire context (create/patch), a ``field.object``/``field.map``
    ``@objectRef`` annotates with the referenced VO's own WIRE model (``<Ref>Create``)
    rather than its read model, so a required-string Pin 1 violation nested inside the
    VO still validates on the wire (api-contract jsonb r10). A VO's own Create lines
    are emitted through this same wire path, so nested-VO-in-VO recurses naturally.

    *wire* is keyword-only and REQUIRED (no default, item 5 of the #224 cleanup)
    — see ``_validator_constraints`` for the rationale."""
    shared = (
        fr019.shared_enum_for_field(field)
        if field.sub_type == fc.FIELD_SUBTYPE_ENUM
        else None
    )
    enum_type_name: str | None = None
    if shared is not None:
        type_name, import_line = fr019.enum_type_and_import(shared, config)
        imports.add(import_line)
        enum_type_name = type_name
        type_expr = f"list[{type_name}]" if field_is_array(field) else type_name
    else:
        pt = py_type_for(field)
        imports.update(pt.imports)
        type_expr = pt.expr
    # ADR-0036/0037 Wave 3 — @stringFormat: email narrows a plain string to a validated
    # email (Pydantic EmailStr, the Python analogue of Zod .email()); hostname stays a
    # plain str with a codegen-owned canonical pattern= (in _validator_constraints).
    if (
        field.sub_type == fc.FIELD_SUBTYPE_STRING
        and field.attrs().get(fc.FIELD_ATTR_STRING_FORMAT) == fc.STRING_FORMAT_EMAIL
    ):
        imports.add("from pydantic import EmailStr")
        type_expr = "list[EmailStr]" if field_is_array(field) else "EmailStr"
    if field.sub_type in (fc.FIELD_SUBTYPE_OBJECT, fc.FIELD_SUBTYPE_MAP):
        # A field.object (-> VO) and a field.map with @objectRef (-> dict[str, VO]) both
        # reference a value-object by name; import it so the emitted annotation resolves.
        # @objectRef is FQN-expanded at load; the generated VOs live flat in one package,
        # so import by the bare class name. #224 — a WIRE context binds the referenced
        # VO's <Ref>Create instead (see docstring above).
        ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
        if ref:
            ref_name = str(ref).split("::")[-1]
            bound_name = f"{ref_name}Create" if wire else ref_name
            imports.add(f"from .{ref_name} import {bound_name}")
            if wire:
                if field.sub_type == fc.FIELD_SUBTYPE_MAP:
                    type_expr = f"dict[str, {bound_name}]"
                elif field_is_array(field):
                    type_expr = f"list[{bound_name}]"
                else:
                    type_expr = bound_name
    return type_expr, enum_type_name


def origin_guaranteed_non_null(field: MetaField) -> bool:
    """#195 — a field derived by an origin.aggregate ``@agg:any|all|collect`` is
    COALESCE-guaranteed non-null in the synthesized view (any→false, all→true,
    collect→[]), so its read type is non-null even when the field is not ``@required``.
    origin.first is deliberately NOT here — an empty related set selects no row (→ null);
    origin.computed nullability is expression-dependent, so it stays the conservative
    nullable default. Mirrors the TS originGuaranteedNonNull."""
    # ADR-0039 sanctioned own — origin.* never inherits (ADR-0029), so own is correct.
    for child in field.own_children():
        if child.type == TYPE_ORIGIN and child.sub_type == ORIGIN_SUBTYPE_AGGREGATE:
            agg = child.attr(ORIGIN_ATTR_AGG)  # ADR-0039 own — origin attr
            if agg in (AGG_ANY, AGG_ALL, AGG_COLLECT):
                return True
    return False


def _field_line(field: MetaField, imports: set[str], config: GenConfig) -> tuple[str, bool]:
    """Return (source line, uses_field). Collects required imports into *imports*."""
    type_expr, enum_type_name = _type_expr_for_field(field, imports, config, wire=False)
    required = field.attrs().get(fc.FIELD_ATTR_REQUIRED) is True
    default_raw = field.attrs().get(fc.FIELD_ATTR_DEFAULT)
    # A server-side expression default (now(), gen_random_uuid(), CURRENT_TIMESTAMP)
    # is filled by the DB — the Python model carries no default for it (the field keeps
    # its required/optional shape). Only literal defaults become Pydantic defaults.
    has_default = default_raw is not None and not _is_sql_expr_default(default_raw)

    parts = _constraint_parts(_validator_constraints(field, wire=False))
    uses_field = bool(parts)

    # @default — render an enum member (Type.MEMBER, UPPER_CASE) or a Python literal.
    if has_default:
        if enum_type_name is not None and not field_is_array(field):
            default_expr = f"{enum_type_name}.{str(default_raw).upper()}"
        else:
            default_expr = repr(default_raw)
    else:
        default_expr = None

    # #195 — a field derived by an origin.aggregate any|all|collect always COALESCEs
    # to a value (any→false, all→true, collect→[]), so its read type is mandatory
    # non-null exactly like a @required field (no `| None`, no default). origin.first /
    # origin.computed stay the conservative nullable default.
    mandatory = required or origin_guaranteed_non_null(field)
    # A field is Optional only when it is neither mandatory nor carries a @default.
    annotation = type_expr if (mandatory or has_default) else f"{type_expr} | None"
    if has_default and uses_field:
        assignment = f" = Field(default={default_expr}, {', '.join(parts)})"
    elif has_default:
        assignment = f" = {default_expr}"
    elif mandatory and uses_field:
        assignment = f" = Field({', '.join(parts)})"
    elif mandatory:
        assignment = ""
    elif uses_field:
        assignment = f" = Field(default=None, {', '.join(parts)})"
    else:
        assignment = " = None"

    # Pydantic field name = field.name, ALWAYS. `@column` is the physical column name,
    # a different axis: it is what the persistence layer binds to, never what the model
    # calls the field. Every other surface in this port already keyed by field.name —
    # the FR-036 create/patch models, the generated router, and the runtime, whose
    # ObjectManager maps {_column_of(f): f.name} on every read and RETURNING clause
    # "for cross-port row-shape parity" — so keying the read model by @column made one
    # generated module disagree with itself, and its stated reason (that the model field
    # binds straight to the row) was never true.
    #
    # Idiomatic snake_case for a Python consumer is a real goal and this is not the
    # lever for it: `columnNamingStrategy` applied to field.name is, because @column is
    # free-form — `callPurpose` + `@column: purpose_code` used to emit a field
    # `purpose_code`, which is neither the wire name nor derived from the field name.
    return f"    {field.name}: {annotation}{assignment}", uses_field


def _primary_identity_field_names(entity: MetaObject) -> list[str]:
    """The field names in the entity's primary identity (``identity.primary @fields``),
    normalized to a list. Empty when there is no primary identity. Mirrors the TS
    ``primaryIdentityFieldNames``."""
    primary = entity.primary_identity()
    if primary is None:
        return []
    # ADR-0039: resolving (identity attr) — an identity.primary may be inherited via extends.
    fields = primary.get_meta_attr(IDENTITY_ATTR_FIELDS)
    if isinstance(fields, (list, tuple)):
        return [str(f) for f in fields]
    if isinstance(fields, str) and fields:
        return [s.strip() for s in fields.split(",") if s.strip()]
    return []


def _auto_gen_pk_field_names(entity: MetaObject) -> set[str]:
    """Primary-key field names that the SERVER generates (``identity.primary
    @generation: increment|uuid``) — excluded from the create-validation shape because
    the caller never supplies them. An ``assigned`` (or ungenerated) PK is NOT excluded
    (the caller provides it). Mirrors the TS ``autoGenPkFieldNames``."""
    primary = entity.primary_identity()
    if primary is None:
        return set()
    # ADR-0039: resolving (identity attr).
    generation = primary.get_meta_attr(IDENTITY_ATTR_GENERATION)
    if generation not in (GENERATION_INCREMENT, GENERATION_UUID):
        return set()
    return set(_primary_identity_field_names(entity))


def _assigned_pk_field_names(entity: MetaObject) -> set[str]:
    """Primary-key field names the CALLER must supply on create: an ASSIGNED primary key
    — a natural key or an externally-issued id, i.e. an ``identity.primary`` carrying no
    ``@generation`` (or an explicit ``assigned``).

    These are create-REQUIRED regardless of ``@required``: nothing else can produce the
    value, so a create body omitting one can only fail at the database. Excludes the
    ``increment|uuid`` keys, which ``_auto_gen_pk_field_names`` already drops from the
    create shape entirely. A PK carrying a ``@default`` stays optional (the column has
    that default) — handled at the call site, which knows the field.

    Mirrors the TS ``assignedPkFieldNames``; gated cross-port by the
    ``assigned-pk-missing`` case in ``fixtures/validation-conformance``."""
    auto_gen = _auto_gen_pk_field_names(entity)
    return {n for n in _primary_identity_field_names(entity) if n not in auto_gen}


def _create_field_line(
    field: MetaField, imports: set[str], config: GenConfig, *, force_required: bool = False
) -> tuple[str, bool]:
    """A CREATE-model field line (FR-036): keyed by the WIRE name (``field.name``) and
    carrying the WIRE-TIER per-field constraints (#224 — includes FR-036 Pin 1
    non-empty-string; the read model does NOT carry Pin 1). A ``@required`` field
    that is SERVER-FILLED — it has ANY ``@default`` (a literal OR a SQL expression such
    as ``now()`` / ``gen_random_uuid()`` / ``CURRENT_TIMESTAMP``) or an ``@autoSet`` — is
    emitted OPTIONAL, because the DB / trigger provides it and a POST that omits it must
    not 400 (mirrors the TS InsertSchema ``fieldWillBeOptional``). A literal ``@default``
    is preserved as the Python default; a SQL-expression default / ``@autoSet`` carries
    no Python default (the server fills it). Also used, unchanged, to emit an
    ``object.value``'s own ``<Name>Create`` wire model (#224) — the PK/TPH/derived-field
    guards in the caller no-op for a VO carrying none of those. Returns (source line,
    uses_field)."""
    type_expr, enum_type_name = _type_expr_for_field(field, imports, config, wire=True)
    required = field.attrs().get(fc.FIELD_ATTR_REQUIRED) is True
    default_raw = field.attrs().get(fc.FIELD_ATTR_DEFAULT)
    literal_default = default_raw is not None and not _is_sql_expr_default(default_raw)
    auto_set = field.attrs().get(fc.FIELD_ATTR_AUTO_SET)
    is_auto_set = auto_set in (fc.AUTO_SET_ON_CREATE, fc.AUTO_SET_ON_UPDATE)
    # A field is required in the CREATE shape only when @required AND not server-filled:
    # ANY @default (literal or SQL-expr) or @autoSet means the DB fills it, so the wire
    # body may omit it (the FR-036 #1 regression fix).
    server_filled = default_raw is not None or is_auto_set
    # An assigned PK is create-REQUIRED whatever @required says (see
    # _assigned_pk_field_names) — unless it is server-filled by a @default.
    create_required = (required or force_required) and not server_filled

    parts = _constraint_parts(_validator_constraints(field, wire=True))
    uses_field = bool(parts)

    py_name = field.name  # FR-036 #3 — validation models key by the WIRE name (field.name)

    if literal_default:
        # Preserve the literal @default (enum member or Python literal) exactly as the
        # read model does — the caller may omit the field and the model fills the default.
        if enum_type_name is not None and not field_is_array(field):
            default_expr = f"{enum_type_name}.{str(default_raw).upper()}"
        else:
            default_expr = repr(default_raw)
        annotation = type_expr
        assignment = (
            f" = Field(default={default_expr}, {', '.join(parts)})"
            if uses_field
            else f" = {default_expr}"
        )
    elif create_required:
        annotation = type_expr
        assignment = f" = Field({', '.join(parts)})" if uses_field else ""
    else:
        annotation = f"{type_expr} | None"
        assignment = (
            f" = Field(default=None, {', '.join(parts)})" if uses_field else " = None"
        )

    return f"    {py_name}: {annotation}{assignment}", uses_field


def _patch_field_line(
    field: MetaField, imports: set[str], config: GenConfig
) -> tuple[str, bool]:
    """A PATCH-model field line: the field is made Optional (default ``None``) yet
    carries the SAME wire-tier per-field constraints as the create model (#224), so a
    present, non-null value is validated with the create rules (FR-036) while an
    absent field is left untouched. A ``@default`` is never emitted (a patch does not
    default a column). Returns (source line, uses_field)."""
    type_expr, _enum = _type_expr_for_field(field, imports, config, wire=True)
    parts = _constraint_parts(_validator_constraints(field, wire=True))
    py_name = field.name  # FR-036 #3 — validation models key by the WIRE name (field.name)
    if parts:
        return f"    {py_name}: {type_expr} | None = Field(default=None, {', '.join(parts)})", True
    return f"    {py_name}: {type_expr} | None = None", False


def _effective_fqn(entity: MetaObject) -> str:
    """`package::name` via the canonical :meth:`MetaData.resolution_key` — own
    package, else the file-default package (captured at parse), else the nearest
    ancestor's. The ``file_default_package`` step is load-bearing after a multi-file
    merge: every node hangs under one package-less merged root, so the ancestor walk
    alone would fold each object onto the alphabetically-first file's package."""
    return entity.resolution_key()


class EntityModelGenerator:
    """``object.*`` → a Pydantic v2 model module per object.

    EXTENSION SEAM (open-for-extension). Adopters subclass this and override one of
    the protected ``_emit_*`` hooks (or ``render_entity_model``) to customize the
    emitted model without forking the generator. The factory ``entity_model()`` and
    the module-level ``render_entity_model()`` both delegate to a default instance,
    so subclassing changes nothing for the default suite (output stays byte-identical).

    Override points (in emission order):

    * ``_emit_class_header(entity, base_class)`` — the ``class <Name>(<Base>):`` line.
    * ``_emit_field_lines(entity, imports)`` — the body field lines (scalars + M:N
      collections); collect any extra imports into the ``imports`` set.
    * ``render_entity_model(entity, object_index)`` — the whole module (last resort).
    """

    name = "entity-model"

    def _emit_class_header(self, entity: MetaObject, base_class: str) -> str:
        """The ``class <Name>(<Base>):`` declaration line. Override to inject a
        decorator, a metaclass, or an alternate base."""
        return f"class {entity.name}({base_class}):"

    def _emit_field_lines(
        self,
        entity: MetaObject,
        imports: set[str],
        object_index: dict[str, MetaObject] | None,
        config: GenConfig | None = None,
    ) -> tuple[list[str], bool]:
        """The model body: one line per own field, then M:N nested collections when
        *object_index* is supplied. Returns ``(lines, uses_field)`` where
        ``uses_field`` is True iff any line used a pydantic ``Field(...)`` (so the
        caller knows to import ``Field``). Required imports are collected into
        *imports*. *config* carries the FR-019 @provided-enum resolution AND the
        column-naming strategy the M:N descriptor below is resolved with — the same
        ``GenConfig`` the ``names`` generator reads, so the two can't disagree about a
        column name within one run. Override to add/transform body lines."""
        cfg = config if config is not None else GenConfig(out_dir="")
        uses_field = False
        lines: list[str] = []
        # ADR-0039 SANCTIONED OWN — codegen subclass-emit: the generated model
        # `extends` its generated base, so only OWN fields are emitted here (the base
        # class already declares inherited ones). Pinned by test_entity_model.py.
        for f in entity.own_fields():
            line, used = _field_line(f, imports, cfg)
            uses_field = uses_field or used
            lines.append(line)

        # M:N nested collections (FR-018). Element type is the target entity; a
        # self-join element type is a forward-ref string so the model can name itself.
        # Nothing here reads the descriptor's physical-name fields (only
        # `.target_entity` / `.relation_name`), but `cfg.column_naming` is already in
        # scope, so there is no reason for this call to resolve them under a
        # different strategy than the rest of the run.
        if object_index is not None:
            for d in resolve_m2m_descriptors(entity, object_index, cfg.column_naming):
                if d.target_entity == entity.name:
                    element = f'"{entity.name}"'
                else:
                    element = d.target_entity
                    imports.add(f"from .{d.target_entity} import {d.target_entity}")
                lines.append(f"    {d.relation_name}: list[{element}] = []")
        return lines, uses_field

    def _emit_create_lines(
        self,
        entity: MetaObject,
        imports: set[str],
        config: GenConfig | None = None,
    ) -> tuple[list[str], bool]:
        """The ``<Name>Create`` body — the CREATE-validation shape the generated router
        validates a POST body against (FR-036). Restates every EFFECTIVE field (own +
        inherited via ``extends``) EXCEPT the ones the server owns: an auto-generated PK
        (``identity.primary @generation``; FR-036 #2) and any ``@readOnly`` field
        (FR-013) are omitted, and a ``@required`` server-filled field (``@default`` /
        ``@autoSet``; FR-036 #1) is made optional. Keyed by the wire name; a TPH
        subtype's discriminator is pinned to its ``Literal`` value (the route injects it
        from the URL, so it stays optional with a default). M:N navigations are omitted
        (a create body targets columns, not relations). Also used, unchanged, to emit an
        ``object.value``'s own wire model (#224) — a VO has no PK/TPH/derived fields, so
        those guards simply no-op. Returns ``(lines, uses_field)``. Override to
        add/transform create-model lines."""
        cfg = config if config is not None else GenConfig(out_dir="")
        auto_gen_pk = _auto_gen_pk_field_names(entity)
        assigned_pk = _assigned_pk_field_names(entity)
        binding = tph_subtype_binding(entity)
        disc_field = binding[0] if binding is not None else None
        uses_field = False
        lines: list[str] = []
        # RESOLVING (fields()): the flat Create model subclasses BaseModel (not the entity
        # base), so it restates inherited fields too — unlike the read model's own_fields
        # subclass-emit.
        for f in entity.fields():
            if disc_field is not None and f.name == disc_field:
                continue  # pinned below (prepended), never as a normal field line
            if f.name in auto_gen_pk:
                continue  # FR-036 #2 — a server-generated PK is never in the create body
            if is_read_only_mutability(f):
                continue  # FR-037 R1 — readOnly is DB/owner-written, not create input.
                # writeOnce is deliberately NOT skipped: settable exactly once is the mode.
            if f.is_derived():
                continue  # FR-024 §7 (#214) — a derived (origin.*) field is view-computed, not create input
            line, used = _create_field_line(
                f, imports, cfg, force_required=f.name in assigned_pk
            )
            uses_field = uses_field or used
            lines.append(line)
        # FR-017 TPH: pin the inherited discriminator to this subtype's value (with a
        # default so the URL-injected create body may omit it) — mirrors the read model.
        if binding is not None:
            disc_name, disc_value = binding
            lines = [f'    {disc_name}: Literal["{disc_value}"] = "{disc_value}"', *lines]
            imports.add("from typing import Literal")
        return lines, uses_field

    def _emit_patch_lines(
        self,
        entity: MetaObject,
        imports: set[str],
        config: GenConfig | None = None,
    ) -> tuple[list[str], bool]:
        """The ``<Name>Patch`` body: every EFFECTIVE field (own + inherited via
        ``extends``) made Optional while retaining its create-model constraints, so the
        generated PATCH handler can validate present, non-null values without
        bean-validating absent ones (FR-036). The primary-key field(s) are excluded
        (route-authoritative; FR-036 #4) and M:N navigations are omitted (a patch
        targets columns, not relations). Returns ``(lines, uses_field)``. Override to
        add/transform patch-model lines."""
        cfg = config if config is not None else GenConfig(out_dir="")
        pk_fields = set(_primary_identity_field_names(entity))
        uses_field = False
        lines: list[str] = []
        # RESOLVING (fields()): the flat Patch model is self-contained (subclasses
        # BaseModel, not the entity base), so it restates inherited fields too.
        for f in entity.fields():
            if f.name in pk_fields:
                continue  # FR-036 #4 — the PK is route-authoritative, never patched
            if f.is_derived():
                continue  # FR-024 §7 (#214) — a derived (origin.*) field is view-computed, never patched
            if is_read_only_mutability(f) or is_write_once_mutability(f):
                # FR-037 R1 — both non-readWrite modes leave the PATCH shape: readOnly is
                # never written at all, writeOnce is frozen after create. Omitted rather
                # than rejected, matching the TS reference (a key absent from the settable
                # set is STRIPPED on this path) — and clearing counts as a write, so the
                # FR-035 present-null arm never reaches them either.
                continue
            line, used = _patch_field_line(f, imports, cfg)
            uses_field = uses_field or used
            lines.append(line)
        return lines, uses_field

    def render_entity_model(
        self,
        entity: MetaObject,
        object_index: dict[str, MetaObject] | None = None,
        config: GenConfig | None = None,
    ) -> str:
        """Render an entity as a Pydantic v2 model (pre-format; the generator runs ruff).

        When *object_index* is supplied, M:N navigations (``relationship.*``
        ``@cardinality:"many" + @through``) are emitted as nested Pydantic
        collections (``tags: list[Tag] = []``); a self-join uses a forward-ref string
        (``following: list["Person"] = []``). Without an index, only scalar/object
        fields are emitted (back-compat). *config* carries the FR-019 @provided-enum
        resolution; when omitted, only the non-provided shared-materialize path is reachable."""
        imports: set[str] = set()
        base_class = "BaseModel"
        if entity.super_data is not None:
            base_class = entity.super_data.name
            imports.add(f"from .{base_class} import {base_class}")

        lines, uses_field = self._emit_field_lines(entity, imports, object_index, config)

        # FR-017 TPH: a concrete subtype pins the inherited discriminator field to its
        # own value (Literal) so the Pydantic model rejects a foreign-subtype tag —
        # the type-layer parity with the TS `z.literal` / C# discriminator pin. (Python's
        # runtime is dict-based, so the base's discriminated-UNION alias is intentionally
        # deferred: it isn't consumed by the generated routes/ObjectManager and would
        # force a base↔subtype circular import for an unused artifact.)
        binding = tph_subtype_binding(entity)
        if binding is not None:
            disc_field, disc_value = binding
            lines = [
                f'    {disc_field}: Literal["{disc_value}"] = "{disc_value}"',
                *lines,
            ]
            imports.add("from typing import Literal")
        body = lines if lines else ["    pass"]

        # FR-036 — an object.entity emits two flat WIRE-validation models the generated
        # router binds: a ``<Name>Create`` (POST-body shape: auto-gen PK / @readOnly
        # omitted, @default/@autoSet optional, other @required required) and an
        # all-optional ``<Name>Patch`` (PATCH-body shape: PK excluded). Both key by the
        # WIRE name and carry the wire-tier field constraints (#224 — includes FR-036
        # Pin 1), so present values are validated with the create rules.
        #
        # #224 — an object.value is reached OVER THE WIRE too: it nests into an entity's
        # Create/Patch body via a field.object/field.map ``@objectRef`` (see
        # ``_type_expr_for_field``'s wire mode), so it also emits its own ``<Name>Create``
        # wire model — Create only, since a nested VO is whole-value replace on both POST
        # and PATCH (the same reason TS embeds one ``<Ref>InsertSchema`` in both Insert
        # and Update schemas; no separate VO ``Patch`` shape exists). A ``<Name>Patch`` is
        # entity-only (PK exclusion + partial-update semantics are entity-specific).
        # object.projection is read-only and never routed — it emits neither.
        emit_create = entity.sub_type in (OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_VALUE)
        emit_patch = entity.sub_type == OBJECT_SUBTYPE_ENTITY
        create_lines: list[str] = []
        create_uses_field = False
        patch_lines: list[str] = []
        patch_uses_field = False
        if emit_create:
            create_lines, create_uses_field = self._emit_create_lines(entity, imports, config)
        if emit_patch:
            patch_lines, patch_uses_field = self._emit_patch_lines(entity, imports, config)

        # Import only the pydantic names actually referenced. The main model imports
        # BaseModel only when it has no super, but the flat Create/Patch models always
        # subclass BaseModel, so their presence forces the import regardless.
        pyd_names: list[str] = []
        if entity.super_data is None or emit_create or emit_patch:
            pyd_names.append("BaseModel")
        if uses_field or create_uses_field or patch_uses_field:
            pyd_names.append("Field")

        parts: list[str] = [
            generated_header(entity.name, _effective_fqn(entity)),
            "from __future__ import annotations",
            "",
        ]
        extra_imports = sorted(imports)
        if extra_imports:
            parts += [*extra_imports, ""]
        if pyd_names:
            parts += [f"from pydantic import {', '.join(pyd_names)}", ""]
        parts += ["", self._emit_class_header(entity, base_class), *body]
        if emit_create:
            parts += [
                "",
                "",
                f"class {entity.name}Create(BaseModel):",
                '    """GENERATED — CREATE input: auto-gen PK / @mutability readOnly omitted '
                '(writeOnce is settable here, once); @default/@autoSet optional; present '
                'values validated (FR-036)."""',
                *create_lines,
            ]
        if emit_patch:
            parts += [
                "",
                "",
                f"class {entity.name}Patch(BaseModel):",
                '    """GENERATED — PATCH input: all fields optional (PK, @mutability '
                'readOnly and writeOnce excluded); present values validated (FR-036)."""',
                *patch_lines,
            ]
        parts += [""]
        return "\n".join(parts)

    def _render_shared_enums_module(self, entities: list[MetaObject]) -> EmittedFile | None:
        """FR-019: the shared ``enums.py`` module — one module-level
        ``class <Name>(str, Enum)`` per materialized (package-level abstract, non-``@provided``,
        consumed) enum. ``None`` when the model has no materialized shared enum, so the inline
        default output is byte-identical (no spurious empty module)."""
        shared = fr019.materialized_shared_enums(entities)
        if not shared:
            return None
        parts: list[str] = [
            generated_header("enums", "enums"),
            "from __future__ import annotations",
            "",
            "from enum import Enum",
            "",
        ]
        for e in shared:
            parts += ["", f"class {e.name}(str, Enum):"]
            # Member names follow the Python convention (UPPER_CASE constants); the
            # value preserves the wire form, so ``Enum("statistical")`` and
            # ``member == "statistical"`` still work (str-enum).
            parts += [f'    {m.upper()} = "{m}"' for m in e.values]
        parts.append("")
        return EmittedFile(path="enums.py", content=ruff_format("\n".join(parts)))

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        index = build_object_index(ctx.entities)
        files = per_entity(
            lambda e, _c: EmittedFile(
                path=f"{e.name}.py",
                content=ruff_format(self.render_entity_model(e, index, ctx.config)),
            )
        )(ctx)
        matched = [e for e in ctx.entities if ctx.matches(e)]
        enums_module = self._render_shared_enums_module(matched)
        if enums_module is not None:
            files.append(enums_module)
        return files


def render_entity_model(
    entity: MetaObject,
    object_index: dict[str, MetaObject] | None = None,
    config: GenConfig | None = None,
) -> str:
    """Module-level back-compat wrapper. Delegates to a default
    :class:`EntityModelGenerator` instance so existing callers (and the golden
    tests) are unaffected. Subclass :class:`EntityModelGenerator` to customize."""
    return EntityModelGenerator().render_entity_model(entity, object_index, config)


def entity_model() -> Generator:
    """Generator factory: object.* → a Pydantic model module per object.

    Returns an :class:`EntityModelGenerator` (subclassable extension seam)."""
    return EntityModelGenerator()
