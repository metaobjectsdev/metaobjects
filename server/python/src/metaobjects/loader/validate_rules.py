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
  L2 ERR_TRANSITION_NOT_ON_ENTITY    a concrete entity with a lifecycle and a source, none of them writable
                                     (on the entity). An entity with no source at all is inert: its
                                     lifecycle loads and derives nothing (lifecycle_is_live).
  L3 ERR_LIFECYCLE_NO_INITIAL        an enum field declaring transitions has no @default
  L4 ERR_TRANSITION_UNKNOWN_STATE    a @from or @to value is not one of the enum's @values
  L5 ERR_TRANSITION_NAME_COLLISION   a transition named create/get/list/update/delete, in any case
  L6 ERR_TRANSITION_NAME_COLLISION   two transitions of one entity share a name, compared without case
  L7 ERR_BAD_ATTR_VALUE              @condition names a field the entity does not have, or is not boolean
  L8 ERR_BAD_ATTR_VALUE              @from is empty
  L9 ERR_BAD_ATTR_VALUE              a lifecycle field is an array
  L10 ERR_LIFECYCLE_REDECLARED       an entity redeclares an inherited lifecycle field without extending it
  B2 ERR_BINDING_PATH_MISMATCH       two bindings of one API share an effective method and path
  P1 ERR_PERMISSION_PUBLIC_CONFLICT  @public: true with @permission (operation or transition)
  P2 ERR_BAD_ATTR_VALUE              @permission is not a dotted identifier path (PERMISSION_NAME_PATTERN)
  O0 ERR_TRANSITION_NAME_COLLISION   an operation named create/get/list/update/delete
  O6 ERR_TRANSITION_NAME_COLLISION   two operations of one package share a name, compared without case,
                                     in one API or across its APIs (each derives the permission name
                                     <package>.<operation>), unless they are the same operation:
                                     declared twice in one API (they merge), or declared identically
                                     in two APIs (_same_operation)
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
    BINDING_ATTR_METHOD,
    BINDING_ATTR_PATH,
    BINDING_SUBTYPE_REST,
    BUSINESS_ERROR_CODE_PATTERN,
    OPERATION_ATTR_ERRORS,
    OPERATION_ATTR_INPUT_REF,
    OPERATION_ATTR_MANY,
    OPERATION_ATTR_OBJECT_REF,
    OPERATION_ATTR_OUTPUT_REF,
    OPERATION_ATTR_PERMISSION,
    OPERATION_ATTR_PUBLIC,
    OPERATION_ATTR_TRANSITIONS,
    PERMISSION_NAME_PATTERN,
    OPERATION_SUBTYPE_COMMAND,
    RESERVED_ERROR_CODES,
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
    entity_lineage,
    entity_transitions,
    lifecycle_is_live,
    lifecycle_transitions_of,
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
from ..naming_refs import effective_package_of
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
_RESERVED_CODES = frozenset(RESERVED_ERROR_CODES)


def _is_reserved_name(name: str) -> bool:
    """A derived name is compared without case: a command, a permission constant or a file named
    from it collides with another that differs only in case on a case-folding target."""
    return name.lower() in _RESERVED
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


def _check_permission(node: MetaData, sink: _Sink) -> None:
    """P1 and P2 for an operation or a transition."""
    permission = node.get_meta_attr(OPERATION_ATTR_PERMISSION)
    if node.get_meta_attr(OPERATION_ATTR_PUBLIC) is True and permission is not None:
        sink.add(
            node,
            ErrorCode.ERR_PERMISSION_PUBLIC_CONFLICT,
            f'{node.type}.{node.sub_type} "{_label(node)}" declares both @public: true and @permission; '
            f"a public {node.type} calls no permission check, so remove one.",
        )
    if isinstance(permission, str) and not PERMISSION_NAME_PATTERN.fullmatch(permission):
        sink.add(
            node,
            ErrorCode.ERR_BAD_ATTR_VALUE,
            f'{node.type}.{node.sub_type} "{_label(node)}" @permission "{permission}" is not a dotted '
            'identifier path; use names of letters, digits and _ joined by "." (a package prefix may use '
            '"::"), such as "purchasing.approve".',
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
    if field.resolved_is_array():
        sink.add(
            field,
            ErrorCode.ERR_BAD_ATTR_VALUE,
            f'field.{field.sub_type} "{_label(field)}" declares transitions but is an array '
            "(@isArray: true); a lifecycle's state is one value.",
        )
    states = _unique(string_list(field, FIELD_ATTR_VALUES))
    for t in declared:
        _check_permission(t, sink)
        if not transition_from(t):
            sink.add(
                t,
                ErrorCode.ERR_BAD_ATTR_VALUE,
                f'transition.action "{_label(t)}" @from is empty; name at least one state the transition leaves.',
            )
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
        if _is_reserved_name(t.name):
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


def _check_redeclared_lifecycles(entity: MetaData, sink: _Sink) -> None:
    """L10: an entity's field named like an ancestor's lifecycle field that does not carry that
    lifecycle's transitions. Redeclaring the field replaces it, so the base's state machine would
    silently stop applying to this entity."""
    for ancestor in entity_lineage(entity)[1:]:
        # ADR-0039 sanctioned own: the lifecycle fields the ancestor itself declares.
        for base_field in ancestor.own_children():
            if base_field.type != TYPE_FIELD:
                continue
            base_transitions = lifecycle_transitions_of(ancestor, base_field)
            if not base_transitions:
                continue
            field = next(
                (c for c in entity.children() if c.type == TYPE_FIELD and c.name == base_field.name), None
            )
            if field is None or field is base_field:
                continue
            kept = lifecycle_transitions_of(entity, field)
            if all(t in kept for t in base_transitions):
                continue
            sink.add(
                field,
                ErrorCode.ERR_LIFECYCLE_REDECLARED,
                f'field.{field.sub_type} "{_label(field)}" redeclares "{_label(base_field)}", which has a '
                f'lifecycle, and drops its transitions; extend it ("extends": "{ancestor.name}.{base_field.name}") '
                "or give the field another name.",
            )


def _check_entity_lifecycles(entity: MetaData, sink: _Sink) -> None:
    """L2, L6 and L10 for one entity, over its effective (inherited) lifecycles."""
    _check_redeclared_lifecycles(entity, sink)
    transitions = entity_transitions(entity)
    if not transitions:
        return
    by_name: dict[str, MetaData] = {}
    for t in transitions:
        key = t.name.lower()
        first = by_name.get(key)
        if first is None:
            by_name[key] = t
        elif first is not t:
            sink.add(
                t,
                ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                f'transition.action "{_label(t)}" has the same name as "{_label(first)}" '
                f'(names are compared without case); the transitions of '
                f'"{entity.name}" share one namespace (each may derive a command), so rename one.',
            )
    if (
        not entity.is_abstract
        and lifecycle_is_live(entity)
        and not any(
            c.type == TYPE_SOURCE and isinstance(c, MetaSource) and c.is_writable() for c in entity.children()
        )
    ):
        owners = _unique([t.parent.name if t.parent is not None else "" for t in transitions])
        sink.add(
            entity,
            ErrorCode.ERR_TRANSITION_NOT_ON_ENTITY,
            f'object.entity "{entity.name}" has a lifecycle (transitions on {_quote_list(owners)}) and a '
            "source, but no writable one; a transition is a guarded update of a stored row. (An entity "
            "with no source at all may carry a lifecycle: it is inert until a source is added.)",
        )


def _check_operation(op: MetaData, sink: _Sink) -> None:
    """O0-O5, P1 and B1 for one operation."""
    if _is_reserved_name(op.name):
        sink.add(
            op,
            ErrorCode.ERR_TRANSITION_NAME_COLLISION,
            f'operation.{op.sub_type} "{_label(op)}" is named "{op.name}", which is a derived CRUD verb '
            f"({_RESERVED_LIST}); rename it.",
        )
    _check_permission(op, sink)

    error_codes = string_list(op, OPERATION_ATTR_ERRORS)
    bad = [c for c in error_codes if not BUSINESS_ERROR_CODE_PATTERN.fullmatch(c)]
    dup = [c for i, c in enumerate(error_codes) if error_codes.index(c) != i]
    reserved = _unique([c for c in error_codes if c in _RESERVED_CODES])
    if bad or dup or reserved:
        if bad:
            why = (
                f'{_quote_list(bad)} {"is not a" if len(bad) == 1 else "are not"} lower snake case '
                f'code{"" if len(bad) == 1 else "s"}'
            )
        elif dup:
            uniq = _unique(dup)
            why = f'{_quote_list(uniq)} {"is" if len(uniq) == 1 else "are"} listed twice'
        else:
            why = (
                f'{_quote_list(reserved)} {"is a code" if len(reserved) == 1 else "are codes"} '
                f'the route answers itself ({", ".join(RESERVED_ERROR_CODES)})'
            )
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
            f'operation.command "{_label(op)}" lists @transitions but has no target entity: the @inputRef does not '
            "borrow one entity's whole primary key (each key field extended exactly once), no @outputRef has a "
            "base entity, and there is no @objectRef.",
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
    # O6 — keyed by package, then by the name without case.
    by_name: dict[tuple[str, str], MetaData] = {}
    for api in root.children():
        if api.type != TYPE_API:
            continue
        ops = [c for c in api.children() if c.type == TYPE_OPERATION]
        for op in ops:
            _check_operation(op, sink)
        for op in ops:
            pkg = effective_package_of(api)
            key = (pkg, op.name.lower())
            first = by_name.get(key)
            if first is None:
                by_name[key] = op
            elif first is not op and not _same_operation(first, op):
                sink.add(
                    op,
                    ErrorCode.ERR_TRANSITION_NAME_COLLISION,
                    f'operation.{op.sub_type} "{_label(op)}" has the same name as "{_label(first)}" (names '
                    f'are compared without case) and is not the same operation; the operations of package "{pkg}" '
                    "share one namespace (each derives the permission name <package>.<operation>), so "
                    "rename one, or declare both identically to expose one operation in two APIs.",
                )
        _check_api_routes(ops, sink)


def _ref_identity(op: MetaData, attr: str) -> object:
    """A reference attr's identity: the node it resolves to, else the raw value."""
    ref = op.get_meta_attr(attr)
    if isinstance(ref, str):
        resolved = resolve_object_on(op, ref)
        return resolved if resolved is not None else ref
    return ref


def _set_key(op: MetaData, attr: str) -> frozenset[str]:
    return frozenset(string_list(op, attr))


def _same_operation(a: MetaData, b: MetaData) -> bool:
    """Whether two operations of one package in different APIs are one operation exposed twice (a
    versioned API beside its successor, ADR-0064 section 2): the same name and subtype and the same
    contract. Bindings are per API and are not compared."""
    if a.name != b.name or a.sub_type != b.sub_type:
        return False
    for attr in (OPERATION_ATTR_INPUT_REF, OPERATION_ATTR_OUTPUT_REF, OPERATION_ATTR_OBJECT_REF):
        ia, ib = _ref_identity(a, attr), _ref_identity(b, attr)
        if not (ia is ib or (not isinstance(ia, MetaData) and not isinstance(ib, MetaData) and ia == ib)):
            return False
    for attr in (OPERATION_ATTR_TRANSITIONS, OPERATION_ATTR_ERRORS):
        if _set_key(a, attr) != _set_key(b, attr):
            return False
    return (
        a.get_meta_attr(OPERATION_ATTR_PERMISSION) == b.get_meta_attr(OPERATION_ATTR_PERMISSION)
        and (a.get_meta_attr(OPERATION_ATTR_PUBLIC) is True) == (b.get_meta_attr(OPERATION_ATTR_PUBLIC) is True)
        and (a.get_meta_attr(OPERATION_ATTR_MANY) is True) == (b.get_meta_attr(OPERATION_ATTR_MANY) is True)
    )


def _check_api_routes(ops: list[MetaData], sink: _Sink) -> None:
    """B2 across the operations of one API."""
    by_route: dict[str, MetaData] = {}
    for op in ops:
        # ADR-0039 sanctioned own: a binding is checked on the operation that declares it.
        for b in op.own_children():
            if b.type != TYPE_BINDING or b.sub_type != BINDING_SUBTYPE_REST:
                continue
            path = b.get_meta_attr(BINDING_ATTR_PATH)
            if not isinstance(path, str):
                continue
            # The effective method: the declared one, else the derived (ADR-0063 section 1).
            declared_method = b.get_meta_attr(BINDING_ATTR_METHOD)
            if isinstance(declared_method, str):
                method = declared_method
            else:
                method = "POST" if op.sub_type == OPERATION_SUBTYPE_COMMAND else "GET"
            route = f"{method} {_PLACEHOLDER_RE.sub('{}', path)}"
            other = by_route.get(route)
            if other is None:
                by_route[route] = b
            else:
                sink.add(
                    b,
                    ErrorCode.ERR_BINDING_PATH_MISMATCH,
                    f'binding.rest on "{_label(b)}" declares {method} "{path}", the same route as the binding '
                    f'on "{_label(other)}"; two operations cannot share a method and path.',
                )
