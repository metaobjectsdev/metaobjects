"""``metaobjects verify`` — the business-rules gate (ADR-0066).

The loader refuses a model whose operations or lifecycles are malformed. This gate reports
what loads clean but is almost certainly not what the author meant: a state nothing can
reach, a lifecycle that cannot move, a transition nothing can make, and (by setting) a
permission name the model derived instead of declaring.

Mirrors the TS reference ``packages/cli/src/lib/rules-check.ts``: the codes, severities,
paths and message text. ``fixtures/rules-check-conformance/`` is the contract. A model that
declares no operation and no transition gets no diagnostics, no summary and no gate row:
opt-in by declaration, so an existing project sees no change.

Checks, in the order they are reported:

* ``WARN_LIFECYCLE_UNREACHABLE_STATE``: states no transition reaches from the initial state
  (severity: ``verify.lifecycle.unreachable``)
* ``WARN_LIFECYCLE_INITIAL_TERMINAL``: the initial state is one no transition leaves
* ``WARN_TRANSITION_UNREACHABLE``: a transition whose every @from state is unreachable
  (severity: ``verify.lifecycle.unreachable``)
* ``WARN_TRANSITION_PERMISSION_SHADOWED``: a transition declaring @permission or @public: true
  that derives no command of its own, so the attribute is never read (always a warning)
* ``WARN_PERMISSION_DERIVED_NAME``: a transition that derives its own command, or an
  operation, with no @permission and not @public (severity: ``rules.permissions.names``)

Lifecycles are checked once per declaring field, so a lifecycle on an abstract base is
reported once, not once per inheritor. A derived command exists per concrete entity, so the
permission check runs per concrete entity and names it.

ADR-0039 NAMING INVERSION: Python ``attr()`` is OWN-ONLY, so every read here is
``get_meta_attr()`` (resolving).
"""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.meta.core.api.api_constants import (
    OPERATION_ATTR_PERMISSION,
    OPERATION_ATTR_PUBLIC,
    OPERATION_ATTR_TRANSITIONS,
    OPERATION_SUBTYPE_COMMAND,
)
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY
from metaobjects.meta.core.transition.lifecycle import (
    Lifecycle,
    entity_lineage,
    entity_transitions,
    lifecycle_is_live,
    lifecycles_of,
    operation_target,
    reachable_states,
    terminal_states,
    transition_from,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming_refs import effective_package_of, top_level_node_of
from metaobjects.requirement_check import SEVERITY_ERROR, SEVERITY_WARN, Diagnostic
from metaobjects.rules_settings import RulesSettings
from metaobjects.shared.base_types import TYPE_API, TYPE_OBJECT, TYPE_OPERATION
from metaobjects.shared.separators import PACKAGE_SEP

WARN_LIFECYCLE_UNREACHABLE_STATE = "WARN_LIFECYCLE_UNREACHABLE_STATE"
WARN_LIFECYCLE_INITIAL_TERMINAL = "WARN_LIFECYCLE_INITIAL_TERMINAL"
WARN_TRANSITION_UNREACHABLE = "WARN_TRANSITION_UNREACHABLE"
WARN_PERMISSION_DERIVED_NAME = "WARN_PERMISSION_DERIVED_NAME"
WARN_TRANSITION_PERMISSION_SHADOWED = "WARN_TRANSITION_PERMISSION_SHADOWED"


@dataclass(frozen=True)
class RulesSummary:
    """What the model declares, for the line ``verify`` prints on every run."""

    #: Declared operations, across every ``api.operational``.
    operations: int
    #: Lifecycles: enum fields that declare at least one transition.
    lifecycles: int
    #: Declared transitions, across every lifecycle.
    transitions: int


@dataclass(frozen=True)
class RulesCheckResult:
    diagnostics: list[Diagnostic]
    #: ``None`` when the model declares no operation and no transition.
    summary: RulesSummary | None


def _quote_list(xs: list[str]) -> str:
    return ", ".join(f'"{x}"' for x in xs)


def rules_address(node: MetaData) -> str:
    """A node's package-qualified address: ``acme::shop::Order.status.submit``."""
    parts: list[str] = []
    n: MetaData | None = node
    while n is not None and n.parent is not None:
        if n.name != "":
            parts.insert(0, n.name)
        n = n.parent
    pkg = effective_package_of(top_level_node_of(node))
    return ".".join(parts) if pkg == "" else f"{pkg}{PACKAGE_SEP}{'.'.join(parts)}"


def _derived_permission_name(owner: MetaData, path: str) -> str:
    """The permission name a node gets when it declares none, ``<package>.<path>``: the path is
    ``<operation>`` for a declared operation and ``<Entity>.<transition>`` for a transition's
    derived command, so two entities' transitions of one name ask about different permissions."""
    pkg = effective_package_of(top_level_node_of(owner))
    return path if pkg == "" else f"{pkg}.{path}"


def _needs_permission_name(node: MetaData) -> bool:
    return (
        node.get_meta_attr(OPERATION_ATTR_PERMISSION) is None
        and node.get_meta_attr(OPERATION_ATTR_PUBLIC) is not True
    )


def _entities(root: MetaData) -> list[MetaData]:
    return [c for c in root.children() if c.type == TYPE_OBJECT and c.sub_type == OBJECT_SUBTYPE_ENTITY]


def _operations(root: MetaData) -> list[MetaData]:
    return [
        op
        for api in root.children()
        if api.type == TYPE_API
        for op in api.children()
        if op.type == TYPE_OPERATION
    ]


def _declared_lifecycles(root: MetaData) -> list[Lifecycle]:
    """Every lifecycle of the model, once per declaring field, in model order."""
    seen: set[MetaData] = set()
    out: list[Lifecycle] = []
    for entity in _entities(root):
        for l in lifecycles_of(entity):
            if l.field in seen:
                continue
            seen.add(l.field)
            out.append(l)
    return out


def _check_lifecycle(l: Lifecycle, settings: RulesSettings, out: list[Diagnostic]) -> None:
    where = rules_address(l.field)
    initial = l.initial
    if initial is None:
        return  # the loader refused this model (ERR_LIFECYCLE_NO_INITIAL)
    reachable = reachable_states(l)
    unreachable_severity = None if settings.lifecycle_unreachable == "off" else settings.lifecycle_unreachable

    if unreachable_severity is not None:
        unreachable = [s for s in l.states if s not in reachable]
        if unreachable:
            one = len(unreachable) == 1
            out.append(Diagnostic(
                severity=unreachable_severity,
                code=WARN_LIFECYCLE_UNREACHABLE_STATE,
                path=where,
                message=(
                    f'{"state" if one else "states"} {_quote_list(unreachable)} of "{l.field.name}" '
                    f'cannot be reached from the initial state "{initial}" by any transition. '
                    "Add the transition that leads there, or set verify.lifecycle.unreachable if only seeded data uses "
                    f'{"it" if one else "them"}.'
                ),
            ))

    if initial in terminal_states(l):
        out.append(Diagnostic(
            severity=SEVERITY_WARN,
            code=WARN_LIFECYCLE_INITIAL_TERMINAL,
            path=where,
            message=(
                f'the initial state "{initial}" of "{l.field.name}" is terminal: no transition leaves it, '
                "so no row of this lifecycle can ever move."
            ),
        ))

    if unreachable_severity is not None:
        for t in l.transitions:
            frm = transition_from(t)
            if not frm or any(s in reachable for s in frm):
                continue
            out.append(Diagnostic(
                severity=unreachable_severity,
                code=WARN_TRANSITION_UNREACHABLE,
                path=rules_address(t),
                message=(
                    f'transition "{t.name}" starts only from {_quote_list(frm)}, which no transition reaches from '
                    f'the initial state "{initial}", so it can never be made.'
                ),
            ))


@dataclass(frozen=True)
class _Claim:
    """One command's claim on a transition node, made for its target entity."""

    target: MetaData
    op: MetaData


def _claimed_transitions(root: MetaData) -> dict[MetaData, list[_Claim]]:
    """Each transition node the declared commands claim, with the claims on it in model order."""
    claimed: dict[MetaData, list[_Claim]] = {}
    for op in _operations(root):
        if op.sub_type != OPERATION_SUBTYPE_COMMAND:
            continue
        target = operation_target(op)
        if target is None:
            continue
        raw = op.get_meta_attr(OPERATION_ATTR_TRANSITIONS)  # ADR-0039: resolving
        names = {x for x in raw if isinstance(x, str)} if isinstance(raw, list) else set()
        for t in entity_transitions(target):
            if t.name in names:
                claimed.setdefault(t, []).append(_Claim(target, op))
    return claimed


def _claims_on(claimed: dict[MetaData, list[_Claim]], entity: MetaData, t: MetaData) -> list[_Claim]:
    """The claims that cover transition ``t`` on ``entity``: those made for the entity or an entity it extends."""
    lineage = entity_lineage(entity)
    return [c for c in claimed.get(t, []) if c.target in lineage]


def _derives_command(
    claimed: dict[MetaData, list[_Claim]], settings: RulesSettings, entity: MetaData, t: MetaData
) -> bool:
    """Whether ``t``, carried by ``entity``, derives a command of its own under the setting."""
    if settings.lifecycle_commands == "none":
        return False
    if settings.lifecycle_commands == "all":
        return True
    return not _claims_on(claimed, entity, t)


def _command_entities(root: MetaData) -> list[MetaData]:
    """The entities a transition can derive a command on: concrete, with a source."""
    return [e for e in _entities(root) if not e.is_abstract and lifecycle_is_live(e)]


def _check_shadowed_permissions(root: MetaData, settings: RulesSettings, out: list[Diagnostic]) -> None:
    """A transition's @permission or @public is read only by the command derived from it. One that
    derives no command for any concrete entity carrying it declares an attribute nothing reads."""
    if settings.lifecycle_commands == "all":
        return
    claimed = _claimed_transitions(root)
    carriers: dict[MetaData, list[MetaData]] = {}
    for entity in _command_entities(root):
        for t in entity_transitions(entity):
            carriers.setdefault(t, []).append(entity)
    for t, entities_with_t in carriers.items():
        permission = t.get_meta_attr(OPERATION_ATTR_PERMISSION)
        is_public = t.get_meta_attr(OPERATION_ATTR_PUBLIC) is True
        if permission is None and not is_public:
            continue
        if any(_derives_command(claimed, settings, e, t) for e in entities_with_t):
            continue
        declared = f'@permission "{permission}"' if permission is not None else "@public: true"
        claimers = list(dict.fromkeys(
            f"{c.op.parent.name if c.op.parent is not None else ''}.{c.op.name}"
            for e in entities_with_t
            for c in _claims_on(claimed, e, t)
        ))
        if settings.lifecycle_commands == "none":
            why = 'rules.lifecycle.commands is "none": no command is derived from it'
        else:
            one = len(claimers) == 1
            why = (
                f"it derives no command of its own: it is made only by {_quote_list(claimers)}, which "
                f'{"asks" if one else "ask"} the policy about {"its" if one else "their"} own permission'
            )
        out.append(Diagnostic(
            severity=SEVERITY_WARN,
            code=WARN_TRANSITION_PERMISSION_SHADOWED,
            path=rules_address(t),
            message=(
                f'transition "{t.name}" declares {declared}, but {why}, so the attribute is never read. '
                "Remove it from the transition, or declare it on the command that makes the transition."
            ),
        ))


def _check_permission_names(root: MetaData, settings: RulesSettings, out: list[Diagnostic]) -> None:
    if settings.permission_names == "derive":
        return
    severity = SEVERITY_ERROR if settings.permission_names == "require" else SEVERITY_WARN

    def advice(kind: str) -> str:
        return f"which changes if the {kind} is renamed. Declare @permission, or @public: true."

    if settings.lifecycle_commands != "none":
        claimed = _claimed_transitions(root)
        for entity in _command_entities(root):
            for t in entity_transitions(entity):
                if not _derives_command(claimed, settings, entity, t):
                    continue
                if not _needs_permission_name(t):
                    continue
                field_name = t.parent.name if t.parent is not None else ""
                out.append(Diagnostic(
                    severity=severity,
                    code=WARN_PERMISSION_DERIVED_NAME,
                    path=f"{rules_address(entity)}.{field_name}.{t.name}",
                    message=(
                        f'the command derived from transition "{t.name}" of "{entity.name}" has no @permission, '
                        f'so it asks the policy about the derived name "{_derived_permission_name(entity, f"{entity.name}.{t.name}")}", '
                        f'{advice("transition")}'
                    ),
                ))

    for op in _operations(root):
        if not _needs_permission_name(op):
            continue
        out.append(Diagnostic(
            severity=severity,
            code=WARN_PERMISSION_DERIVED_NAME,
            path=rules_address(op),
            message=(
                f'operation.{op.sub_type} "{op.name}" has no @permission, so it asks the policy about the '
                f'derived name "{_derived_permission_name(op, op.name)}", {advice("operation")}'
            ),
        ))


def check_rules(root: MetaData, settings: RulesSettings) -> RulesCheckResult:
    """The rules gate over a loaded model."""
    lifecycles = _declared_lifecycles(root)
    ops = _operations(root)
    if not lifecycles and not ops:
        return RulesCheckResult(diagnostics=[], summary=None)

    diagnostics: list[Diagnostic] = []
    for l in lifecycles:
        _check_lifecycle(l, settings, diagnostics)
    _check_shadowed_permissions(root, settings, diagnostics)
    _check_permission_names(root, settings, diagnostics)
    return RulesCheckResult(
        diagnostics=diagnostics,
        summary=RulesSummary(
            operations=len(ops),
            lifecycles=len(lifecycles),
            transitions=sum(len(l.transitions) for l in lifecycles),
        ),
    )
