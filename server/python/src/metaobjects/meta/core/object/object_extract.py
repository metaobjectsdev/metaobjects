"""Phase B (metadata-driven extract) runtime entry point — the Python keystone
that turns dirty LLM text into a populated, typed object graph.

This is the runtime bridge between the two halves of the standard:

* the extract **engine** (:mod:`metaobjects.render.extract`: ``ExtractSchema`` /
  ``FieldSpec`` / ``extract``) — a low-level, descriptor-driven module that parses
  dirty JSON/XML into a forgiving ``dict``/``list`` tree + a ``ExtractionReport``. It
  knows nothing of the runtime object model.
* the Phase A runtime **object model** (:mod:`metaobjects.meta.core.object`:
  ``MetaObject.new_instance()`` + the ``MetaField`` get/set SPI + ``@objectRef``) —
  instantiates the right backing type (``ValueObject`` or a registered/bound class)
  with the correct back-reference.

**Siting.** ``render.extract`` is a LOWER layer and stays metadata-free by design
(coupling it to the metadata model would invert the layering). The metadata-driven
bridge therefore lives HERE, in :mod:`metaobjects.meta.core.object` — alongside the
Phase A object model, the natural home for a runtime API that needs BOTH ``MetaObject``
and the extract engine. This mirrors the JVM layering, where the extract engine sits
in the metadata-free ``render`` module and the runtime extract bridge lives in the
``om`` runtime module (which depends on both); and the TS layering, where the bridge
lives in ``runtime-ts`` rather than the published ``render`` engine package. The edges
are one-way: this module → ``render.extract`` and this module → ``meta``; the engine
depends on neither, so there is no cycle.

**Reflection-free.** Assembly uses ``MetaObject.new_instance()`` (the
``ObjectClassRegistry`` resolves the bound type, else a ``ValueObject``) and the
``MetaField`` set-by-name SPI — no ``importlib`` / dynamic class resolution
(ADR-0001).

**Never throws.** Lost/malformed fields are classified in the report, never raised.
Opt into strictness with :func:`or_throw`, which raises :class:`ExtractError` iff a
required field was lost.
"""
from __future__ import annotations

from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.meta_data import MetaData
from metaobjects.render.extract import (
    FieldKind,
    FieldSpec,
    Format,
    ExtractOptions,
    ExtractSchema,
    ExtractionResult,
    extract,
)
from metaobjects.shared.structural import KEY_IS_ARRAY

from .meta_object import MetaObject

#: Maximum nested-object recursion depth. Mirrors the render
#: ``OutputFormatRenderer.MAX_NEST_DEPTH`` (and FR-012) — must stay identical
#: cross-port (Java ``MetaObjectExtractor.MAX_NEST_DEPTH = 8``). At or beyond this depth
#: a nested OBJECT field becomes an opaque STRING leaf instead of recursing.
MAX_NEST_DEPTH = 8


# =============================================================================
# ExtractError + or_throw — the opt-in strictness gate
# =============================================================================


class ExtractError(Exception):
    """Raised by :func:`or_throw` when a extraction lost one or more ``@required``
    fields. ``lost_required`` lists the field paths that were absent/uncoercible."""

    def __init__(self, lost_required: list[str]) -> None:
        self.lost_required = list(lost_required)
        joined = ", ".join(self.lost_required)
        super().__init__(f"extract lost required field(s): {joined}")


def or_throw(result: ExtractionResult[object]) -> object:
    """Opt into strictness: return ``result.data`` iff no ``@required`` field was
    lost, else raise :class:`ExtractError`. Mirrors the cross-port ``ExtractionResult.
    orThrow()`` / TS free ``orThrow``. Extract itself NEVER raises — this is the
    explicit gate a caller reaches for when a lost-required field should fail."""
    if result.report.has_lost_required():
        raise ExtractError(result.report.lost_required())
    return result.data


# =============================================================================
# Public API
# =============================================================================


def extract_object(
    mo: MetaObject,
    text: str | None,
    format: Format = Format.JSON,
    opts: ExtractOptions | None = None,
) -> ExtractionResult[object]:
    """Extract ``text`` into a typed object graph described by ``mo``.

    Pipeline: build a ``ExtractSchema`` from ``mo`` (driven entirely by metadata),
    run the engine to get a forgiving ``dict``/``list`` tree + report, then assemble
    that tree into a populated object graph.

    :param mo:     the object describing the expected shape (the single source of truth)
    :param text:   the dirty model output
    :param format: JSON (default) or XML — drives the engine's locate/parse
    :param opts:   bounded runtime overrides (aliases/normalizers/on_field/tolerance)
    :returns: the assembled object (a ``ValueObject`` unless a type is bound for the
              FQN) + report. NEVER ``None``; NEVER raises.
    """
    schema = extract_schema_for(mo, format)
    outcome = extract(text, schema, opts)
    obj = assemble(mo, outcome.data)
    return ExtractionResult(data=obj, report=outcome.report)


# =============================================================================
# extract_schema_for — metadata -> ExtractSchema
# =============================================================================


def extract_schema_for(mo: MetaObject, format: Format = Format.JSON) -> ExtractSchema:
    """Build a ``ExtractSchema`` for ``mo`` by walking its effective fields and
    mapping each ``MetaField`` to a ``FieldSpec``. Recurses into nested OBJECT fields
    via ``@objectRef``, guarded against cycles/over-depth by an identity visited-set
    keyed on ``id(MetaObject)`` + a depth counter bounded by :data:`MAX_NEST_DEPTH`."""
    return _extract_schema_for(mo, format, set(), 0)


def _extract_schema_for(
    mo: MetaObject, format: Format, visited: set[int], depth: int
) -> ExtractSchema:
    visited.add(id(mo))
    fields = [_field_spec_for(f, mo, format, visited, depth) for f in mo.fields()]
    visited.discard(id(mo))
    # root_name is the simple (short) name; the engine's XML locate uses it as the root tag.
    return ExtractSchema(format, mo.name, fields)


def _field_spec_for(
    field: MetaField,
    owner: MetaObject,
    format: Format,
    visited: set[int],
    depth: int,
) -> FieldSpec:
    name = field.name
    required = _is_required(field)
    array = _is_array(field)

    # --- Enum (scalar or array) ----------------------------------------------
    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        values = _enum_values(field)
        aliases = _enum_aliases(field)
        cd = _own_attr_string(field, fc.FIELD_ATTR_COERCE_DEFAULT)
        dv = _own_attr_string(field, fc.FIELD_ATTR_DEFAULT)
        normalize = _resolve_normalize(field, owner)
        if array:
            return FieldSpec.enum_array(name, required, values, aliases, cd, normalize, dv)
        return FieldSpec.enum_field(name, required, values, aliases, cd, normalize, dv)

    # --- Nested object (single or array) --------------------------------------
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT or field.object_ref is not None:
        ref = _resolve_object_ref(field)
        if ref is None or id(ref) in visited or depth + 1 >= MAX_NEST_DEPTH:
            # Opaque leaf — never recurse into an unresolved ref / a cycle / past the
            # depth bound.
            return FieldSpec.scalar(name, FieldKind.STRING, required)
        nested = _extract_schema_for(ref, format, visited, depth + 1)
        return FieldSpec.object_(name, required, array, nested)

    # --- Scalar (carry generalized @default) ----------------------------------
    kind = _scalar_kind(field.sub_type)
    if array:
        # Scalar array: the engine coerces each element; no per-element default fill.
        return FieldSpec.scalar_array(name, kind, required)
    dv = _own_attr_string(field, fc.FIELD_ATTR_DEFAULT)
    return FieldSpec.scalar(name, kind, required, dv)


# =============================================================================
# assemble — extracted dict/list tree -> object graph
# =============================================================================


def assemble(mo: MetaObject, data: dict[str, object] | None) -> object:
    """Assemble a extracted ``dict`` (the engine's forgiving tree) into a populated
    object graph described by ``mo``.

    ``mo.new_instance()`` yields the bound type (or a ``ValueObject``) with the
    back-ref already set. Each field's value is written via the ``MetaField`` SPI:

    * scalar / enum / scalar-array / enum-array → ``set_value`` (engine already
      coerced; arrays arrive as a list);
    * OBJECT non-array → recursively assemble the child ``dict``, then ``set_value``;
    * OBJECT array → recursively assemble each element ``dict`` into a list, then
      ``set_value``.

    Cycle/depth-guarded identically to :func:`extract_schema_for`. NEVER raises on
    lost/malformed data — those were classified in the report during the engine pass.
    """
    return _assemble(mo, data, set(), 0)


def _assemble(
    mo: MetaObject, data: dict[str, object] | None, visited: set[int], depth: int
) -> object:
    o = mo.new_instance()
    if data is None:
        return o
    visited.add(id(mo))
    for field in mo.fields():
        name = field.name
        value = data.get(name)

        is_object_field = (
            field.sub_type == fc.FIELD_SUBTYPE_OBJECT or field.object_ref is not None
        )
        # Enum fields are string-backed scalars/arrays — treat them as scalar assignment.
        if not is_object_field or field.sub_type == fc.FIELD_SUBTYPE_ENUM:
            # scalar / enum / scalar-array / enum-array: the engine already coerced it.
            if value is not None:
                field.set_value(o, value)
            continue

        # Nested object — guard cycles/depth (mirror the schema guard).
        ref = _resolve_object_ref(field)
        cyclic_or_deep = (
            ref is None or id(ref) in visited or depth + 1 >= MAX_NEST_DEPTH
        )

        if _is_array(field):
            # Array-of-objects: map each element dict -> assembled child.
            if isinstance(value, list) and ref is not None and not cyclic_or_deep:
                children: list[object] = [
                    _assemble(ref, elem, visited, depth + 1)
                    for elem in value
                    if isinstance(elem, dict)
                ]
                field.set_value(o, children)
            elif isinstance(value, list):
                # ref unresolved / cyclic / over-deep: empty list (no recursion).
                field.set_value(o, [])
            # absent array stays absent (the engine reports it).
        else:
            # Single object.
            if ref is not None and not cyclic_or_deep and isinstance(value, dict):
                child = _assemble(ref, value, visited, depth + 1)
                field.set_value(o, child)
            # else leave unset.
    visited.discard(id(mo))
    return o


# =============================================================================
# Field-spec helpers (mirror codegen fr010_field_mapping + the Java/TS reader)
# =============================================================================


def _scalar_kind(sub_type: str) -> FieldKind:
    """The engine ``FieldKind`` for a scalar field subtype. Unknown subtypes fall
    back to STRING. Mirrors the cross-port ``scalarKind`` ordering."""
    if sub_type in (
        fc.FIELD_SUBTYPE_STRING,
        fc.FIELD_SUBTYPE_CLASS,
        fc.FIELD_SUBTYPE_UUID,
        fc.FIELD_SUBTYPE_DATE,
        fc.FIELD_SUBTYPE_TIME,
        fc.FIELD_SUBTYPE_TIMESTAMP,
    ):
        return FieldKind.STRING
    if sub_type == fc.FIELD_SUBTYPE_INT:
        return FieldKind.INT
    if sub_type in (fc.FIELD_SUBTYPE_LONG, fc.FIELD_SUBTYPE_CURRENCY):
        return FieldKind.LONG
    if sub_type in (
        fc.FIELD_SUBTYPE_DOUBLE,
        fc.FIELD_SUBTYPE_FLOAT,
        fc.FIELD_SUBTYPE_DECIMAL,
    ):
        return FieldKind.DOUBLE
    if sub_type == fc.FIELD_SUBTYPE_BOOLEAN:
        return FieldKind.BOOLEAN
    return FieldKind.STRING


def _is_array(field: MetaField) -> bool:
    """Array-ness from either form: the node property (programmatic build) or the
    ``@isArray`` attr (how metadata loads from JSON). Mirrors ``fr010_field_mapping``."""
    return bool(field.is_array) or field.attr(KEY_IS_ARRAY) is True


def _is_required(field: MetaField) -> bool:
    """True iff ``@required`` is explicitly the bool ``True`` or the string ``"true"``."""
    v = field.attr(fc.FIELD_ATTR_REQUIRED)
    if v is True:
        return True
    return isinstance(v, str) and v.lower() == "true"


def _enum_values(field: MetaField) -> list[str]:
    """The string members of an enum field's ``@values`` attr (empty when absent)."""
    v = field.attr(fc.FIELD_ATTR_VALUES)
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return []


def _enum_aliases(field: MetaField) -> dict[str, str]:
    """The ``@enumAlias`` map of an enum field, or ``{}`` when absent/empty."""
    raw = field.attr(fc.FIELD_ATTR_ENUM_ALIAS)
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if v is not None}


def _resolve_normalize(field: MetaField, owner: MetaObject | None) -> str:
    """Resolve the enum normalization mode: field-level ``@normalize``, else the
    owning object's ``@normalize``, else the global default (``"strip"``). Mirrors the
    cross-port ``resolveNormalize``."""
    field_mode = _own_attr_string(field, fc.FIELD_ATTR_NORMALIZE)
    if field_mode is not None:
        return field_mode
    if owner is not None:
        owner_mode = _own_attr_string(owner, fc.FIELD_ATTR_NORMALIZE)
        if owner_mode is not None:
            return owner_mode
    return fc.NORMALIZE_DEFAULT


def _own_attr_string(node: MetaData, attr: str) -> str | None:
    """The own (non-inherited) string value of an attr on a node, or ``None`` when
    absent/empty."""
    v = node.attr(attr)
    if isinstance(v, str):
        return v if v else None
    return None if v is None else str(v)


def _resolve_object_ref(field: MetaField) -> MetaObject | None:
    """Resolve a field's ``@objectRef`` to its ``MetaObject`` by walking to the tree
    root and matching on ``resolution_key()`` (the package-folded FQN the objectRef
    uses), with a short-name fallback. Returns ``None`` when unresolvable (→ the
    opaque-leaf / leave-unset guard). Reflection-free: a pure metadata-tree walk."""
    ref = field.object_ref
    if ref is None:
        return None
    root = _root_of(field)
    if root is None:
        return None
    objects = [c for c in root.children() if isinstance(c, MetaObject)]
    direct = next((o for o in objects if o.resolution_key() == ref), None)
    if direct is not None:
        return direct
    # Short-name fallback: a bare ref or the trailing segment after the last "::".
    from metaobjects.shared.separators import PACKAGE_SEP

    short = ref.rsplit(PACKAGE_SEP, 1)[-1] if PACKAGE_SEP in ref else ref
    return next((o for o in objects if o.name == short), None)


def _root_of(node: MetaData) -> MetaData | None:
    """Walk the parent chain to the tree root (the node whose ``parent`` is None)."""
    cur: MetaData | None = node
    while cur is not None and cur.parent is not None:
        cur = cur.parent
    return cur
