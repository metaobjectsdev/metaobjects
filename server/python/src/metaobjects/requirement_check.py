"""``metaobjects verify`` — the requirement (capability) gate.

Requirements are METADATA: ``requirement.functional`` / ``requirement.architectural``
are registered metamodel types, declared beside the entities they describe. So this
module parses NOTHING. It reads ``requirement.*`` nodes off the already-loaded model and
checks the things the loader cannot.

Division of labour:

* LOADER (unconditional) — the ``@status`` enum, required attrs, child rules.
* VERIFY (conditional) — ``@implementedBy`` resolution, whose SEVERITY DEPENDS ON
  ``@status``: a ``planned`` requirement names nodes that do not exist YET, so a loader
  ``references`` descriptor (which always errors on an unresolved target) cannot hold it.

Two kinds, opposite checks: ``functional`` WARNS when nothing implements it (and a named
implementor that is gone is an error); ``architectural`` fails a live policy applied to
nothing — claim-set arithmetic, deliberately not a predicate DSL.

Mirrors the TS reference ``packages/cli/src/lib/requirement-check.ts`` — the codes, their
conditions, their order and their message text. The shared corpus is
``fixtures/requirement-check-conformance/``; ADR-0057.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, cast

from metaobjects.library import library_packages
from metaobjects.meta.core.requirement.meta_requirement import MetaRequirement
from metaobjects.meta.core.requirement.requirement_constants import (
    REQUIREMENT_DISPOSITION_DEFERRED,
    REQUIREMENT_LEVEL_MEMBER,
    REQUIREMENT_LINK_FLOOR_LEVEL,
    REQUIREMENT_MAX_LEVEL,
    REQUIREMENT_MIN_LEVEL,
    REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
    REQUIREMENT_SUBTYPE_ARCHITECTURAL,
)
from metaobjects.meta.core.requirement.resolve_claim import (
    resolve_claim_target,
    resolve_member,
    split_member_ref,
)
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming_refs import did_you_mean_hint
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_REQUIREMENT

SEVERITY_ERROR = "error"
SEVERITY_WARN = "warn"

ERR_REQUIREMENT_LINK_ABOVE_FLOOR = "ERR_REQUIREMENT_LINK_ABOVE_FLOOR"
ERR_REQUIREMENT_DANGLING_REF = "ERR_REQUIREMENT_DANGLING_REF"
ERR_REQUIREMENT_BAD_LEVEL = "ERR_REQUIREMENT_BAD_LEVEL"
ERR_REQUIREMENT_LEVEL_NESTING = "ERR_REQUIREMENT_LEVEL_NESTING"
ERR_REQUIREMENT_L4_NOT_OBJECT = "ERR_REQUIREMENT_L4_NOT_OBJECT"
ERR_REQUIREMENT_L5_NOT_MEMBER = "ERR_REQUIREMENT_L5_NOT_MEMBER"
ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS = "ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS"
WARN_REQUIREMENT_OBJECT_UNCLAIMED = "WARN_REQUIREMENT_OBJECT_UNCLAIMED"
WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE = "WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE"
WARN_REQUIREMENT_DEFERRED_UNTRACKED = "WARN_REQUIREMENT_DEFERRED_UNTRACKED"
WARN_REQUIREMENT_NOTHING_IMPLEMENTS = "WARN_REQUIREMENT_NOTHING_IMPLEMENTS"

#: Severity of the object-coverage gate. It stays ``"warn"``: on a real estate carrying a
#: single requirement the gate reports every entity, so at ``"error"`` a project adopting
#: requirements incrementally would fail its first ``verify`` after authoring one entry,
#: which teaches people to delete the entry. Promotion is a one-line flip here.
OBJECT_COVERAGE_SEVERITY = SEVERITY_WARN


@dataclass(frozen=True)
class Diagnostic:
    severity: str  # "error" | "warn"
    code: str
    message: str
    #: The subject's ADDRESS — the dotted child-name path. Two branches of a ledger may
    #: reuse a NAME, so a bare name does not locate the node. ``None`` on a diagnostic
    #: whose subject is not a requirement (object coverage names the entity instead).
    path: str | None = None


@dataclass(frozen=True)
class AddressedRequirement:
    """A requirement paired with its ADDRESS — the dotted child-name path from the root."""

    node: MetaRequirement
    path: str


@dataclass
class RequirementSummary:
    """Counts behind the summary line ``verify`` prints on every run, clean or not."""

    total: int
    functional: int = 0
    architectural: int = 0
    by_status: dict[str, int] = field(default_factory=dict)
    #: planned or partial with NO disposition recorded — the unreviewed gaps.
    undecided: int = 0
    #: deferred entries naming no ticket, so nobody will be reminded.
    deferred_untracked: int = 0
    #: ``None`` when coverage was not measured: a number here is a ratio the project is
    #: held to; ``None`` is the honest reading of "this project authored no requirement
    #: of its own, so it asked to be held to none".
    entities_total: int | None = None
    entities_claimed: int | None = None


@dataclass(frozen=True)
class RequirementScan:
    """What one ``verify`` run computes once and both requirement passes read."""

    addressed: list[AddressedRequirement]
    claimed_objects: frozenset[str]
    #: Whether object coverage applies at all on this run (FR-043 §5.4).
    measure_coverage: bool
    #: ADR-0057 — the strict switch: ``WARN_REQUIREMENT_NOTHING_IMPLEMENTS`` is reported
    #: at severity ``error``. The code, path and message do not change.
    require_implementers: bool
    #: FR-023 — narrows which entities count; ``None`` means every non-abstract entity.
    coverable: Callable[[str], bool] | None = None


def _effective_package(req: MetaRequirement) -> str:
    return req.package or req.file_default_package or ""


def collect_addressed_requirements(root: MetaData) -> list[AddressedRequirement]:
    """Every ``requirement.*`` node in the tree, at any depth, each with its dotted path.

    Hierarchy IS nesting, so this is a walk. Only a requirement contributes a path
    segment; an intervening non-requirement node is traversed THROUGH. The traversal
    descends through EVERY node, so a requirement somewhere the child rules did not
    anticipate is still gated — the fail-closed direction for a gate.
    """
    out: list[AddressedRequirement] = []

    def walk(n: MetaData, prefix: str) -> None:
        for c in n.children():
            is_req = c.type == TYPE_REQUIREMENT
            path = (c.name if prefix == "" else f"{prefix}.{c.name}") if is_req else prefix
            if is_req:
                out.append(AddressedRequirement(cast(MetaRequirement, c), path))
            walk(c, path)

    walk(root, "")
    return out


def _resolve_requirement_ref(
    addressed: list[AddressedRequirement], ref: str, referrer_pkg: str
) -> MetaRequirement | None:
    """Resolve a ``@supersededBy`` reference against the LEDGER, not the model: a
    capability is replaced by another capability. Keyed by ``<package>::<path>`` and by the
    bare path (first one wins, so a bare path ambiguous across packages still binds)."""
    keyed: dict[str, MetaRequirement] = {}
    for item in addressed:
        pkg = _effective_package(item.node)
        if pkg != "":
            keyed[f"{pkg}::{item.path}"] = item.node
        if item.path not in keyed:
            keyed[item.path] = item.node
    exact = keyed.get(ref)
    if exact is not None:
        return exact
    if referrer_pkg != "":
        return keyed.get(f"{referrer_pkg}::{ref}")
    return None


def _missing_member_hint(obj: MetaData, path: list[str]) -> str:
    """Names the FIRST segment of a non-empty, unresolvable ``path`` under ``obj``, and the
    node it was looked for under."""
    found = 0
    while found < len(path) - 1 and resolve_member(obj, path[: found + 1]) is not None:
        found += 1
    parent = ".".join([obj.resolution_key(), *path[:found]])
    return f" '{parent}' has no member '{path[found]}'."


def _subtypes_of(root: MetaData, ancestor: MetaData) -> list[str]:
    """Resolution keys of every root-level object whose ``extends`` chain reaches
    ``ancestor``. Walks the RESOLVED super pointer, never the raw string."""
    out: list[str] = []
    for cand in root.children():
        if cand.type != TYPE_OBJECT or cand is ancestor:
            continue
        seen: set[int] = set()
        cur = cand.super_data
        while cur is not None and id(cur) not in seen:
            seen.add(id(cur))
            if cur is ancestor:
                out.append(cand.resolution_key())
                break
            cur = cur.super_data
    return out


def _subtree_claims_anything(req: MetaRequirement) -> bool:
    """True when this requirement, or anything nested beneath it, names an implementing
    node. Subtree-scoped deliberately: an L1 solution that delegates everything to its
    children implements nothing directly, and flagging that would fire on every tree."""
    if req.implemented_by():
        return True
    for child in req.children():
        if child.type != TYPE_REQUIREMENT:
            continue
        if _subtree_claims_anything(cast(MetaRequirement, child)):
            return True
    return False


def _project_authored_requirements(addressed: list[AddressedRequirement]) -> bool:
    """Did the ADOPTER author any of these requirements? (FR-043 §5.4.)

    Provenance is the library's declared PACKAGE, a manifest fact; a node's source id
    differs between a checkout and an installed wheel. An adopter OVERLAYING a library
    requirement stays in the library's package and is deliberately not authoring one."""
    lib_pkgs = library_packages()
    return any(_effective_package(item.node) not in lib_pkgs for item in addressed)


def _claimed_object_keys(root: MetaData, reqs: list[MetaRequirement]) -> frozenset[str]:
    """Resolution keys of every object claimed by a requirement, shared by the gate and
    the summary so the two cannot disagree."""
    claimed: set[str] = set()
    for req in reqs:
        # A PLANNED requirement never contributes to coverage: otherwise the cheapest way
        # to clear an unclaimed-entity warning would be to declare an intention.
        if req.is_planned():
            continue
        referrer_pkg = _effective_package(req)
        for ref in req.implemented_by():
            owner, path = split_member_ref(ref)
            node = resolve_claim_target(root, owner, referrer_pkg)
            if node is None:
                continue
            if path and resolve_member(node, path) is None:
                continue
            claimed.add(node.resolution_key())
            # ARCHITECTURAL claims propagate DOWN the extends chain; functional ones do not.
            if req.sub_type == REQUIREMENT_SUBTYPE_ARCHITECTURAL:
                claimed.update(_subtypes_of(root, node))
    return frozenset(claimed)


def scan_requirements(
    root: MetaData,
    *,
    coverable: Callable[[str], bool] | None = None,
    measure_coverage: bool | None = None,
    require_implementers: bool = False,
) -> RequirementScan:
    """Compute, once, what the gate and the summary both read.

    ``measure_coverage`` forces coverage on or off instead of deriving it; the one caller
    that legitimately knows better is a gate over a shipped library loaded standalone.
    """
    addressed = collect_addressed_requirements(root)
    return RequirementScan(
        addressed=addressed,
        claimed_objects=_claimed_object_keys(root, [a.node for a in addressed]),
        measure_coverage=(
            measure_coverage if measure_coverage is not None else _project_authored_requirements(addressed)
        ),
        require_implementers=require_implementers,
        coverable=coverable,
    )


def _coverable_entities(root: MetaData, coverable: Callable[[str], bool] | None) -> list[MetaData]:
    """The entities object coverage measures — the same set for the gate and the summary.

    An ABSTRACT entity is shape, not data, so it is exempt; ``object.value`` and
    ``object.projection`` are exempt too. ``coverable`` (FR-023) is applied INSIDE this
    function so every call site inherits it."""
    return [
        n
        for n in root.children()
        if n.type == TYPE_OBJECT
        and n.sub_type == OBJECT_SUBTYPE_ENTITY
        and not n.is_abstract
        and (coverable is None or coverable(n.resolution_key()))
    ]


def check_requirements(root: MetaData, scan: RequirementScan | None = None) -> list[Diagnostic]:
    """Check the requirement tree against the loaded model.

    What a clean run proves: referential integrity — links sit at or below the link floor,
    nesting agrees with levels, and references resolve. What it CANNOT prove: that a status
    is *true*, or that a node actually implements the requirement claiming it.
    """
    scan = scan if scan is not None else scan_requirements(root)
    out: list[Diagnostic] = []
    if not scan.addressed:
        return out  # opt-in by declaration — no requirements, nothing to say

    for item in scan.addressed:
        req, req_path = item.node, item.path
        architectural = req.sub_type == REQUIREMENT_SUBTYPE_ARCHITECTURAL
        level = req.level()
        refs = req.implemented_by()

        # -- the level rules. A functional requirement MUST be levelled; an architectural
        # one MAY be, and levelling is the OPT-IN.
        levelled = level is not None
        if not architectural or levelled:
            if level is None or level < REQUIREMENT_MIN_LEVEL or level > REQUIREMENT_MAX_LEVEL:
                out.append(
                    Diagnostic(
                        SEVERITY_ERROR,
                        ERR_REQUIREMENT_BAD_LEVEL,
                        f"level must be an integer {REQUIREMENT_MIN_LEVEL}-{REQUIREMENT_MAX_LEVEL} "
                        f"(got {'undefined' if level is None else level}). "
                        "L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member."
                        + (
                            " On an architectural requirement the level is optional — omit it for a flat policy."
                            if architectural
                            else ""
                        ),
                        req_path,
                    )
                )
            # Nesting IS the hierarchy, so a child must sit strictly below its parent.
            parent = req.parent
            if parent is not None and parent.type == TYPE_REQUIREMENT:
                pl = cast(MetaRequirement, parent).level()
                if pl is not None and level is not None and level <= pl:
                    out.append(
                        Diagnostic(
                            SEVERITY_ERROR,
                            ERR_REQUIREMENT_LEVEL_NESTING,
                            f'nested under "{parent.name}" (level {pl}) but declares level {level}. '
                            "Nesting is the hierarchy — a child sits strictly below its parent.",
                            req_path,
                        )
                    )

        # -- the link boundary
        if refs and not req.may_reference_model():
            out.append(
                Diagnostic(
                    SEVERITY_ERROR,
                    ERR_REQUIREMENT_LINK_ABOVE_FLOOR,
                    f"'implementedBy' is legal at L{REQUIREMENT_LINK_FLOOR_LEVEL} (object) and "
                    f"L{REQUIREMENT_MAX_LEVEL} (member) only. L1-L3 are organisational and never reference "
                    f"the model — move the links to a nested L{REQUIREMENT_LINK_FLOOR_LEVEL} child.",
                    req_path,
                )
            )
            continue

        for ref in refs:
            owner, path = split_member_ref(ref)
            referrer_pkg = _effective_package(req)
            node = resolve_claim_target(root, owner, referrer_pkg)
            is_object_ref = not path

            # GRAIN stays functional-only DELIBERATELY: on a levelled architectural
            # requirement the upper tiers are a quality taxonomy, and a policy whose claim
            # set legitimately mixes grains must not be forced to split by grain.
            if not architectural and level == REQUIREMENT_LINK_FLOOR_LEVEL and not is_object_ref:
                out.append(
                    Diagnostic(
                        SEVERITY_ERROR,
                        ERR_REQUIREMENT_L4_NOT_OBJECT,
                        f"L{REQUIREMENT_LINK_FLOOR_LEVEL} references an object; '{ref}' names a member. "
                        f"Move it to a nested L{REQUIREMENT_LEVEL_MEMBER} child, or reference the object itself.",
                        req_path,
                    )
                )
                continue
            if not architectural and level == REQUIREMENT_LEVEL_MEMBER and is_object_ref:
                out.append(
                    Diagnostic(
                        SEVERITY_ERROR,
                        ERR_REQUIREMENT_L5_NOT_MEMBER,
                        f"L{REQUIREMENT_LEVEL_MEMBER} references a member (field, view or identity); "
                        f"'{ref}' names an object. Move it to its L{REQUIREMENT_LINK_FLOOR_LEVEL} parent.",
                        req_path,
                    )
                )
                continue

            resolved = node is not None and (is_object_ref or resolve_member(node, path) is not None)
            if not resolved and req.requires_live_nodes():
                # The did-you-mean hint answers an OBJECT that failed to resolve. When the
                # object resolved and only the member is gone, name the member instead.
                hint = did_you_mean_hint(root, owner) if node is None else _missing_member_hint(node, path)
                out.append(
                    Diagnostic(
                        SEVERITY_ERROR,
                        ERR_REQUIREMENT_DANGLING_REF,
                        f"'{ref}' does not resolve in the loaded model (status '{req.status()}' — "
                        "the model moved and the requirement is stale)." + hint,
                        req_path,
                    )
                )

        # -- @supersededBy resolution (FR-039): the target is a REQUIREMENT, resolved
        # package-locally under ADR-0042 through the requirement's own effective package.
        superseded = req.superseded_by()
        if superseded is not None:
            if _resolve_requirement_ref(scan.addressed, superseded, _effective_package(req)) is None:
                out.append(
                    Diagnostic(
                        SEVERITY_ERROR,
                        ERR_REQUIREMENT_DANGLING_REF,
                        f"@supersededBy '{superseded}' does not name a requirement in the loaded "
                        "ledger. It must name the requirement that REPLACED this one — if nothing did, "
                        "drop the attribute and let `notes` carry why the capability went.",
                        req_path,
                    )
                )

        # -- architectural universality, v1: claim-set arithmetic. Two structural
        # exemptions: `planned` (supposed to be applied to nothing), and an
        # ORGANISATIONAL node of a levelled tree (may_reference_model() is false there).
        status = req.status()
        live = status is not None and status in REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES
        if architectural and live and not refs and req.may_reference_model():
            out.append(
                Diagnostic(
                    SEVERITY_ERROR,
                    ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS,
                    f"architectural requirement is '{status}' but nothing implements it. "
                    "Its check is universality — a claim set of zero means the policy is declared and unapplied.",
                    req_path,
                )
            )

        # -- disposition: the decision, not the state
        disposition = req.disposition()
        if disposition is not None and not req.has_outstanding_work():
            out.append(
                Diagnostic(
                    SEVERITY_WARN,
                    WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE,
                    f"carries @disposition '{disposition}' but its status is '{status}', which has no "
                    "outstanding work to decide about. A disposition is meaningful on 'planned' and 'partial' only — "
                    "on any other status the decision IS the status.",
                    req_path,
                )
            )

        # -- functional existence, SUBTREE-scoped. The strict switch (ADR-0057) raises the
        # SEVERITY only; the code keeps its `WARN_` name because it identifies the finding.
        if not architectural and live and not _subtree_claims_anything(req):
            out.append(
                Diagnostic(
                    SEVERITY_ERROR if scan.require_implementers else SEVERITY_WARN,
                    WARN_REQUIREMENT_NOTHING_IMPLEMENTS,
                    f"is '{status}' but neither it nor anything nested under it names an "
                    "implementing node. A functional requirement's check is existence — a subtree that claims "
                    "nothing is a capability nobody built.",
                    req_path,
                )
            )

        if disposition == REQUIREMENT_DISPOSITION_DEFERRED and not req.tracked_by():
            out.append(
                Diagnostic(
                    SEVERITY_WARN,
                    WARN_REQUIREMENT_DEFERRED_UNTRACKED,
                    "is deferred but names no @trackedBy issue. Deferring without a ticket is how a known gap "
                    "becomes an unknown one — nothing will raise it again.",
                    req_path,
                )
            )

    # -- object coverage: adding an entity forces a requirement. Binary per entity, never a
    # ratio. ENTITIES ONLY, OBJECT GRAIN ONLY, ADOPTER-AUTHORED ONLY (FR-043 §5.4).
    if scan.measure_coverage:
        for ent in _coverable_entities(root, scan.coverable):
            key = ent.resolution_key()
            if key not in scan.claimed_objects:
                out.append(
                    Diagnostic(
                        OBJECT_COVERAGE_SEVERITY,
                        WARN_REQUIREMENT_OBJECT_UNCLAIMED,
                        f"no requirement claims '{key}'. Add it to an L{REQUIREMENT_LINK_FLOOR_LEVEL} "
                        "requirement's 'implementedBy'.",
                    )
                )

    return out


def summarise_requirements(root: MetaData, scan: RequirementScan | None = None) -> RequirementSummary | None:
    """Count what the ledger contains, for the line ``verify`` prints on EVERY run —
    including a clean one, because silence cannot be told apart from "checked nothing".
    ``None`` when the model declares no requirement."""
    scan = scan if scan is not None else scan_requirements(root)
    if not scan.addressed:
        return None  # opt-in by declaration

    summary = RequirementSummary(total=len(scan.addressed))

    # `undecided` counts only the requirements a `@disposition` could actually SETTLE. A
    # parent is `partial` because a descendant is, so a disposition on it would settle
    # nothing. EVERY ancestor of a node with outstanding work is excluded, by path
    # SEGMENT (`::` carries no dot, so a package-qualified root segment stays intact), and
    # whether or not that descendant is itself disposed: once the only outstanding leaf has
    # been ruled on, nothing beneath the parent is owed.
    roll_up_ancestors: set[str] = set()
    for item in scan.addressed:
        if not item.node.has_outstanding_work():
            continue
        segments = item.path.split(".")
        for i in range(1, len(segments)):
            roll_up_ancestors.add(".".join(segments[:i]))

    for item in scan.addressed:
        req = item.node
        if req.sub_type == REQUIREMENT_SUBTYPE_ARCHITECTURAL:
            summary.architectural += 1
        else:
            summary.functional += 1

        status = req.status()
        # by_status is UNCHANGED by the roll-up rule: a parent is still genuinely `partial`.
        if status is not None:
            summary.by_status[status] = summary.by_status.get(status, 0) + 1

        if req.has_outstanding_work() and req.disposition() is None and item.path not in roll_up_ancestors:
            summary.undecided += 1
        if req.disposition() == REQUIREMENT_DISPOSITION_DEFERRED and not req.tracked_by():
            summary.deferred_untracked += 1

    # Both sides of the ratio come from the SAME scan the gate read.
    if scan.measure_coverage:
        total = 0
        claimed_count = 0
        for ent in _coverable_entities(root, scan.coverable):
            total += 1
            if ent.resolution_key() in scan.claimed_objects:
                claimed_count += 1
        summary.entities_total = total
        summary.entities_claimed = claimed_count

    return summary
