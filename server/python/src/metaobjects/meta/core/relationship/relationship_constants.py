"""Relationship subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

RELATIONSHIP_SUBTYPE_ASSOCIATION = "association"
RELATIONSHIP_SUBTYPE_AGGREGATION = "aggregation"
RELATIONSHIP_SUBTYPE_COMPOSITION = "composition"

RELATIONSHIP_SUBTYPES = (
    SUBTYPE_BASE,
    RELATIONSHIP_SUBTYPE_ASSOCIATION,
    RELATIONSHIP_SUBTYPE_AGGREGATION,
    RELATIONSHIP_SUBTYPE_COMPOSITION,
)

RELATIONSHIP_ATTR_OBJECT_REF = "objectRef"
RELATIONSHIP_ATTR_CARDINALITY = "cardinality"
RELATIONSHIP_ATTR_JOIN_ENTITY = "joinEntity"
RELATIONSHIP_ATTR_JOIN_FIELDS = "joinFields"

# --- Referential action attrs (@onDelete / @onUpdate) ----------------------

RELATIONSHIP_ATTR_ON_DELETE = "onDelete"
RELATIONSHIP_ATTR_ON_UPDATE = "onUpdate"

# Canonical cross-language referential-action set (kebab-case, no "setDefault").
# MUST equal TS migrate-ts FkAction; mirrors Java REFERENTIAL_ACTIONS.
REFERENTIAL_ACTIONS = ("cascade", "set-null", "restrict", "no-action")

# Default @onDelete per relationship subtype (rollout-decided defaults).
ON_DELETE_DEFAULT_BY_SUBTYPE: dict[str, str] = {
    RELATIONSHIP_SUBTYPE_COMPOSITION: "cascade",
    RELATIONSHIP_SUBTYPE_AGGREGATION: "set-null",
    RELATIONSHIP_SUBTYPE_ASSOCIATION: "restrict",
}

# Default @onUpdate (subtype-independent).
ON_UPDATE_DEFAULT = "cascade"
