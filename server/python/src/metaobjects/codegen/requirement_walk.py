"""Walking ``requirement.*`` nodes: which tests a ledger yields and what each is called.

Everything here is the part of the requirement-test generator that every language port copies
and a shared corpus pins (``fixtures/requirement-test-identity-conformance/``): which tests a
ledger yields, what each is called, whether it is skipped, and a fingerprint of the claim it
tests. Mirrors the TS reference ``codegen-ts/src/requirement-walk.ts`` (contract Tables F and G).

It lives beside the generator rather than in it because an application that owns its generator
(``metaobjects eject requirement-tests``) still imports these from the package: an owned copy
changes how a test is WRITTEN and keeps agreeing with every other tool about which tests exist.

A filter is handed a :class:`RequirementView`, never the node: an application's filter is its own
policy, and the node would bind adopter code to metamodel internals and export the ADR-0039
own-versus-resolving accessor trap.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Callable

from metaobjects.meta.core.requirement.meta_requirement import MetaRequirement
from metaobjects.meta.core.requirement.requirement_constants import (
    REQUIREMENT_ATTR_COUNTEREXAMPLE,
    REQUIREMENT_ATTR_STATEMENT,
    REQUIREMENT_LINK_FLOOR_LEVEL,
    REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
    REQUIREMENT_SUBTYPE_FUNCTIONAL,
)
from metaobjects.meta.core.requirement.resolve_claim import resolve_claim
from metaobjects.meta.meta_data import MetaData
from metaobjects.requirement_check import collect_addressed_requirements, effective_package
from metaobjects.shared.separators import PACKAGE_SEP

#: The unit of a requirement that resolves no target. Doubles as the catch-all renderer key.
NO_CONCERN = "*"

REQUIREMENT_TEST_GRAINS: tuple[str, ...] = ("concern", "member")

DIGEST_VERSION = "requirement-digest/v1"


@dataclass(frozen=True)
class RequirementView:
    """What a filter receives. Never the node."""

    #: ``functional`` or ``architectural`` — the check-polarity axis.
    sub_type: str
    #: 1 solution, 2 segment, 3 service, 4 object, 5 member. ``None`` on an unlevelled
    #: architectural requirement (the flat policy form): absent is not a number.
    level: int | None
    status: str | None
    #: Dotted path from the root through nesting ancestors. No package.
    path: str
    #: The EFFECTIVE package (contract Table A).
    package: str
    #: The distinct ``<type>.<subType>`` of the references that RESOLVE, first-seen order.
    implemented_by_types: tuple[str, ...]


@dataclass(frozen=True)
class ResolvedClaim:
    #: The reference exactly as authored.
    ref: str
    node: MetaData
    #: ``<type>.<subType>`` of the node it resolved to.
    concern: str


@dataclass(frozen=True)
class WalkedRequirement:
    node: MetaRequirement
    view: RequirementView
    targets: tuple[ResolvedClaim, ...]


@dataclass(frozen=True)
class RequirementTestIdentity:
    """One generated test. The same record in every language port."""

    #: The requirement's effective package.
    package: str
    #: The requirement's dotted path, without the package.
    path: str
    #: ``<type>.<subType>`` under the ``concern`` grain, the reference as authored under
    #: ``member``, and ``*`` for a requirement that resolves no target.
    unit: str
    #: ``<qualified address> [<unit>]`` — unique per test.
    id: str
    #: An identifier-safe spelling of ``id``, for ports that bind a test to a function.
    witness_key: str
    status: str | None
    #: ``None`` when the requirement claims the capability works right now; otherwise the
    #: status (``planned`` or ``retired``).
    skip: str | None
    #: :func:`requirement_digest` of the requirement — the same for each of its tests.
    digest: str


RequirementFilter = Callable[[RequirementView], bool]


def _concern_of(node: MetaData) -> str:
    return f"{node.type}.{node.sub_type}"


def walk_requirements(root: MetaData) -> list[WalkedRequirement]:
    """Every ``requirement.*`` node, nested ones included, in declaration order.

    An unresolvable ``@implementedBy`` reference is skipped rather than raised on: its
    severity depends on ``@status`` and belongs to ``verify``, and codegen must not fail a
    build over a diagnostic another command owns.
    """
    out: list[WalkedRequirement] = []
    for item in collect_addressed_requirements(root):
        req = item.node
        # The referrer package a bare reference binds in (ADR-0042) is the effective package.
        package = effective_package(req)
        targets: list[ResolvedClaim] = []
        for ref in req.implemented_by():
            target = resolve_claim(root, ref, package)
            if target is not None:
                targets.append(ResolvedClaim(ref, target, _concern_of(target)))
        concerns = tuple(dict.fromkeys(t.concern for t in targets))
        out.append(
            WalkedRequirement(
                node=req,
                view=RequirementView(
                    sub_type=req.sub_type,
                    level=req.level(),
                    status=req.status(),
                    path=item.path,
                    package=package,
                    implemented_by_types=concerns,
                ),
                targets=tuple(targets),
            )
        )
    return out


def assert_requirement_test_grain(grain: object) -> None:
    """Refuse anything that is not a grain, rather than running some hybrid of the two.

    Called wherever a grain enters: the identity function and the generator, built-in or
    owned. A config file is not typechecked, so a typo arrives here as a plain string.
    """
    if grain not in REQUIREMENT_TEST_GRAINS:
        expected = " or ".join(repr(g) for g in REQUIREMENT_TEST_GRAINS)
        raise ValueError(f"unknown requirement-test grain {grain!r}: expected {expected}.")


def default_requirement_test_filter(view: RequirementView) -> bool:
    """RECOMMENDATION, not a rule: functional requirements at or below the link floor.

    Architectural requirements are excluded because ``verify``'s universality check already
    proves them structurally, so a test there is usually redundant. Usually, not never, which
    is why this is overridable.
    """
    return (
        view.sub_type == REQUIREMENT_SUBTYPE_FUNCTIONAL
        and (view.level if view.level is not None else 0) >= REQUIREMENT_LINK_FLOOR_LEVEL
    )


def _digest_field(name: str, value: str) -> str:
    # Length-prefixed in BYTES, so no value can be confused with the field that follows it.
    return f"{name} {len(value.encode('utf-8'))}\n{value}\n"


def requirement_digest(node: MetaRequirement) -> str:
    """A fingerprint of the CLAIM: lowercase hex SHA-256 over the requirement's subtype,
    level, status, statement, counterexample and ``@implementedBy`` list (``requirement-digest/v1``).

    It answers "did the claim change", not "did the entry move": the name, package, title,
    notes, disposition, tracking references and nested requirements are left out.
    """

    def prose(name: str) -> str:
        # get_meta_attr RESOLVES (ADR-0039): the digest is over the effective claim.
        value = node.get_meta_attr(name)
        return re.sub(r"\r\n?", "\n", value) if isinstance(value, str) else ""

    level = node.level()
    refs = node.implemented_by()
    text = (
        f"{DIGEST_VERSION}\n"
        + _digest_field("subType", node.sub_type)
        + _digest_field("level", "" if level is None else str(level))
        + _digest_field("status", node.status() or "")
        + _digest_field("statement", prose(REQUIREMENT_ATTR_STATEMENT))
        + _digest_field("counterexample", prose(REQUIREMENT_ATTR_COUNTEREXAMPLE))
        + f"implementedBy {len(refs)}\n"
        + "".join(_digest_field("ref", r) for r in refs)
    )
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def mangle(value: str) -> str:
    """Every maximal run of characters outside ``[A-Za-z0-9]`` becomes one ``_``."""
    # ASCII [A-Za-z0-9] only. `\w` and `str.isalnum()` are both wrong: each keeps `_` and
    # every Unicode letter, so `Orders__Recorded` and `Café` would keep their shape.
    return re.sub(r"[^A-Za-z0-9]+", "_", value)


def witness_key_of(qualified_address: str, unit: str) -> str:
    """An identifier-safe key for one test: ``req_<address>``, then ``__<unit>`` unless the
    requirement resolves no target. Mangling is lossy, which is what
    :func:`witness_key_collisions` exists to report."""
    base = f"req_{mangle(qualified_address)}"
    return base if unit == NO_CONCERN else f"{base}__{mangle(unit)}"


def requirement_test_units(
    walked: WalkedRequirement, grain: str = "concern"
) -> dict[str, list[ResolvedClaim]]:
    """The requirement's targets grouped by fan-out unit under *grain*, first-seen order.

    ``concern``: one entry per distinct ``<type>.<subType>``, NOT per target. ``member``: one
    per distinct reference that resolves, as authored, holding its first claim, so the bare and qualified spellings of
    one node are two units. In both grains a requirement resolving no target yields exactly
    one entry, ``*``.
    """
    assert_requirement_test_grain(grain)
    units: dict[str, list[ResolvedClaim]] = {}
    for target in walked.targets:
        if grain == "concern":
            units.setdefault(target.concern, []).append(target)
        elif target.ref not in units:
            # A reference authored twice is one test, and its first claim is the one kept
            # (the reference implementation does the same): the unit is the reference as
            # written, so a second copy adds nothing a hook or a comment could use.
            units[target.ref] = [target]
    if not units:
        units[NO_CONCERN] = []
    return units


def requirement_test_identity(walked: WalkedRequirement, unit: str) -> RequirementTestIdentity:
    """The identity of the one test *unit* stands for (a key of :func:`requirement_test_units`)."""
    view = walked.view
    address = view.path if view.package == "" else f"{view.package}{PACKAGE_SEP}{view.path}"
    # Derived from the loader's status list rather than naming the two skipped statuses: a
    # status that does not claim the capability works right now is skipped by construction,
    # so a status added later cannot be left failing by omission.
    skips = view.status is not None and view.status not in REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES
    return RequirementTestIdentity(
        package=view.package,
        path=view.path,
        unit=unit,
        id=f"{address} [{unit}]",
        witness_key=witness_key_of(address, unit),
        status=view.status,
        skip=view.status if skips else None,
        digest=requirement_digest(walked.node),
    )


def requirement_test_identities(
    root: MetaData,
    *,
    grain: str = "concern",
    filter: RequirementFilter | None = None,  # noqa: A002 — the seam's published name
) -> list[RequirementTestIdentity]:
    """Every test the generator would emit, sorted by ``id`` (code points, never a locale)."""
    # Checked here as well as per requirement, so a bad grain is refused even over a ledger
    # the filter empties: the answer must not depend on what the model holds.
    assert_requirement_test_grain(grain)
    include = filter if filter is not None else default_requirement_test_filter
    out: list[RequirementTestIdentity] = []
    for walked in walk_requirements(root):
        if not include(walked.view):
            continue
        for unit in requirement_test_units(walked, grain):
            out.append(requirement_test_identity(walked, unit))
    return sorted(out, key=lambda t: t.id)


def witness_key_collisions(tests: list[RequirementTestIdentity]) -> list[tuple[str, str]]:
    """Pairs of ids that share a witness key, each pair and the list sorted."""
    by_key: dict[str, list[str]] = {}
    for t in tests:
        by_key.setdefault(t.witness_key, []).append(t.id)
    pairs: list[tuple[str, str]] = []
    for ids in by_key.values():
        ordered = sorted(ids)
        for i, first in enumerate(ordered):
            for second in ordered[i + 1 :]:
                pairs.append((first, second))
    return sorted(pairs)
