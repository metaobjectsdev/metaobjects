"""object.* → Pydantic v2 model module (sub-project A)."""
from __future__ import annotations

import re

from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.validator import validator_constants as vc
from metaobjects.shared.base_types import TYPE_VALIDATOR
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
        val = v.attr(attr_name)
        if _is_int(val):
            return val
    return None


def _validator_constraints(field: MetaField) -> dict[str, object]:
    """Map the field's ``validator.*`` children + field attrs to Pydantic ``Field``
    kwargs. Cross-port-canonical semantics (TS is the reference):

    - ``validator.regex @pattern`` -> ``pattern=``
    - ``validator.numeric @min/@max`` -> ``ge=``/``le=`` (numeric value bounds)
    - ``validator.length @min`` + field ``@maxLength`` -> ``min_length=``/``max_length=``
    - ``validator.array @min/@max`` -> list ``min_length=``/``max_length=`` (element count)
    """
    kwargs: dict[str, object] = {}

    # String length: validator.length @min/@max + field @maxLength (max wins per field attr).
    min_len = _first_attr(field, vc.VALIDATOR_SUBTYPE_LENGTH, vc.VALIDATOR_ATTR_MIN)
    max_len = _first_attr(field, vc.VALIDATOR_SUBTYPE_LENGTH, vc.VALIDATOR_ATTR_MAX)
    field_max = field.attrs().get(fc.FIELD_ATTR_MAX_LENGTH)
    if _is_int(field_max):
        max_len = field_max
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
        pattern = v.attr(vc.VALIDATOR_ATTR_PATTERN)
        if isinstance(pattern, str):
            kwargs["pattern"] = pattern
            break

    # ADR-0036/0037 Wave 3 — @stringFormat: hostname -> a codegen-owned canonical
    # hostname pattern= (the matcher lives HERE, never author validator.regex, so
    # every port replicates the byte-identical form). @stringFormat: email is bound
    # as EmailStr in _field_line (a type, not a pattern), so it is not handled here.
    if field.attrs().get(fc.FIELD_ATTR_STRING_FORMAT) == fc.STRING_FORMAT_HOSTNAME:
        kwargs["pattern"] = _HOSTNAME_REGEX

    return kwargs


def _field_line(field: MetaField, imports: set[str], config: GenConfig) -> tuple[str, bool]:
    """Return (source line, uses_field). Collects required imports into *imports*."""
    # FR-019: a field resolving to a package-level shared enum is typed by the materialized
    # standalone class (imported from the shared `enums` module) or — when @provided — an
    # external module from per-port config; inline enums keep their `Literal[...]` (py_type_for).
    shared = (
        fr019.shared_enum_for_field(field)
        if field.sub_type == fc.FIELD_SUBTYPE_ENUM
        else None
    )
    if shared is not None:
        type_name, import_line = fr019.enum_type_and_import(shared, config)
        imports.add(import_line)
        type_expr = f"list[{type_name}]" if field_is_array(field) else type_name
    else:
        pt = py_type_for(field)
        imports.update(pt.imports)
        type_expr = pt.expr
    # ADR-0036/0037 Wave 3 — @stringFormat: email narrows a plain string to a
    # validated email. Bind Pydantic's idiomatic EmailStr (the Python analogue of
    # Zod .email()); hostname stays a plain str with a codegen-owned canonical
    # pattern= (handled in _validator_constraints). The field stays a string.
    if (
        field.sub_type == fc.FIELD_SUBTYPE_STRING
        and field.attrs().get(fc.FIELD_ATTR_STRING_FORMAT) == fc.STRING_FORMAT_EMAIL
    ):
        base_expr = "EmailStr"
        imports.add("from pydantic import EmailStr")
        type_expr = f"list[{base_expr}]" if field_is_array(field) else base_expr
    if field.sub_type in (fc.FIELD_SUBTYPE_OBJECT, fc.FIELD_SUBTYPE_MAP):
        # A field.object (-> VO) and a field.map with @objectRef (-> dict[str, VO])
        # both reference a value-object by name; import it so the annotation
        # py_type_for emitted resolves.
        ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
        if ref:
            # @objectRef is FQN-expanded at load time; the generated VOs live
            # flat in one package, so import by the bare class name.
            ref_name = str(ref).split("::")[-1]
            imports.add(f"from .{ref_name} import {ref_name}")
    required = field.attrs().get(fc.FIELD_ATTR_REQUIRED) is True
    default_raw = field.attrs().get(fc.FIELD_ATTR_DEFAULT)
    # A server-side expression default (now(), gen_random_uuid(), CURRENT_TIMESTAMP)
    # is filled by the DB — the Python model carries no default for it (the field keeps
    # its required/optional shape). Only literal defaults become Pydantic defaults.
    has_default = default_raw is not None and not _is_sql_expr_default(default_raw)
    enum_type_name = type_name if shared is not None else None

    constraints = _validator_constraints(field)
    # Emit kwargs in a stable order so generated output is deterministic.
    _order = ["pattern", "ge", "le", "min_length", "max_length"]
    parts = [f"{k}={constraints[k]!r}" for k in _order if k in constraints]
    uses_field = bool(parts)

    # @default — render an enum member (Type.MEMBER, UPPER_CASE) or a Python literal.
    if has_default:
        if enum_type_name is not None and not field_is_array(field):
            default_expr = f"{enum_type_name}.{str(default_raw).upper()}"
        else:
            default_expr = repr(default_raw)
    else:
        default_expr = None

    # A field is Optional only when it is neither required nor carries a @default.
    annotation = type_expr if (required or has_default) else f"{type_expr} | None"
    if has_default and uses_field:
        assignment = f" = Field(default={default_expr}, {', '.join(parts)})"
    elif has_default:
        assignment = f" = {default_expr}"
    elif required and uses_field:
        assignment = f" = Field({', '.join(parts)})"
    elif required:
        assignment = ""
    elif uses_field:
        assignment = f" = Field(default=None, {', '.join(parts)})"
    else:
        assignment = " = None"

    # Pydantic field name = @column when present, else field.name. A cross-port
    # entity carries the camelCase field.name (the TS property) AND the snake_case
    # @column (the physical DB column); the Python model field IS the column, so it
    # binds straight to the row. Backward-compatible: snake-authored models with no
    # @column emit field.name unchanged.
    py_name = field.attrs().get(fc.FIELD_ATTR_COLUMN) or field.name
    return f"    {py_name}: {annotation}{assignment}", uses_field


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
        *imports*. *config* carries the FR-019 @provided-enum resolution. Override to
        add/transform body lines."""
        cfg = config if config is not None else GenConfig(out_dir="")
        uses_field = False
        lines: list[str] = []
        for f in entity.own_fields():
            line, used = _field_line(f, imports, cfg)
            uses_field = uses_field or used
            lines.append(line)

        # M:N nested collections (FR-018). Element type is the target entity; a
        # self-join element type is a forward-ref string so the model can name itself.
        if object_index is not None:
            for d in resolve_m2m_descriptors(entity, object_index):
                if d.target_entity == entity.name:
                    element = f'"{entity.name}"'
                else:
                    element = d.target_entity
                    imports.add(f"from .{d.target_entity} import {d.target_entity}")
                lines.append(f"    {d.relation_name}: list[{element}] = []")
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

        # Import only the pydantic names actually referenced.
        pyd_names: list[str] = []
        if entity.super_data is None:
            pyd_names.append("BaseModel")
        if uses_field:
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
        parts += ["", self._emit_class_header(entity, base_class), *body, ""]
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
