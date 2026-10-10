"""FR-044 — cross-node rules for the reporting vocabulary.

A rule-for-rule port of the TypeScript reference
``server/typescript/packages/metadata/src/loader/reporting-validation.ts``. The rule
ids (D1…F2) match the shared rule table (R8, R9, M7 and M8: Table B of
docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md) and the
error fixtures in ``fixtures/conformance/error-*``. Every port implements the same
table WITH THE SAME MESSAGE TEXT; the fixtures are the contract.

Two design rules hold throughout, so one broken rule yields exactly one error:

- No cascades. A member that fails a structural rule is not checked further (a
  dimension whose @via fails D2 skips D1/D3/D4; a measure that fails one of M1–M4, or
  whose @default is a fraction, skips M7/M8; a report whose @from fails R1 skips
  R2/R3/R6/R7, R8/R9 and its @filter; a report whose @spine fails R8 skips R9, and R9
  skips a dimension whose @via fails D2; an invalid @dimensions/@measures item derives
  no report field for R6).
- Each error's ``envelope`` is the offending node's source (the dimension / measure /
  segment / report, or for R4/R5 the declared child), so a conformance fixture's
  jsonPath points at it.

Inheritance (ADR-0039): an entity's members are read through ``children()``, so a
member declared on an abstract base is validated against every entity that inherits
it. Members declared on an entity are validated first (pass 1), then inherited ones
(pass 2); an error already reported for the same node with the same message is not
repeated, so a broken base member is reported ONCE, and a failure that only an
inheritor exposes carries `` (inherited by '<entity>')``.

A fractional measure @default: the TypeScript reference refuses it in its measure check,
because its generic attr.int check lets a fraction through. This port's generic attr-type
check (``validation_passes._type_ok``) already refuses it with ERR_BAD_ATTR_VALUE on the
measure node, so no second error is added here; ``_check_measure`` only skips M7/M8 for
it, as the reference does.

ADR-0039 NAMING INVERSION: Python ``attr()`` is OWN-ONLY. Every place the TS reference
calls the resolving ``attr()`` / ``children()``, this module calls ``get_meta_attr()`` /
``children()``. The two ``own*`` uses (R4 and the F1 tree walk) carry their sanctioned
case in a comment.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable, TypeGuard

from ..errors import ErrorCode, MetaError
from ..meta.core.attr.attr_constants import ATTR_SUBTYPE_FILTER
from ..meta.core.field.field_constants import (
    FIELD_SUBTYPE_BOOLEAN,
    FIELD_SUBTYPE_CURRENCY,
    FIELD_SUBTYPE_DATE,
    FIELD_SUBTYPE_DECIMAL,
    FIELD_SUBTYPE_DOUBLE,
    FIELD_SUBTYPE_FLOAT,
    FIELD_SUBTYPE_INT,
    FIELD_SUBTYPE_LONG,
    FIELD_SUBTYPE_MAP,
    FIELD_SUBTYPE_OBJECT,
    FIELD_SUBTYPE_TIMESTAMP,
)
from ..meta.core.identity.identity_constants import (
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_REFERENCE,
)
from ..meta.core.object.object_constants import (
    OBJECT_REPORT_ATTR_FILTER,
    OBJECT_REPORT_ATTR_SEGMENT,
    OBJECT_REPORT_ATTR_SPINE,
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_REPORT,
)
from ..meta.core.relationship.relationship_constants import (
    CARDINALITY_ONE,
    RELATIONSHIP_ATTR_CARDINALITY,
    RELATIONSHIP_ATTR_OBJECT_REF,
)
from ..meta.core.reporting.meta_dimension import MetaDimension
from ..meta.core.reporting.meta_measure import MetaMeasure
from ..meta.core.reporting.meta_segment import MetaSegment
from ..meta.core.reporting.report_accessors import (
    report_derived_field_name,
    report_dimension_items,
    report_from,
    report_measure_names,
    report_spine,
)
from ..meta.core.reporting.reporting_constants import (
    AGG_AVG,
    AGG_COUNT,
    AGG_MAX,
    AGG_MIN,
    AGG_SUM,
    FILTER_RELATIVE_NOW,
    GRAIN_HOUR,
    ISO_DURATION_RE,
    MEASURE_SUBTYPE_AGGREGATE,
    REPORT_DIMENSION_GRAIN_SEPARATOR,
    REPORTING_ATTR_DEFAULT,
    REPORTING_ATTR_DENOMINATOR,
    REPORTING_ATTR_NUMERATOR,
    REPORTING_ATTR_VIA,
)
from ..meta.meta_data import MetaData
from ..meta.persistence.source.meta_source import MetaSource
from ..naming_refs import CHILD_REF_SEP, resolve_object_ref
from ..shared.base_types import (
    TYPE_DIMENSION,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_MEASURE,
    TYPE_OBJECT,
    TYPE_RELATIONSHIP,
    TYPE_SEGMENT,
    TYPE_SOURCE,
)
from ..shared.separators import PACKAGE_SEP

# ---------------------------------------------------------------------------
# Closed sets the rules consult
# ---------------------------------------------------------------------------

#: M4 — the field subtypes ``sum``/``avg`` accept.
_NUMERIC_FIELD_SUBTYPES: frozenset[str] = frozenset(
    {
        FIELD_SUBTYPE_INT,
        FIELD_SUBTYPE_LONG,
        FIELD_SUBTYPE_DOUBLE,
        FIELD_SUBTYPE_FLOAT,
        FIELD_SUBTYPE_DECIMAL,
        FIELD_SUBTYPE_CURRENCY,
    }
)

#: M4 — the field subtypes ``min``/``max`` refuse (no total order).
_UNORDERED_FIELD_SUBTYPES: frozenset[str] = frozenset(
    {FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP}
)

#: D3 / F2 — the temporal field subtypes.
_TEMPORAL_FIELD_SUBTYPES: frozenset[str] = frozenset({FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIMESTAMP})

# Filter op / composition keys (TS query-constants.ts).
_FILTER_OP_EQ = "eq"
_FILTER_OP_NE = "ne"
_FILTER_OP_GT = "gt"
_FILTER_OP_GTE = "gte"
_FILTER_OP_LT = "lt"
_FILTER_OP_LTE = "lte"
_FILTER_OP_IN = "in"
_FILTER_OP_LIKE = "like"
_FILTER_OP_IS_NULL = "isNull"
_FILTER_COMPOSE_AND = "and"
_FILTER_COMPOSE_OR = "or"

#: The canonical operator order (TS ``FILTER_OPS``). The loader's ``ops_for_field``
#: returns an order-free set; the S1 message lists the allowed ops in this order,
#: which is the order every TS band is declared in.
_FILTER_OPS_CANONICAL: tuple[str, ...] = (
    _FILTER_OP_EQ,
    _FILTER_OP_NE,
    _FILTER_OP_GT,
    _FILTER_OP_GTE,
    _FILTER_OP_LT,
    _FILTER_OP_LTE,
    _FILTER_OP_IN,
    _FILTER_OP_LIKE,
    _FILTER_OP_IS_NULL,
)

#: F2 — the only ops a relative-date value may sit under.
_RELATIVE_DATE_OPS: frozenset[str] = frozenset({_FILTER_OP_GT, _FILTER_OP_GTE, _FILTER_OP_LT, _FILTER_OP_LTE})

_ERR_INVALID_DIMENSION = ErrorCode.ERR_INVALID_DIMENSION
_ERR_INVALID_MEASURE = ErrorCode.ERR_INVALID_MEASURE
_ERR_INVALID_REPORT = ErrorCode.ERR_INVALID_REPORT
_ERR_REPORT_FOREIGN_MEASURE = ErrorCode.ERR_REPORT_FOREIGN_MEASURE
_ERR_BAD_ATTR_FILTER = ErrorCode.ERR_BAD_ATTR_FILTER


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def validate_reporting(root: MetaData, errors: list[MetaError]) -> None:
    """Run the FR-044 reporting rules over the loaded tree, appending to ``errors``."""
    sink = _ErrorSink()
    # ADR-0039: root has no super; children()==own_children() but resolving is the default.
    objects = [c for c in root.children() if c.type == TYPE_OBJECT]
    entities = [o for o in objects if o.sub_type == OBJECT_SUBTYPE_ENTITY]

    # Pass 1: every member against the entity that declares it (an abstract base
    # included — its members must be self-consistent). Pass 2: inherited members
    # against each inheriting entity, so an override that breaks one is caught.
    for entity in entities:
        _check_entity_members(root, entity, True, sink)
    for entity in entities:
        _check_entity_members(root, entity, False, sink)

    for report in (o for o in objects if o.sub_type == OBJECT_SUBTYPE_REPORT):
        _check_report(root, report, sink)

    # F1 on every host that is not a reporting host.
    _check_no_relative_dates(root, sink)
    errors.extend(sink.errors)


class _ErrorSink:
    """Collects errors, dropping a repeat — the shape an unmodified inherited
    member's failure takes when it is re-validated under an inheriting entity.

    A message is ``head + suffix + body``. A pass-2 error (suffix
    `` (inherited by '<entity>')``) is dropped when pass 1 already reported the
    same failure without a suffix, or the same inheritor already reported it; a
    second inheritor's identical failure is still reported, under its own name."""

    def __init__(self) -> None:
        self.errors: list[MetaError] = []
        self._seen: dict[int, set[str]] = {}

    def push(self, node: MetaData, code: ErrorCode, head: str, body: str, suffix: str = "") -> None:
        # ``base`` drops a pass-2 copy of a failure pass 1 already reported; a pass-2
        # entry is keyed WITH its suffix, so two inheritors that break the same
        # inherited member the same way are each reported.
        base = f"{code.value}\u0000{head}{body}"
        key = f"{base}\u0000{suffix}"
        keys = self._seen.setdefault(id(node), set())
        if base in keys or key in keys:
            return
        keys.add(base if suffix == "" else key)
        self.errors.append(MetaError(f"{head}{suffix}{body}", code, envelope=node.source))


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _pkg_of(node: MetaData) -> str:
    """The node's package for ADR-0042 bare-reference resolution (TS ``pkgOf``)."""
    if node.package is not None:
        return node.package
    if node.file_default_package is not None:
        return node.file_default_package
    return ""


@dataclass(frozen=True)
class _Dotted:
    owner: str
    path: list[str]


def _split_dotted(ref: str) -> _Dotted | None:
    """Split a dotted ``Owner.child[.child…]`` reference at the first ``.`` after the
    last ``::`` (the same rule ``_ref_named_owner`` applies to extends refs), so an
    FQN owner (``acme::shop::Purchase.program``) keeps its package. ``None`` when
    there is no owner, no child, or an empty child segment."""
    last_sep = ref.rfind(PACKAGE_SEP)
    seg_start = 0 if last_sep == -1 else last_sep + len(PACKAGE_SEP)
    dot = ref.find(CHILD_REF_SEP, seg_start)
    if dot <= seg_start:
        return None
    path = ref[dot + len(CHILD_REF_SEP):].split(CHILD_REF_SEP)
    if any(s == "" for s in path):
        return None
    return _Dotted(owner=ref[:dot], path=path)


def _is_self_or_ancestor(candidate: MetaData | None, entity: MetaData) -> bool:
    """True when ``candidate`` is ``entity`` or an entity it extends (the super chain)."""
    visited: set[int] = set()
    n: MetaData | None = entity
    while n is not None and id(n) not in visited:
        if n is candidate:
            return True
        visited.add(id(n))
        n = n.super_data
    return False


def _child_of_type(obj: MetaData, type_: str, name: str) -> MetaData | None:
    # ADR-0039: resolving — inherited members (via extends) are visible.
    return next((c for c in obj.children() if c.type == type_ and c.name == name), None)


def _field_of(obj: MetaData, name: str) -> MetaData | None:
    return _child_of_type(obj, TYPE_FIELD, name)


def _is_relative_value(v: object) -> TypeGuard[dict[str, object]]:
    """An object operand carrying a ``now`` key — a relative-date value, well-formed
    (exactly ``{ now }``) or not. A malformed one is refused, never read as data."""
    return isinstance(v, dict) and FILTER_RELATIVE_NOW in v


def _relative_operand(v: object) -> dict[str, object] | None:
    """The relative value an op's operand carries: the operand itself, or one inside
    an array operand."""
    if _is_relative_value(v):
        return v
    if isinstance(v, list):
        for x in v:
            if _is_relative_value(x):
                return x
    return None


def _operand_contains_relative_value(v: object) -> bool:
    """Deep search of an operand VALUE: is a relative value (well-formed or not) anywhere inside it?"""
    if _is_relative_value(v):
        return True
    if isinstance(v, list):
        return any(_operand_contains_relative_value(x) for x in v)
    if isinstance(v, dict):
        return any(_operand_contains_relative_value(x) for x in v.values())
    return False


def _filter_contains_relative_value(filter_value: object) -> bool:
    """Does a filter contain a relative value in any operand? Walks the filter grammar
    (``and``/``or`` arrays, ``{ field: { op: operand } }``) so only operand VALUES are
    searched: a field key that happens to be named ``now`` is a field, not a relative date."""
    if not isinstance(filter_value, dict):
        return False
    for key, clause in filter_value.items():
        if key == _FILTER_COMPOSE_OR or key == _FILTER_COMPOSE_AND:
            if isinstance(clause, list) and any(_filter_contains_relative_value(c) for c in clause):
                return True
            continue
        if _is_relative_value(clause):
            return True  # un-desugared shorthand
        if isinstance(clause, dict) and any(_operand_contains_relative_value(x) for x in clause.values()):
            return True
    return False


def _js_json(v: object) -> str:
    """``JSON.stringify`` byte form (no spaces, non-ASCII kept) so message text matches TS."""
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def _quote_value(v: object) -> str:
    return v if isinstance(v, str) else _js_json(v)


def _child_label(node: MetaData) -> str:
    """``<type>.<subType> '<name>'``, or just ``<type>.<subType>`` for an unnamed node."""
    head = f"{node.type}.{node.sub_type}"
    return f"{head} '{node.name}'" if node.name != "" else head


def _node_label(node: MetaData) -> str:
    """``<type>.<subType> '<FQN>'`` for a root-level object, else its child label plus
    `` in <parent label>``."""
    parent = node.parent
    if parent is None or parent.parent is None:
        return f"{node.type}.{node.sub_type} '{node.resolution_key()}'"
    return f"{_child_label(node)} in {_node_label(parent)}"


def _ops_for_field_ordered(field: MetaData) -> tuple[str, ...]:
    """The field's filter-op band in canonical order (TS ``opsForField``)."""
    # Deferred: validation_passes imports this module to run the pass.
    from .validation_passes import ops_for_field

    band = ops_for_field(field)
    return tuple(op for op in _FILTER_OPS_CANONICAL if op in band)


# ---------------------------------------------------------------------------
# D1–D4, M1–M6, S1/F2 — members of an object.entity
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _MemberCtx:
    """Validation context for one member of one entity."""

    root: MetaData
    #: The entity whose children() the member was reached through.
    host: MetaData
    #: The entity that declares the member (the host, or an ancestor of it).
    declaring: MetaData
    #: ``<kind> '<name>' on entity '<declaring FQN>'`` — every member message starts with it.
    label: str
    #: "" in pass 1; `` (inherited by '<host FQN>')`` in pass 2.
    suffix: str
    sink: _ErrorSink


def _shown(ctx: _MemberCtx, entity: MetaData) -> str:
    """The FQN a member message names for ``entity``: the DECLARING entity in place of
    the host, so a failure is worded identically whichever entity reached the member
    (the suffix names the inheritor) and the sink's repeat test holds."""
    return (ctx.declaring if entity is ctx.host else entity).resolution_key()


def _check_entity_members(root: MetaData, entity: MetaData, declared_here: bool, sink: _ErrorSink) -> None:
    # ADR-0039: resolving — inherited members are validated against this entity.
    for member in entity.children():
        if member.type not in (TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT):
            continue
        declaring = member.parent if member.parent is not None else entity
        if (declaring is entity) != declared_here:
            continue
        ctx = _MemberCtx(
            root=root,
            host=entity,
            declaring=declaring,
            label=f"{member.type} '{member.name}' on entity '{declaring.resolution_key()}'",
            suffix="" if declared_here else f" (inherited by '{entity.resolution_key()}')",
            sink=sink,
        )
        if isinstance(member, MetaDimension):
            _check_dimension(ctx, member)
        elif isinstance(member, MetaMeasure):
            _check_measure(ctx, member)
        elif isinstance(member, MetaSegment):
            filter_value = member.filter()
            if filter_value is not None:
                _check_filter(
                    filter_value, entity, declaring.resolution_key(), ctx.label, member, ctx.suffix, sink
                )


def _check_dimension(ctx: _MemberCtx, dim: MetaDimension) -> None:
    def err(message: str) -> None:
        ctx.sink.push(dim, _ERR_INVALID_DIMENSION, ctx.label, f": {message}", ctx.suffix)

    # D2 — the @via walk; its terminal is the entity @of must name.
    of_entity = ctx.host
    via = dim.via()
    if via is not None:
        terminal = _walk_to_one_via(ctx.root, ctx.host, via, err, _d2_walk(ctx.declaring))
        if terminal is None:
            return
        of_entity = terminal

    # D1 — @of is Entity.field on the owning entity (or the @via terminal).
    of = dim.of()
    if of is None:
        return  # missing @of is ERR_MISSING_REQUIRED_ATTR (attr schema pass)
    parts = _split_dotted(of)
    if parts is None or len(parts.path) != 1:
        err(f"@of '{of}' must be Entity.field.")
        return
    named = resolve_object_ref(ctx.root, parts.owner, _pkg_of(ctx.declaring))
    if not _is_self_or_ancestor(named, of_entity):
        if via is None:
            err(
                f"@of '{of}' must name a field of the owning entity '{ctx.declaring.resolution_key()}'. "
                f"Reach another entity's field with @via."
            )
        else:
            err(f"@of '{of}' must name a field of '{_shown(ctx, of_entity)}', the entity @via '{via}' reaches.")
        return
    field_name = parts.path[0]
    field = _field_of(of_entity, field_name)
    if field is None:
        err(f"@of '{of}' names no field '{field_name}' on '{_shown(ctx, of_entity)}'.")
        return

    if not dim.is_time():
        return
    # D3 — a time dimension groups a date or timestamp.
    if field.sub_type not in _TEMPORAL_FIELD_SUBTYPES:
        err(
            f"a time dimension's @of must be a field.date or field.timestamp, but '{of}' is "
            f"field.{field.sub_type}."
        )
        return
    # D4 — a date has no hour.
    if field.sub_type == FIELD_SUBTYPE_DATE and GRAIN_HOUR in dim.grains():
        err(f"grain 'hour' is impossible on '{of}', a field.date (a date has no hour). Remove 'hour' from @grains.")


@dataclass(frozen=True)
class _ToOneWalk:
    """What a to-one walk resolves against and how its messages name it. D2 walks a
    dimension's @via (:func:`_d2_walk`); R8 walks a report's @spine from @from
    (:func:`_spine_walk`). Every difference between the two is a field here, so each port
    copies one explicit rule (TS ``ToOneWalk``)."""

    #: The attribute holding the path: ``via`` (D2) or ``spine`` (R8).
    attr: str
    #: The package Owner resolves in (ADR-0042): the declaring entity's (D2) or the report's (R8).
    owner_pkg: str
    #: The FQN named for the walk's first entity: the declaring entity (D2) or @from (R8).
    host_name: str
    #: What Owner must be: ``the owning entity '<FQN>'`` (D2) or ``@from '<FQN>'`` (R8).
    start: str
    #: The same, in the malformed-path message: ``the owning entity`` (D2) or ``@from '<FQN>'`` (R8).
    start_short: str
    #: The sentence that ends the to-many message: why only to-one hops are followed.
    to_one_reason: str


def _d2_walk(declaring: MetaData) -> _ToOneWalk:
    """D2 — a dimension's @via, declared on ``declaring``. Reproduces D2's messages exactly."""
    declaring_key = declaring.resolution_key()
    return _ToOneWalk(
        attr=REPORTING_ATTR_VIA,
        owner_pkg=_pkg_of(declaring),
        host_name=declaring_key,
        start=f"the owning entity '{declaring_key}'",
        start_short="the owning entity",
        to_one_reason=(
            "A dimension follows only @cardinality: one relationships and identity.reference hops, so grouping "
            "can never multiply the measured rows."
        ),
    )


def _spine_walk(report: MetaData, from_key: str) -> _ToOneWalk:
    """R8 — a report's @spine, started at @from (``from_key``); Owner resolves in the report's package."""
    return _ToOneWalk(
        attr=OBJECT_REPORT_ATTR_SPINE,
        owner_pkg=_pkg_of(report),
        host_name=from_key,
        start=f"@from '{from_key}'",
        start_short=f"@from '{from_key}'",
        to_one_reason=(
            "A @spine follows only @cardinality: one relationships and identity.reference hops, so each fact row "
            "joins at most one row of the spine entity and is never counted twice."
        ),
    )


def _walk_to_one_via(
    root: MetaData,
    host: MetaData,
    via: str,
    err: Callable[[str], None],
    walk: _ToOneWalk,
) -> MetaData | None:
    """Walk ``Owner.hop[.hop...]`` from ``host``: Owner is ``host`` or an entity it
    extends, and every hop is a to-one ``relationship.*`` or an ``identity.reference``.
    Returns the terminal entity, or ``None`` after reporting the first failure. D2 and R8
    both run it; ``walk`` says which."""
    named = f"@{walk.attr} '{via}'"

    def name_of(entity: MetaData) -> str:
        return walk.host_name if entity is host else entity.resolution_key()

    parts = _split_dotted(via)
    if parts is None:
        err(f"{named} must be Owner.hop[.hop...], starting at {walk.start_short}.")
        return None
    owner = resolve_object_ref(root, parts.owner, walk.owner_pkg)
    if not _is_self_or_ancestor(owner, host):
        err(f"{named} must start at {walk.start}.")
        return None
    current = host
    for hop_name in parts.path:
        hop = _child_of_type(current, TYPE_RELATIONSHIP, hop_name)
        if hop is None:
            # ADR-0039: resolving — an inherited identity.reference is a hop too.
            hop = next(
                (
                    c
                    for c in current.children()
                    if c.type == TYPE_IDENTITY and c.sub_type == IDENTITY_SUBTYPE_REFERENCE and c.name == hop_name
                ),
                None,
            )
        if hop is None:
            err(
                f"{named} names '{hop_name}', which is not a relationship or identity.reference of "
                f"'{name_of(current)}'."
            )
            return None
        is_reference = hop.type == TYPE_IDENTITY
        # ADR-0039: resolving (get_meta_attr) — @cardinality may be inherited via extends.
        if not is_reference and hop.get_meta_attr(RELATIONSHIP_ATTR_CARDINALITY) != CARDINALITY_ONE:
            err(
                f"{named} crosses relationship '{hop_name}' on '{name_of(current)}', which is not to-one. "
                f"{walk.to_one_reason}"
            )
            return None
        # ADR-0039: resolving.
        target_ref = hop.get_meta_attr(
            IDENTITY_REFERENCE_ATTR_REFERENCES if is_reference else RELATIONSHIP_ATTR_OBJECT_REF
        )
        # ADR-0042 — a hop target resolves in the package of the entity declaring the hop.
        target = resolve_object_ref(root, target_ref, _pkg_of(current)) if isinstance(target_ref, str) else None
        if target is None:
            err(f"{named} hop '{hop_name}' on '{name_of(current)}' targets no object.")
            return None
        current = target
    return current


def _check_measure(ctx: _MemberCtx, measure: MetaMeasure) -> None:
    def err(message: str) -> None:
        ctx.sink.push(measure, _ERR_INVALID_MEASURE, ctx.label, f": {message}", ctx.suffix)

    # The type rule — a measure's @default is a whole number. The attr-schema pass already
    # refuses a fraction (and a non-number) with ERR_BAD_ATTR_VALUE on this node (see the
    # module docstring), so nothing is reported here. A fraction only skips M7/M8: one
    # mistake, one error. ``bool`` is not a number here, as in the reference (it is the
    # type error, and M7/M8 still read the attribute as present).
    # ADR-0039: resolving (get_meta_attr) — the raw attribute, inherited or not.
    declared_default = measure.get_meta_attr(REPORTING_ATTR_DEFAULT)
    fractional_default = isinstance(declared_default, float) and not declared_default.is_integer()

    if measure.is_ratio():
        _check_ratio_operands(ctx, measure, err)
        return
    if measure.sub_type != MEASURE_SUBTYPE_AGGREGATE:
        return

    checked = _check_aggregate_columns(ctx, measure, err)

    # M7 / M8 — where a @default can apply. Only when M1–M4 passed and the @default is
    # not a fraction: one mistake, one error. The presence test reads the raw attribute,
    # so a non-number value on a count still reports M7 beside the attribute type error.
    if checked is not None and not fractional_default and declared_default is not None:
        agg = measure.agg()
        of_field = checked.field
        if agg == AGG_COUNT:
            err(
                "@default cannot apply to @agg: count. A count is never null (it is 0 when nothing matches); "
                "remove @default."
            )
        elif agg in (AGG_MIN, AGG_MAX) and of_field is not None and of_field.sub_type not in _NUMERIC_FIELD_SUBTYPES:
            err(
                f"@default is a number, but '{measure.of_columns()[0]}', the @of of @agg '{agg}', is a "
                f"field.{of_field.sub_type}. A default is supported on numeric measures only."
            )

    # M5 — @segment names a segment of the owning entity.
    segment = measure.segment_name()
    if segment is not None and _child_of_type(ctx.host, TYPE_SEGMENT, segment) is None:
        err(f"@segment '{segment}' names no segment of '{ctx.declaring.resolution_key()}'.")

    # S1 / F2 — the measure's own row scope.
    filter_value = measure.filter()
    if filter_value is not None:
        _check_filter(
            filter_value, ctx.host, ctx.declaring.resolution_key(), ctx.label, measure, ctx.suffix, ctx.sink
        )


@dataclass(frozen=True)
class _CheckedColumns:
    """M1–M4 passed. ``field`` is the single resolved @of field (``None`` for a tuple), for M7/M8."""

    field: MetaData | None


def _check_aggregate_columns(
    ctx: _MemberCtx, measure: MetaMeasure, err: Callable[[str], None]
) -> _CheckedColumns | None:
    """M1–M4, in order; the first failure stops the chain (no M2+M3 double report).
    Returns ``None`` when one of them fired."""
    agg = measure.agg()
    columns = measure.of_columns()

    # M1 — every @of item is a field of the owning entity.
    fields: list[MetaData] = []
    for item in columns:
        parts = _split_dotted(item)
        if parts is None or len(parts.path) != 1:
            err(f"@of '{item}' must be Entity.field.")
            return None
        named = resolve_object_ref(ctx.root, parts.owner, _pkg_of(ctx.declaring))
        if not _is_self_or_ancestor(named, ctx.host):
            err(
                f"@of '{item}' must name a field of the owning entity '{ctx.declaring.resolution_key()}'. "
                f"A measure aggregates its own entity's rows; declare it on the entity that owns the column."
            )
            return None
        field = _field_of(ctx.host, parts.path[0])
        if field is None:
            err(f"@of '{item}' names no field '{parts.path[0]}' on '{ctx.declaring.resolution_key()}'.")
            return None
        fields.append(field)

    # M2 — a tuple is a distinct count only.
    if len(columns) > 1 and (agg != AGG_COUNT or not measure.distinct()):
        err(
            f"@of lists {len(columns)} columns; a tuple is legal only with @agg: count and @distinct: true "
            f"(a distinct count of the tuple)."
        )
        return None

    # M3 — @distinct is a count modifier.
    if measure.distinct() and agg is not None and agg != AGG_COUNT:
        err(f"@distinct: true requires @agg: count, not '{agg}'.")
        return None

    # M4 — the aggregate must be meaningful for the column's type.
    field = fields[0] if len(fields) == 1 else None
    if field is None or agg is None:
        return _CheckedColumns(field)
    item = columns[0]
    if agg in (AGG_SUM, AGG_AVG) and field.sub_type not in _NUMERIC_FIELD_SUBTYPES:
        err(
            f"@agg '{agg}' needs a numeric field (field.int, long, double, float, decimal or currency), "
            f"but '{item}' is field.{field.sub_type}."
        )
        return None
    if agg in (AGG_MIN, AGG_MAX) and field.sub_type in _UNORDERED_FIELD_SUBTYPES:
        err(f"@agg '{agg}' cannot order '{item}', a field.{field.sub_type}.")
        return None
    return _CheckedColumns(field)


def _check_ratio_operands(ctx: _MemberCtx, ratio: MetaMeasure, err: Callable[[str], None]) -> None:
    """M6 — each operand names a measure.aggregate of the same entity."""
    operands: list[tuple[str, str | None]] = [
        (REPORTING_ATTR_NUMERATOR, ratio.numerator()),
        (REPORTING_ATTR_DENOMINATOR, ratio.denominator()),
    ]
    for attr_name, ref in operands:
        if ref is None:
            continue  # missing operand is ERR_MISSING_REQUIRED_ATTR
        target = _child_of_type(ctx.host, TYPE_MEASURE, ref)
        if target is None:
            err(f"@{attr_name} '{ref}' names no measure of '{ctx.declaring.resolution_key()}'.")
        elif target.sub_type != MEASURE_SUBTYPE_AGGREGATE:
            err(
                f"@{attr_name} '{ref}' is a measure.{target.sub_type}; a ratio's operands must be measure.aggregate "
                f"(a ratio of ratios is not supported)."
            )


# ---------------------------------------------------------------------------
# S1 / F2 — a reporting-host @filter over its entity
# ---------------------------------------------------------------------------


def _check_filter(
    filter_value: dict[str, object],
    entity: MetaData,
    entity_key: str,
    host_label: str,
    host: MetaData,
    suffix: str,
    sink: _ErrorSink,
) -> None:
    """Validate a canonical (post-desugar) attr.filter against ``entity``'s fields:
    every key names a field (S1), every op is legal for that field (S1), and a
    relative-date operand sits on a date/timestamp, under a range op, with a valid
    ISO-8601 duration (F2). One error per offending clause op."""

    def err(message: str) -> None:
        sink.push(host, _ERR_BAD_ATTR_FILTER, host_label, f": {message}", suffix)

    for key, clause in filter_value.items():
        if key == _FILTER_COMPOSE_OR or key == _FILTER_COMPOSE_AND:
            if not isinstance(clause, list):
                err(f"@filter '{key}' must be an array of sub-clauses.")
                continue
            for sub in clause:
                if isinstance(sub, dict):
                    _check_filter(sub, entity, entity_key, host_label, host, suffix, sink)
                else:
                    err(f"@filter '{key}' contains a non-object sub-clause.")
            continue
        field = _field_of(entity, key)
        if field is None:
            err(f"@filter names '{key}', which is not a field of '{entity_key}'.")
            continue
        if not isinstance(clause, dict) or len(clause) == 0:
            err(f"@filter on '{key}' must be an {{ op: value }} object.")
            continue
        allowed = _ops_for_field_ordered(field)
        for op, operand in clause.items():
            if op not in allowed:
                err(
                    f"@filter on '{key}' uses op '{op}', which is not allowed for field.{field.sub_type}. "
                    f"Allowed ops: {', '.join(allowed) or '(none)'}."
                )
                continue
            relative = _relative_operand(operand)
            if relative is None:
                continue
            if len(relative) != 1:
                err(
                    f"@filter on '{key}' has a malformed relative date {_js_json(relative)}; a relative date is "
                    f'exactly {{ now: "<ISO-8601 duration>" }} with no other keys.'
                )
                continue
            if field.sub_type not in _TEMPORAL_FIELD_SUBTYPES:
                err(
                    f"@filter on '{key}' uses a relative date ({{ now: ... }}), but '{key}' is field.{field.sub_type}; "
                    f"relative dates apply only to field.date and field.timestamp."
                )
                continue
            if op not in _RELATIVE_DATE_OPS:
                err(
                    f"@filter on '{key}' puts a relative date under op '{op}'; relative dates are legal only under "
                    f"gt, gte, lt and lte."
                )
                continue
            duration = relative[FILTER_RELATIVE_NOW]
            if not isinstance(duration, str) or ISO_DURATION_RE.match(duration) is None:
                err(
                    f"@filter on '{key}' has relative date '{_quote_value(duration)}', which is not an ISO-8601 "
                    f"duration (e.g. '-P7D', '-PT12H')."
                )


# ---------------------------------------------------------------------------
# R1–R9 — object.report
# ---------------------------------------------------------------------------


def _check_report(root: MetaData, report: MetaData, sink: _ErrorSink) -> None:
    label = f"report '{report.resolution_key()}'"

    def err(message: str, node: MetaData = report, code: ErrorCode = _ERR_INVALID_REPORT) -> None:
        sink.push(node, code, label, message)

    # R4 — a report's fields and identity are derived, never declared.
    # ADR-0039: own — the rule is about what the author declared on THIS report.
    for child in report.own_children():
        if child.type == TYPE_FIELD or child.type == TYPE_IDENTITY:
            err(
                f" declares {_child_label(child)}; a report's fields and identity are derived "
                f"from @dimensions and @measures, never declared.",
                child,
            )

    # R5 — a report is read-only, so any source it has is read-only.
    # ADR-0039: resolving — an inherited source binds the report just the same.
    for source in (c for c in report.children() if c.type == TYPE_SOURCE):
        if isinstance(source, MetaSource) and source.is_writable():
            err(
                f": {_child_label(source)} is writable; a report is read-only, so its source must "
                f"declare a read-only @kind (view, materializedView, storedProc or tableFunction).",
                source,
            )

    # R1 — @from resolves to an object.entity. Without it, R2/R3/R6/R7, R8/R9 and
    # the @filter have nothing to resolve against, so they are skipped.
    from_ref = report_from(report)
    if from_ref is None:
        return  # missing @from is ERR_MISSING_REQUIRED_ATTR
    from_ = resolve_object_ref(root, from_ref, _pkg_of(report))
    if from_ is None:
        err(f": @from '{from_ref}' does not resolve to an object.")
        return
    if from_.type != TYPE_OBJECT or from_.sub_type != OBJECT_SUBTYPE_ENTITY:
        err(f": @from '{from_ref}' is an {from_.type}.{from_.sub_type}; a report aggregates the rows of an object.entity.")
        return
    from_key = from_.resolution_key()

    # R6 — derived field name -> the item that derived it ("dimension item 'x'" / "measure 'y'").
    derived: dict[str, str] = {}

    def claim(field_name: str, what: str) -> None:
        prior = derived.get(field_name)
        if prior == what:
            # The same measure listed twice: name the repeat, not a "collision" with itself.
            err(f": @measures lists '{field_name}' more than once.")
            return
        if prior is not None:
            err(
                f": {prior} and {what} both derive report field '{field_name}'. Report field names must be unique; "
                f"rename the measure or drop one item."
            )
            return
        derived[field_name] = what

    # R2 — each @dimensions item names a dimension of @from, with a grain exactly when it is a time dimension.
    seen_items: set[str] = set()
    for item in report_dimension_items(report):
        raw = item.name if item.grain is None else f"{item.name}{REPORT_DIMENSION_GRAIN_SEPARATOR}{item.grain}"
        if raw in seen_items:
            err(f": @dimensions lists '{raw}' more than once.")
            continue
        seen_items.add(raw)
        dim = _child_of_type(from_, TYPE_DIMENSION, item.name)
        if not isinstance(dim, MetaDimension):
            err(f": @dimensions item '{raw}' names no dimension of @from '{from_key}'.")
            continue
        if dim.is_time():
            grains = dim.grains()
            if item.grain is None:
                err(
                    f": @dimensions item '{raw}' names time dimension '{item.name}' without a grain; write "
                    f"'{item.name}:<grain>' with a grain from its @grains ({', '.join(grains)})."
                )
                continue
            if item.grain not in grains:
                err(
                    f": @dimensions item '{raw}' uses grain '{item.grain}', which time dimension '{item.name}' does not "
                    f"declare. Its @grains: {', '.join(grains)}."
                )
                continue
        elif item.grain is not None:
            err(
                f": @dimensions item '{raw}' gives a grain to attribute dimension '{item.name}'; only a time "
                f"dimension takes a grain."
            )
            continue
        claim(report_derived_field_name(item), f"dimension item '{raw}'")

    # R3 — each @measures item names a measure of @from.
    for measure_item in report_measure_names(report):
        measure_name = _check_report_measure(root, report, from_, measure_item, label, sink)
        if measure_name is not None:
            claim(measure_name, f"measure '{measure_name}'")

    # R7 — @segment names a segment of @from.
    # ADR-0039: resolving (get_meta_attr — Python attr() is own-only).
    segment = report.get_meta_attr(OBJECT_REPORT_ATTR_SEGMENT)
    if isinstance(segment, str) and _child_of_type(from_, TYPE_SEGMENT, segment) is None:
        err(f": @segment '{segment}' names no segment of @from '{from_key}'.")

    # R8 — @spine is a to-one path from @from: rule D2's walk, started at @from.
    spine = report_spine(report)
    if spine is not None:
        terminal = _walk_to_one_via(
            root, from_, spine, lambda message: err(f": {message}"), _spine_walk(report, from_key)
        )
        # R9 — every listed dimension is reached through the spine. Skipped when R8 failed.
        if terminal is not None:
            _check_spine_dimensions(root, report, from_, spine, terminal, err)

    # S1 / F2 — the report's row scope over @from.

    # ADR-0039: resolving.
    filter_value = report.get_meta_attr(OBJECT_REPORT_ATTR_FILTER)
    if isinstance(filter_value, dict):
        _check_filter(filter_value, from_, from_key, label, report, "", sink)


def _check_spine_dimensions(
    root: MetaData,
    report: MetaData,
    from_: MetaData,
    spine: str,
    terminal: MetaData,
    err: Callable[[str], None],
) -> None:
    """R9 — every listed dimension is reached through the spine (``terminal`` is the
    entity R8's walk reached). ``err`` takes the message tail after the report label."""
    from_key = from_.resolution_key()
    spine_parts = _split_dotted(spine)
    spine_hops = spine_parts.path if spine_parts is not None else []
    items = report_dimension_items(report)
    if len(items) == 0:
        err(
            f": @spine '{spine}' needs at least one dimension. The report's rows are the dimension tuples of "
            f"'{terminal.resolution_key()}'; with no dimension it would be one totals row."
        )
    # One verdict per dimension, however many grains list it.
    checked_dimensions: set[str] = set()
    for item in items:
        if item.name in checked_dimensions:
            continue
        checked_dimensions.add(item.name)
        dim = _child_of_type(from_, TYPE_DIMENSION, item.name)
        if not isinstance(dim, MetaDimension):
            continue  # R2 already reported it
        via = dim.via()
        if via is None:
            err(
                f": dimension '{item.name}' is read from @from '{from_key}', so it has no value in a row that has "
                f"no facts. With @spine '{spine}' every dimension must be reached through it: declare the "
                f"dimension over a field of '{terminal.resolution_key()}' (or an entity to-one from it) with an "
                f"@via that begins '{spine}'."
            )
            continue
        # A @via that does not walk is D2's error, on the dimension; R9 does not report it again.
        declaring = dim.parent if dim.parent is not None else from_
        if _walk_to_one_via(root, from_, via, lambda _message: None, _d2_walk(declaring)) is None:
            continue
        # Hop names are compared as written; the owner segment is not compared.
        via_parts = _split_dotted(via)
        hops = via_parts.path if via_parts is not None else []
        if hops[: len(spine_hops)] == spine_hops:
            continue
        err(
            f": dimension '{item.name}' is reached by @via '{via}', which does not begin with the hops of "
            f"@spine '{spine}'. Hop names are compared as written: if both name the same join, write the same "
            f"hops; otherwise the dimension is not reached through the spine."
        )


def _check_report_measure(
    root: MetaData,
    report: MetaData,
    from_: MetaData,
    item: str,
    label: str,
    sink: _ErrorSink,
) -> str | None:
    """R3 for one ``@measures`` item (bare ``name`` or dotted ``Entity.name``). Returns
    the measure's name when it is a measure of @from (for R6), else reports
    ERR_REPORT_FOREIGN_MEASURE (it is another entity's measure) or ERR_INVALID_REPORT
    (it is nobody's) and returns ``None``."""
    from_key = from_.resolution_key()
    owner: MetaData | None
    parts = _split_dotted(item)
    if parts is not None and len(parts.path) == 1:
        owner = resolve_object_ref(root, parts.owner, _pkg_of(report))
        name = parts.path[0]
        if (
            owner is not None
            and _is_self_or_ancestor(owner, from_)
            and _child_of_type(from_, TYPE_MEASURE, name) is not None
        ):
            return name
        if owner is not None and _child_of_type(owner, TYPE_MEASURE, name) is None:
            owner = None
    elif CHILD_REF_SEP not in item:
        name = item
        if _child_of_type(from_, TYPE_MEASURE, name) is not None:
            return name
        # ADR-0039: root has no super; children()==own_children() but resolving is the default.
        owner = next(
            (
                o
                for o in root.children()
                if o.type == TYPE_OBJECT
                and o.sub_type == OBJECT_SUBTYPE_ENTITY
                and _child_of_type(o, TYPE_MEASURE, name) is not None
            ),
            None,
        )
    else:
        owner = None

    if owner is not None:
        owner_key = owner.resolution_key()
        sink.push(
            report,
            _ERR_REPORT_FOREIGN_MEASURE,
            label,
            f" lists measure '{item[item.rfind(CHILD_REF_SEP) + 1:]}', which belongs to "
            f"'{owner_key}', not @from '{from_key}'. All measures of a report come from @from; make a second "
            f"report over '{owner_key}'.",
        )
    else:
        sink.push(
            report,
            _ERR_INVALID_REPORT,
            label,
            f": @measures item '{item}' names no measure of @from '{from_key}' or of any other entity.",
        )
    return None


# ---------------------------------------------------------------------------
# F1 — relative-date values only on reporting hosts
# ---------------------------------------------------------------------------


def _is_reporting_filter_host(node: MetaData) -> bool:
    """True for the hosts whose ``@filter`` may carry a relative-date value."""
    return (
        node.type == TYPE_SEGMENT
        or (node.type == TYPE_MEASURE and node.sub_type == MEASURE_SUBTYPE_AGGREGATE)
        or (node.type == TYPE_OBJECT and node.sub_type == OBJECT_SUBTYPE_REPORT)
    )


def _check_no_relative_dates(node: MetaData, sink: _ErrorSink) -> None:
    """F1 — walk the whole tree and refuse a ``{ now: ... }`` value in any attr.filter
    outside a reporting host (a projection @filter, a dataGrid preset, an
    origin.aggregate/first @filter): those hosts have no lowering for it."""
    if not _is_reporting_filter_host(node):
        # ADR-0039: own — only locally declared filters are lowered, and the walk
        # visits every declared node exactly once (an inherited filter is checked
        # where it is declared; origin.* never inherits, ADR-0029).
        for attr in node.own_meta_attrs():
            if attr.sub_type == ATTR_SUBTYPE_FILTER and _filter_contains_relative_value(
                getattr(attr, "value", None)
            ):
                sink.push(
                    node,
                    _ERR_BAD_ATTR_FILTER,
                    _node_label(node),
                    f": @{attr.name} uses a relative date ({{ now: ... }}), which is legal only in the "
                    f"@filter of a segment, measure.aggregate or object.report.",
                )
    # ADR-0039: own — a tree walk; each declared node is visited once, at its declaration.
    for child in node.own_children():
        _check_no_relative_dates(child, sink)
