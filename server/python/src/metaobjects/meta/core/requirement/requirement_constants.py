"""Requirement subtype + attr vocabulary.

``requirement.*`` is REGISTERED metamodel vocabulary (requirements-as-metadata
ruling, amendment 3): the capability ledger IS a metadata model, so it is
declared in ``metaobjects/`` beside the entities it describes and validated by
the loader like everything else — never hand-parsed from a side file.
"""

# ---------------------------------------------------------------------------
# Subtypes — the axis is the CHECK POLARITY, a genuine behaviour difference and
# therefore a subtype under ADR-0037 §2:
#   functional    -> EXISTENCE:    fails when nothing implements it
#   architectural -> UNIVERSALITY: fails when something violates it
# ---------------------------------------------------------------------------
REQUIREMENT_SUBTYPE_FUNCTIONAL = "functional"
REQUIREMENT_SUBTYPE_ARCHITECTURAL = "architectural"

REQUIREMENT_SUBTYPES = (
    REQUIREMENT_SUBTYPE_FUNCTIONAL,
    REQUIREMENT_SUBTYPE_ARCHITECTURAL,
)

# ---------------------------------------------------------------------------
# Attrs
# ---------------------------------------------------------------------------
#: 1 solution · 2 segment (app/library) · 3 service · 4 object · 5 member.
REQUIREMENT_ATTR_LEVEL = "level"
REQUIREMENT_ATTR_STATUS = "status"
REQUIREMENT_ATTR_DISPOSITION = "disposition"
REQUIREMENT_ATTR_TRACKED_BY = "trackedBy"
REQUIREMENT_ATTR_STATEMENT = "statement"
REQUIREMENT_ATTR_COUNTEREXAMPLE = "counterexample"
REQUIREMENT_ATTR_IMPLEMENTED_BY = "implementedBy"

# ---------------------------------------------------------------------------
# Status — a closed enum, enforced by the registry via allowed_values.
# ---------------------------------------------------------------------------
# Intended but not built. Its references may legitimately dangle, and it never
# contributes to object coverage -- planning a capability must not silence the
# warning that nothing implements it.
REQUIREMENT_STATUS_PLANNED = "planned"
REQUIREMENT_STATUS_LIVE = "live"
REQUIREMENT_STATUS_PARTIAL = "partial"

REQUIREMENT_STATUSES = (
    REQUIREMENT_STATUS_PLANNED,
    REQUIREMENT_STATUS_LIVE,
    REQUIREMENT_STATUS_PARTIAL,
)

#: Statuses whose implementing nodes are supposed to still exist. A dangling
#: ``@implementedBy`` on one of these means the model moved and the requirement
#: is stale; on the other two the nodes are supposed to be GONE, which is the
#: whole point of the entry. The asymmetry inverts as a pair.
REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES = (
    REQUIREMENT_STATUS_LIVE,
    REQUIREMENT_STATUS_PARTIAL,
)

# ---------------------------------------------------------------------------
# Levels — organisational above the link floor, model-referencing at or below.
# ---------------------------------------------------------------------------
# Statuses with outstanding work, so a @disposition is meaningful on them. On any
# other status the decision IS the status, and recording a second one can only
# agree with it or contradict it.
REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK = (
    REQUIREMENT_STATUS_PLANNED,
    REQUIREMENT_STATUS_PARTIAL,
)

# ---------------------------------------------------------------------------
# Disposition -- what was DECIDED about the outstanding work. Orthogonal to
# status, which says whether the work is done. ABSENT means UNDECIDED, and that
# is the state a review exists to find; collapsing it into the status enum would
# make "there is a gap" and "we chose to live with it" the same fact.
# ---------------------------------------------------------------------------

REQUIREMENT_DISPOSITION_ACCEPTED = "accepted"
REQUIREMENT_DISPOSITION_DEFERRED = "deferred"

# Declaration order is contractual -- see REQUIREMENT_STATUSES.
REQUIREMENT_DISPOSITIONS = (
    REQUIREMENT_DISPOSITION_ACCEPTED,
    REQUIREMENT_DISPOSITION_DEFERRED,
)

REQUIREMENT_LEVEL_SOLUTION = 1
REQUIREMENT_LEVEL_SEGMENT = 2
REQUIREMENT_LEVEL_SERVICE = 3
REQUIREMENT_LEVEL_OBJECT = 4
REQUIREMENT_LEVEL_MEMBER = 5

#: The lowest level that may reference the model. L1-L3 are organisational and
#: carrying ``@implementedBy`` there is an error.
REQUIREMENT_LINK_FLOOR_LEVEL = REQUIREMENT_LEVEL_OBJECT
REQUIREMENT_MIN_LEVEL = REQUIREMENT_LEVEL_SOLUTION
REQUIREMENT_MAX_LEVEL = REQUIREMENT_LEVEL_MEMBER
