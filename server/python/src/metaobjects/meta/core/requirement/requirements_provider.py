"""requirements_provider -- the requirements pack (cross-port ``metaobjects-requirements``).

``requirement.functional`` / ``requirement.architectural``, and the rule that admits a
``requirement`` on a document root (``requirement.json`` ``extends``, applied below). It
is its OWN provider so a project can leave it out; it is in the default bundle
(``core_providers``), so every existing model loads unchanged. Compose it out and a model
that declares a requirement fails at load; one that declares none sees nothing. Mirrors
the TS ``requirementsProvider``.
"""
from __future__ import annotations

from ....provider import Provider
from ....registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry
from ....shared.base_types import TYPE_ATTR, TYPE_REQUIREMENT
from ...provider_extends import register_extends
from ..attr.attr_constants import ATTR_SUBTYPE_INT, ATTR_SUBTYPE_STRING
from .meta_requirement import MetaRequirement
from .requirement_constants import (
    REQUIREMENT_ATTR_COUNTEREXAMPLE,
    REQUIREMENT_ATTR_DISPOSITION,
    REQUIREMENT_ATTR_IMPLEMENTED_BY,
    REQUIREMENT_ATTR_LEVEL,
    REQUIREMENT_ATTR_STATEMENT,
    REQUIREMENT_ATTR_STATUS,
    REQUIREMENT_ATTR_SUPERSEDED_BY,
    REQUIREMENT_ATTR_TRACKED_BY,
    REQUIREMENT_DISPOSITIONS,
    REQUIREMENT_STATUSES,
    REQUIREMENT_SUBTYPE_ARCHITECTURAL,
    REQUIREMENT_SUBTYPE_FUNCTIONAL,
)

requirements_provider = Provider(
    "metaobjects-requirements", dependencies=("metaobjects-core-types",)
)

# requirement.* (functional, architectural) — the capability ledger IS a metadata
# model (requirements-as-metadata ruling, amendment 3), so it is registered
# vocabulary rather than a hand-parsed side file: @status is an allowedValues enum
# the LOADER refuses a typo on. The axis is CHECK POLARITY, a genuine behaviour
# difference (ADR-0037 §2): `functional` is checked by EXISTENCE (nothing
# implements it -> fail), `architectural` by UNIVERSALITY (something violates it
# -> fail). Architectural carries no @level — levels come from
# object-in-focus decomposition and an architectural requirement is
# object-independent by definition.
#
# Hierarchy is NESTING, not a parent attr: requirement.functional admits nested
# requirement children (the strict graph in spec/metamodel/requirement.json, which
# _apply_strict_structural_children re-derives onto this registration).
#
# @implementedBy is deliberately NOT declared as a loader `references` descriptor.
# That pass always ERRORS on an unresolved target, and a requirement with status
# `planned` names nodes that do not exist YET — declaring
# it here would make those entries fail to load. The loader owns what is
# unconditional; `verify` owns @implementedBy resolution, whose severity depends on
# @status.
_REQUIREMENT_COMMON_ATTRS = [
    AttrSchema(
        name=REQUIREMENT_ATTR_STATUS,
        value_type=ATTR_SUBTYPE_STRING,
        required=True,
        allowed_values=REQUIREMENT_STATUSES,
    ),
    # What was DECIDED about the outstanding work -- a different question from
    # whether the work is done, which is what @status answers. ABSENT means
    # UNDECIDED, a real state and the one a review exists to find.
    AttrSchema(
        name=REQUIREMENT_ATTR_DISPOSITION,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=REQUIREMENT_DISPOSITIONS,
    ),
    # Issue/ticket references for outstanding work. Free-form and never resolved:
    # verify has no network, so nothing here is checked to exist.
    AttrSchema(
        name=REQUIREMENT_ATTR_TRACKED_BY,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        is_array=True,
    ),
    AttrSchema(name=REQUIREMENT_ATTR_STATEMENT, value_type=ATTR_SUBTYPE_STRING, required=True),
    AttrSchema(name=REQUIREMENT_ATTR_COUNTEREXAMPLE, value_type=ATTR_SUBTYPE_STRING, required=True),
    # FR-039 -- the requirement that REPLACED a retired one. Declared BEFORE
    # @implementedBy to match the canonical spec's child order, which the registry
    # manifest emits verbatim and every port byte-matches.
    AttrSchema(
        name=REQUIREMENT_ATTR_SUPERSEDED_BY,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
    ),
    AttrSchema(
        name=REQUIREMENT_ATTR_IMPLEMENTED_BY,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        is_array=True,
    ),
]
requirements_provider.add(
    TypeDefinition(
        type=TYPE_REQUIREMENT,
        sub_type=REQUIREMENT_SUBTYPE_FUNCTIONAL,
        factory=MetaRequirement,
        attrs=[
            # REQUIRED on functional: levels are the object-in-focus decomposition
            # and a functional requirement always sits at one.
            AttrSchema(name=REQUIREMENT_ATTR_LEVEL, value_type=ATTR_SUBTYPE_INT, required=True),
            *_REQUIREMENT_COMMON_ATTRS,
        ],
        child_rules=[
            ChildRule(TYPE_ATTR, "*"),
            # Hierarchy IS nesting — an L1 solution contains its L2 segments.
            ChildRule(TYPE_REQUIREMENT, "*"),
        ],
    )
)
requirements_provider.add(
    TypeDefinition(
        type=TYPE_REQUIREMENT,
        sub_type=REQUIREMENT_SUBTYPE_ARCHITECTURAL,
        factory=MetaRequirement,
        attrs=[
            # OPTIONAL on architectural: absent means a flat, object-independent
            # policy (the original and still the default form); present opts the
            # node into a levelled tree, e.g. a quality taxonomy over the
            # non-functional set. Opt-in precisely so that adding a taxonomy over
            # existing flat policies cannot invalidate them.
            AttrSchema(name=REQUIREMENT_ATTR_LEVEL, value_type=ATTR_SUBTYPE_INT, required=False),
            *_REQUIREMENT_COMMON_ATTRS,
        ],
        child_rules=[
            ChildRule(TYPE_ATTR, "*"),
            # BOTH subtypes nest. Declaring this on `functional` only was an
            # omission, not a design: it made an architectural node nestable under
            # a FUNCTIONAL parent but never under another architectural one.
            ChildRule(TYPE_REQUIREMENT, "*"),
        ],
    )
)


def _register(registry: TypeRegistry) -> None:
    register_extends(registry, "requirement.json")


requirements_provider.on_register(_register)
