"""Lifecycle and operation-target derivation (ADR-0066), shared by the loader's rules pass
and ``verify``'s rules gate. Everything here is DERIVED: a lifecycle, its states, its initial
and terminal states and an operation's target entity have no vocabulary of their own. Every
port implements these rules the same way. Mirrors TS ``core/transition/lifecycle.ts``.

Reads are RESOLVING (ADR-0039): a transition declared on a base entity's field is a
transition of every entity that extends it. Python ``attr()`` is OWN-ONLY, so every attr
read here goes through ``get_meta_attr()``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ....naming_refs import (
    CHILD_REF_SEP,
    effective_package_of,
    resolve_object_ref,
    top_level_node_of,
)
from ....shared.base_types import TYPE_FIELD, TYPE_IDENTITY, TYPE_OBJECT, TYPE_SOURCE, TYPE_TRANSITION
from ....shared.separators import PACKAGE_SEP
from ...meta_data import MetaData
from ..api.api_constants import (
    OPERATION_ATTR_INPUT_REF,
    OPERATION_ATTR_MANY,
    OPERATION_ATTR_OBJECT_REF,
    OPERATION_ATTR_OUTPUT_REF,
    OPERATION_SUBTYPE_QUERY,
)
from ..field.field_constants import FIELD_ATTR_DEFAULT, FIELD_ATTR_VALUES, FIELD_SUBTYPE_ENUM
from ..identity.identity_constants import IDENTITY_ATTR_FIELDS, IDENTITY_SUBTYPE_PRIMARY
from ..object.object_constants import (
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_PROJECTION,
    OBJECT_SUBTYPE_VALUE,
)
from .transition_constants import TRANSITION_ATTR_FROM, TRANSITION_ATTR_TO, TRANSITION_SUBTYPE_ACTION


def string_list(node: MetaData, attr: str) -> list[str]:
    """A string-array attr read resolving; a bare string is ONE element."""
    v = node.get_meta_attr(attr)  # ADR-0039: resolving
    if isinstance(v, list):
        return [x for x in v if isinstance(x, str)]
    return [v] if isinstance(v, str) else []


def _string_value(node: MetaData, attr: str) -> Optional[str]:
    v = node.get_meta_attr(attr)  # ADR-0039: resolving
    return v if isinstance(v, str) else None


def transitions_of(field: MetaData) -> list[MetaData]:
    """The ``transition.action`` children of a field, resolving."""
    return [
        c for c in field.children()
        if c.type == TYPE_TRANSITION and c.sub_type == TRANSITION_SUBTYPE_ACTION
    ]


def entity_lineage(entity: MetaData) -> list[MetaData]:
    """An entity and every entity it extends, nearest first."""
    out: list[MetaData] = []
    e: Optional[MetaData] = entity
    while e is not None and e not in out:
        out.append(e)
        e = e.super_data
    return out


def lifecycle_transitions_of(entity: MetaData, field: MetaData) -> list[MetaData]:
    """The transitions a field gives an entity: those declared on a field of the entity itself
    or of an entity it extends. A transition reached only through the field's own ``extends``
    of another entity's field is not one (ADR-0066 section 2)."""
    lineage = entity_lineage(entity)
    out: list[MetaData] = []
    for t in transitions_of(field):
        owner = t.parent.parent if t.parent is not None else None
        if owner is not None and owner in lineage:
            out.append(t)
    return out


@dataclass(frozen=True)
class Lifecycle:
    """One lifecycle of an entity: an enum field with at least one transition."""

    field: MetaData
    #: The enum's @values, in declaration order.
    states: tuple[str, ...]
    #: The enum's @default; None only on a model the loader refused.
    initial: Optional[str]
    transitions: tuple[MetaData, ...]


def lifecycles_of(obj: MetaData) -> list[Lifecycle]:
    """The lifecycles of an object, in effective field order. Only an ``object.entity`` has any."""
    if obj.type != TYPE_OBJECT or obj.sub_type != OBJECT_SUBTYPE_ENTITY:
        return []
    out: list[Lifecycle] = []
    for field in obj.children():
        if field.type != TYPE_FIELD or field.sub_type != FIELD_SUBTYPE_ENUM:
            continue
        transitions = lifecycle_transitions_of(obj, field)
        if not transitions:
            continue
        initial = field.get_meta_attr(FIELD_ATTR_DEFAULT)  # ADR-0039: resolving
        out.append(Lifecycle(
            field=field,
            states=tuple(string_list(field, FIELD_ATTR_VALUES)),
            initial=initial if isinstance(initial, str) else None,
            transitions=tuple(transitions),
        ))
    return out


def lifecycle_is_live(entity: MetaData) -> bool:
    """Whether an entity's lifecycles are live: it declares or inherits a source (RESOLVING
    ``children()``, ADR-0039). A lifecycle on an entity with no source loads and is inert: it
    derives no command (ADR-0066 section 2)."""
    return any(c.type == TYPE_SOURCE for c in entity.children())


def entity_transitions(obj: MetaData) -> list[MetaData]:
    """Every transition of an entity, across all its lifecycles."""
    return [t for l in lifecycles_of(obj) for t in l.transitions]


def transition_from(t: MetaData) -> list[str]:
    """A transition's @from (resolving)."""
    return string_list(t, TRANSITION_ATTR_FROM)


def transition_to(t: MetaData) -> Optional[str]:
    """A transition's @to (resolving)."""
    return _string_value(t, TRANSITION_ATTR_TO)


def reachable_states(l: Lifecycle) -> set[str]:
    """The states reachable from the initial state, following every transition."""
    seen: set[str] = set()
    if l.initial is None:
        return seen
    queue = [l.initial]
    seen.add(l.initial)
    while queue:
        s = queue.pop(0)
        for t in l.transitions:
            to = transition_to(t)
            if to is not None and s in transition_from(t) and to not in seen:
                seen.add(to)
                queue.append(to)
    return seen


def terminal_states(l: Lifecycle) -> list[str]:
    """The members no transition leaves (a self-transition counts as leaving)."""
    leaving = {s for t in l.transitions for s in transition_from(t)}
    return [s for s in l.states if s not in leaving]


def primary_key_fields(entity: MetaData) -> list[str]:
    """The primary key field names of an entity: its effective ``identity.primary`` @fields."""
    primary = next(
        (c for c in entity.children() if c.type == TYPE_IDENTITY and c.sub_type == IDENTITY_SUBTYPE_PRIMARY),
        None,
    )
    return [] if primary is None else string_list(primary, IDENTITY_ATTR_FIELDS)


def referrer_package_of(node: MetaData) -> str:
    """The package a node's references resolve in: its top-level node's effective package."""
    return effective_package_of(top_level_node_of(node))


def _owner_of(ref: str) -> str:
    """The owner part of a reference: everything before the child dot of its last ``::`` segment."""
    last_sep = ref.rfind(PACKAGE_SEP)
    seg_start = 0 if last_sep < 0 else last_sep + len(PACKAGE_SEP)
    dot = ref.find(CHILD_REF_SEP, seg_start)
    return ref if dot < 0 else ref[:dot]


def resolve_object_on(node: MetaData, ref: str) -> Optional[MetaData]:
    """Resolve an object reference written on *node* (owner part only)."""
    return resolve_object_ref(node.root(), _owner_of(ref), referrer_package_of(node))


def _extended_member(f: MetaData) -> Optional[tuple[MetaData, str]]:
    """The object a field's ``extends`` NAMES, and the member it names there. ``id extends
    PurchaseRequest.id`` names PurchaseRequest even when PurchaseRequest inherits ``id`` from an
    abstract base, which is where the resolved super node physically lives."""
    ref = f.super_ref
    sup = f.super_data
    if ref is None or sup is None:
        return None
    last_sep = ref.rfind(PACKAGE_SEP)
    seg_start = 0 if last_sep < 0 else last_sep + len(PACKAGE_SEP)
    dot = ref.find(CHILD_REF_SEP, seg_start)
    if dot > seg_start:
        named = resolve_object_ref(f.root(), ref[:dot], referrer_package_of(f))
        if named is not None:
            return named, sup.name
    parent = sup.parent
    if parent is not None and parent.type == TYPE_OBJECT:
        return parent, sup.name
    return None


def _borrowed_key_entities(value: MetaData) -> list[MetaData]:
    """The entities whose whole primary key a value object borrows, once: every primary key
    field of the ``object.entity`` is extended by exactly one field of the value. Part of a
    composite key, or one key field borrowed twice, names no single row, so borrows nothing."""
    counts: dict[MetaData, dict[str, int]] = {}
    for f in value.children():
        if f.type != TYPE_FIELD:
            continue
        ext = _extended_member(f)
        if ext is None or ext[0].sub_type != OBJECT_SUBTYPE_ENTITY:
            continue
        owner, member = ext
        if member not in primary_key_fields(owner):
            continue
        members = counts.setdefault(owner, {})
        members[member] = members.get(member, 0) + 1
    return [
        owner for owner, members in counts.items()
        if all(members.get(k) == 1 for k in primary_key_fields(owner))
    ]


def projection_base_entity(projection: MetaData) -> Optional[MetaData]:
    """The base entity of a projection: the entity its extended identity names, else the one
    entity its extended fields name. None when there is none or more than one."""
    for ident in projection.children():
        if ident.type != TYPE_IDENTITY:
            continue
        ext = _extended_member(ident)
        if ext is not None and ext[0].sub_type == OBJECT_SUBTYPE_ENTITY:
            return ext[0]
    owners: list[MetaData] = []
    for f in projection.children():
        if f.type != TYPE_FIELD:
            continue
        ext = _extended_member(f)
        if ext is not None and ext[0].sub_type == OBJECT_SUBTYPE_ENTITY and ext[0] not in owners:
            owners.append(ext[0])
    return owners[0] if len(owners) == 1 else None


@dataclass(frozen=True)
class DerivedTarget:
    """How an operation's target was derived. ``via == "input"`` means the input borrows the
    target's key."""

    entity: MetaData
    via: str


def derive_operation_target(op: MetaData) -> Optional[DerivedTarget]:
    """The target entity derived from an operation's shapes, or None:

    1. the one entity whose whole primary key the ``@inputRef`` value borrows (by ``extends``),
       each key field once;
    2. else the ``@outputRef``: an entity is its own target, a projection its base entity.

    Whole keys of two entities, part of a key, or one key field borrowed twice derive nothing
    from the input.
    """
    input_ref = _string_value(op, OPERATION_ATTR_INPUT_REF)
    if input_ref is not None:
        inp = resolve_object_on(op, input_ref)
        if inp is not None and inp.sub_type == OBJECT_SUBTYPE_VALUE:
            borrowed = _borrowed_key_entities(inp)
            if len(borrowed) == 1:
                return DerivedTarget(borrowed[0], "input")
    output_ref = _string_value(op, OPERATION_ATTR_OUTPUT_REF)
    if output_ref is not None:
        out = resolve_object_on(op, output_ref)
        if out is not None and out.sub_type == OBJECT_SUBTYPE_ENTITY:
            return DerivedTarget(out, "output")
        if out is not None and out.sub_type == OBJECT_SUBTYPE_PROJECTION:
            base = projection_base_entity(out)
            if base is not None:
                return DerivedTarget(base, "output")
    return None


def operation_target(op: MetaData) -> Optional[MetaData]:
    """The operation's target: the declared ``@objectRef`` when it names an entity, else the
    derived one."""
    declared = _string_value(op, OPERATION_ATTR_OBJECT_REF)
    if declared is not None:
        node = resolve_object_on(op, declared)
        return node if node is not None and node.sub_type == OBJECT_SUBTYPE_ENTITY else None
    derived = derive_operation_target(op)
    return derived.entity if derived is not None else None


def operation_is_keyed(op: MetaData) -> bool:
    """Whether the operation addresses one row of its target by key, so its derived path is
    ``/<collection>/{key}/<operation>``: its input borrows the target's key, or it is a query
    with no input and no @many whose target comes from its output (a get by key)."""
    derived = derive_operation_target(op)
    if derived is None:
        return False
    if derived.via == "input":
        return True
    return (
        op.sub_type == OPERATION_SUBTYPE_QUERY
        and _string_value(op, OPERATION_ATTR_INPUT_REF) is None
        and op.get_meta_attr(OPERATION_ATTR_MANY) is not True
    )
