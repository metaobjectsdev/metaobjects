"""ADR-0063 — cross-node rules for operations (slice A) and lifecycles (slice B).

A rule-for-rule port of the TypeScript reference
``server/typescript/packages/metadata/src/loader/rules-validation.ts``. Every port implements
the same rules WITH THE SAME MESSAGE TEXT; the fixtures under ``fixtures/conformance/``
(``error-rules-*``, with the positive ``rules-*`` cases) are the contract.

One broken rule yields one error:

- Each error's source is the offending node: the transition, the enum field (L3), the entity
  (L2b), the operation or the binding.
- An operation whose @inputRef / @outputRef fails O1 is not checked further; one whose target
  fails O2 or O3 is not checked for O4 or O5.
- An error is reported once per (node, code), so a broken transition on an abstract base is
  reported once, not once per inheritor.

Rules:
  L1 ERR_TRANSITION_NOT_ON_ENTITY    a transition under an enum field not declared on an object.entity
  L2 ERR_TRANSITION_NOT_ON_ENTITY    a concrete entity with a lifecycle and no writable source (on the entity)
  L3 ERR_LIFECYCLE_NO_INITIAL        an enum field declaring transitions has no @default
  L4 ERR_TRANSITION_UNKNOWN_STATE    a @from or @to value is not one of the enum's @values
  L5 ERR_TRANSITION_NAME_COLLISION   a transition named create/get/list/update/delete
  L6 ERR_TRANSITION_NAME_COLLISION   two transitions of one entity (across its lifecycles) share a name
  L7 ERR_BAD_ATTR_VALUE              @condition names a field the entity does not have, or is not boolean
  P1 ERR_PERMISSION_PUBLIC_CONFLICT  @public: true with @permission (operation or transition)
  O0 ERR_TRANSITION_NAME_COLLISION   an operation named create/get/list/update/delete
  O1 ERR_OPERATION_SHAPE             @inputRef is not an object.value; @outputRef is not an entity, projection or value
  O2 ERR_OPERATION_TARGET_UNRESOLVED @objectRef is not an object.entity, or a command lists @transitions and
                                     no target is declared or derivable
  O3 ERR_OPERATION_TARGET_MISMATCH   a declared @objectRef disagrees with the derived target
  O4 ERR_OPERATION_UNKNOWN_TRANSITION a @transitions name is not a transition of the target
  O5 ERR_BAD_ATTR_VALUE              an @errors code is not lower snake case, or is listed twice
  B1 ERR_BINDING_PATH_MISMATCH       a binding.rest @path's placeholders are not the target's key fields
                                     (a keyed operation) or are not empty (an unkeyed one)

ADR-0039 NAMING INVERSION: Python ``attr()`` is OWN-ONLY. Every place the TS reference calls
the resolving ``attr()`` / ``children()``, this module calls ``get_meta_attr()`` /
``children()``. The ``own_children()`` uses carry their sanctioned case in a comment.
"""
from __future__ import annotations

import re

from ..errors import ErrorCode, MetaError
from ..meta.core.api.api_constants import (
    BINDING_ATTR_PATH,
    BINDING_SUBTYPE_REST,
    BUSINESS_ERROR_CODE_PATTERN,
    OPERATION_ATTR_ERRORS,
    OPERATION_ATTR_INPUT_REF,
    OPERATION_ATTR_OBJECT_REF,
    OPERATION_ATTR_OUTPUT_REF,
    OPERATION_ATTR_PERMISSION,
    OPERATION_ATTR_PUBLIC,
    OPERATION_ATTR_TRANSITIONS,
    OPERATION_SUBTYPE_COMMAND,
    RESERVED_OPERATION_NAMES,
)
from ..meta.core.field.field_constants import (
    FIELD_ATTR_DEFAULT,
    FIELD_ATTR_VALUES,
    FIELD_SUBTYPE_ENUM,
)
from ..meta.core.object.object_constants import (
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_PROJECTION,
    OBJECT_SUBTYPE_VALUE,
)
from ..meta.core.transition.lifecycle import (
    derive_operation_target,
    entity_transitions,
    operation_is_keyed,
    primary_key_fields,
    resolve_object_on,
    string_list,
    transition_from,
    transition_to,
)
from ..meta.core.transition.transition_constants import (
    TRANSITION_ATTR_CONDITION,
    TRANSITION_SUBTYPE_ACTION,
)
from ..meta.meta_data import MetaData
from ..meta.persistence.source.meta_source import MetaSource
from ..shared.base_types import (
    TYPE_API,
    TYPE_BINDING,
    TYPE_FIELD,
    TYPE_OBJECT,
    TYPE_OPERATION,
    TYPE_SOURCE,
    TYPE_TRANSITION,
)

_RESERVED = frozenset(RESERVED_OPERATION_NAMES)
_RESERVED_LIST = ", ".join(RESERVED_OPERATION_NAMES)
_PLACEHOLDER_RE = re.compile(r"\{([^}]*)\}")


def _label(node: MetaData) -> str:
    """``"Entity.field.transition"`` for a transition, ``"Api.operation"`` for an operation."""
    parts: list[str] = []
    n: MetaData | None = node
    # A binding is unnamed: its label is its operation's.
    while n is not None and n.parent is not None:
        if n.name != "":
            parts.insert(0, n.name)
        n = n.parent
    return ".".join(parts)


def _quote_list(xs: list[str]) -> str:
    return ", ".join(f'"{x}"' for x in xs)


def _unique(xs: list[str]) -> list[str]:
    return list(dict.fromkeys(xs))


class _Sink:
    def __init__(self, errors: list[MetaError]) -> None:
        self.errors = errors
        self._seen: set[tuple[int, ErrorCode]] = set()

    def add(self, node: MetaData, code: ErrorCode, message: str) -> None:
        key = (id(node), code)
        if key in self._seen:
            return
        self._seen.add(key)
        self.errors.append(MetaError(code=code, message=message, envelope=node.source))


def _check_permission_public(node: MetaData, sink: _Sink) -> None:
    if (
        node.get_meta_attr(OPERATION_ATTR_PUBLIC) is True
        and node.get_meta_attr(OPERATION_ATTR_PERMISSION) is not None
    ):
        sink.add(
            node,
            ErrorCode.ERR_PERMISSION_PUBLIC_CONFLICT,
            f'{node.type}.{node.sub_type} "{_label(node)}" declares both @public: true and @permission; '
            f"a public {node.type} calls no permission check, so remove one.",
        )


def _check_declared_transitions(field: MetaData, sink: _Sink) -> None:
    """L1, L3, L4, L5, L7 and P1 for the transitions declared on one field."""
    from .validation_passes import condition_message

    # ADR-0039 sanctioned own: each transition is checked where it is declared.
    declared = [
        c for c in field.own_children()
        if c.type == TYPE_TRANSITION and c.sub_type == TRANSITION_SUBTYPE_ACTION
    ]
    if not declared:
        return
    owner = field.parent
    if owner is None or owner.type != TYPE_OBJECT or owner.sub_type != OBJECT_SUBTYPE_ENTITY:
        where = (
            "the document root"
            if owner is None or owner.type != TYPE_OBJECT
            else f'object.{owner.sub_type} "{owner.name}"'
        )
        for t in declared:
            sink.add(
                t,
                ErrorCode.ERR_TRANSITION_NOT_ON_ENTITY,
                f'transition.action "{_label(t)}" is declared on a field of {where}; '
                "a lifecycle belongs to an object.entity with a writable source.",
            )
        return
    if field.sub_type == FIELD_SUBTYPE_ENUM and not isinstance(field.get_meta_attr(FIELD_ATTR_DEFAULT), str):
        sink.add(
            field,
            ErrorCode.ERR_LIFECYCLE_NO_INITIAL,
            f'field.enum "{_label(field)}" declares transitions but no @default; '
            "its @default is the lifecycle's initial state.",
        )
    states = _unique(string_list(field, FIELD_ATTR_VALUES))
    for t in declared:
        _check_permission_public(t, sink)
        to = transition_to(t)
        unknown = [s for s in _unique([*transition_from(t), *([] if to is None else [to])]) if s not in states]
        if unknown:
            sink.add(
                t,
                ErrorCode.ERR_TRANSITION_UNKNOWN_STATE,
                f'transition.action "{_label(t)}" names {_quote_list(unknown)}, which '
                f'{"is not a member" if len(unknown) == 1 else "are not members"} of "{field.name}" '
                f"@values ({_quote_list(states)}).",
            )
        if t.name in _RESERVED:
            sink.add(
                t,
                ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                f'transition.action "{_label(t)}" is named "{t.name}", which is a derived CRUD verb '
                f"({_RESERVED_LIST}); rename it.",
            )
        condition = t.get_meta_attr(TRANSITION_ATTR_CONDITION)
        if condition is not None:
            message = condition_message(condition, owner, f'transition.action "{_label(t)}" @condition')
            if message is not None:
                sink.add(t, ErrorCode.ERR_BAD_ATTR_VALUE, message)


def _declared_fields(root: MetaData) -> list[MetaData]:
    """Every field declared in the tree: at the root and on every object."""
    out: list[MetaData] = []
    # ADR-0039 sanctioned own: a structural walk over the declarations themselves.
    for top in root.own_children():
        if top.type == TYPE_FIELD:
            out.append(top)
        elif top.type == TYPE_OBJECT:
            out.extend(c for c in top.own_children() if c.type == TYPE_FIELD)
    return out


def _check_entity_lifecycles(entity: MetaData, sink: _Sink) -> None:
    """L2 and L6 for one entity, over its effective (inherited) lifecycles."""
    transitions = entity_transitions(entity)
    if not transitions:
        return
    by_name: dict[str, MetaData] = {}
    for t in transitions:
        first = by_name.get(t.name)
        if first is None:
            by_name[t.name] = t
        elif first is not t:
            sink.add(
                t,
                ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                f'transition.action "{_label(t)}" has the same name as "{_label(first)}"; the transitions of '
                f'"{entity.name}" share one namespace (each may derive a command), so rename one.',
            )
    if not entity.is_abstract and not any(
        c.type == TYPE_SOURCE and isinstance(c, MetaSource) and c.is_writable() for c in entity.children()
    ):
        owners = _unique([t.parent.name if t.parent is not None else "" for t in transitions])
        sink.add(
            entity,
            ErrorCode.ERR_TRANSITION_NOT_ON_ENTITY,
            f'object.entity "{entity.name}" has a lifecycle (transitions on {_quote_list(owners)}) but no '
            "writable source; a transition is a guarded update of a stored row.",
        )


def _check_operation(op: MetaData, sink: _Sink) -> None:
    """O0-O5, P1 and B1 for one operation."""
    if op.name in _RESERVED:
        sink.add(
            op,
            ErrorCode.ERR_TRANSITION_NAME_COLLISION,
            f'operation.{op.sub_type} "{_label(op)}" is named "{op.name}", which is a derived CRUD verb '
            f"({_RESERVED_LIST}); rename it.",
        )
    _check_permission_public(op, sink)

    error_codes = string_list(op, OPERATION_ATTR_ERRORS)
    bad = [c for c in error_codes if not BUSINESS_ERROR_CODE_PATTERN.fullmatch(c)]
    dup = [c for i, c in enumerate(error_codes) if error_codes.index(c) != i]
    if bad or dup:
        if bad:
            why = (
                f'{_quote_list(bad)} {"is not a" if len(bad) == 1 else "are not"} lower snake case '
                f'code{"" if len(bad) == 1 else "s"}'
            )
        else:
            uniq = _unique(dup)
            why = f'{_quote_list(uniq)} {"is" if len(uniq) == 1 else "are"} listed twice'
        sink.add(op, ErrorCode.ERR_BAD_ATTR_VALUE, f'operation.{op.sub_type} "{_label(op)}" @errors: {why}.')

    # O1 — shapes.
    input_ref = op.get_meta_attr(OPERATION_ATTR_INPUT_REF)
    if isinstance(input_ref, str):
        inp = resolve_object_on(op, input_ref)
        if inp is None or inp.sub_type != OBJECT_SUBTYPE_VALUE:
            what = "names no object" if inp is None else f"is an object.{inp.sub_type}"
            sink.add(
                op,
                ErrorCode.ERR_OPERATION_SHAPE,
                f'operation.{op.sub_type} "{_label(op)}" @inputRef "{input_ref}" {what}; '
                "an operation's input is an object.value.",
            )
            return
    output_ref = op.get_meta_attr(OPERATION_ATTR_OUTPUT_REF)
    if isinstance(output_ref, str):
        out = resolve_object_on(op, output_ref)
        legal = out is not None and out.sub_type in (
            OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_PROJECTION, OBJECT_SUBTYPE_VALUE,
        )
        if not legal:
            what = "names no object" if out is None else f"is an object.{out.sub_type}"
            sink.add(
                op,
                ErrorCode.ERR_OPERATION_SHAPE,
                f'operation.{op.sub_type} "{_label(op)}" @outputRef "{output_ref}" {what}; '
                "an operation returns an object.entity, object.projection or object.value.",
            )
            return

    # O2, O3 — the target.
    derived_target = derive_operation_target(op)
    derived = derived_target.entity if derived_target is not None else None
    target = derived
    object_ref = op.get_meta_attr(OPERATION_ATTR_OBJECT_REF)
    if isinstance(object_ref, str):
        declared = resolve_object_on(op, object_ref)
        if declared is None or declared.sub_type != OBJECT_SUBTYPE_ENTITY:
            what = "names no object" if declared is None else f"is an object.{declared.sub_type}"
            sink.add(
                op,
                ErrorCode.ERR_OPERATION_TARGET_UNRESOLVED,
                f'operation.{op.sub_type} "{_label(op)}" @objectRef "{object_ref}" {what}; '
                "an operation acts on an object.entity.",
            )
            return
        if derived is not None and derived is not declared:
            sink.add(
                op,
                ErrorCode.ERR_OPERATION_TARGET_MISMATCH,
                f'operation.{op.sub_type} "{_label(op)}" @objectRef names "{declared.name}", but its input and '
                f'output derive "{derived.name}"; remove @objectRef or make them agree.',
            )
            return
        target = declared
    transitions = string_list(op, OPERATION_ATTR_TRANSITIONS) if op.sub_type == OPERATION_SUBTYPE_COMMAND else []
    if transitions and target is None:
        sink.add(
            op,
            ErrorCode.ERR_OPERATION_TARGET_UNRESOLVED,
            f'operation.command "{_label(op)}" lists @transitions but has no target entity: no @inputRef field '
            "extends an entity's primary key, no @outputRef has a base entity, and there is no @objectRef.",
        )
        return

    # O4 — the transitions it may make.
    if target is not None and transitions:
        known = {t.name for t in entity_transitions(target)}
        unknown = [n for n in _unique(transitions) if n not in known]
        if unknown:
            sink.add(
                op,
                ErrorCode.ERR_OPERATION_UNKNOWN_TRANSITION,
                f'operation.command "{_label(op)}" @transitions names {_quote_list(unknown)}, which '
                f'{"is not a transition" if len(unknown) == 1 else "are not transitions"} of "{target.name}".',
            )

    # B1 — binding paths.
    # ADR-0039 sanctioned own: a binding is checked on the operation that declares it.
    for b in op.own_children():
        if b.type != TYPE_BINDING or b.sub_type != BINDING_SUBTYPE_REST:
            continue
        path = b.get_meta_attr(BINDING_ATTR_PATH)
        if not isinstance(path, str):
            continue
        placeholders = _PLACEHOLDER_RE.findall(path)
        expected = primary_key_fields(target) if target is not None and operation_is_keyed(op) else []
        if sorted(placeholders) != sorted(expected):
            if not expected:
                tail = f'"{_label(op)}" addresses no row by key, so its path takes none.'
            else:
                tail = (
                    f'"{_label(op)}" addresses one "{target.name}" by key, so its path takes exactly '  # type: ignore[union-attr]
                    f"[{_quote_list(expected)}]."
                )
            sink.add(
                b,
                ErrorCode.ERR_BINDING_PATH_MISMATCH,
                f'binding.rest on "{_label(b)}" @path "{path}" has placeholders [{_quote_list(placeholders)}]; '
                + tail,
            )


def validate_rules(root: MetaData, errors: list[MetaError]) -> None:
    """ADR-0063 — the rules pass. Runs after reference-bearing validation, before freeze."""
    sink = _Sink(errors)
    for field in _declared_fields(root):
        _check_declared_transitions(field, sink)
    for obj in root.children():
        if obj.type == TYPE_OBJECT and obj.sub_type == OBJECT_SUBTYPE_ENTITY:
            _check_entity_lifecycles(obj, sink)
    for api in root.children():
        if api.type != TYPE_API:
            continue
        for op in api.children():
            if op.type == TYPE_OPERATION:
                _check_operation(op, sink)
