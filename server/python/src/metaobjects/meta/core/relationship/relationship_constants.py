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
# M:N junction (through) entity — a third entity declaring two identity.reference
# children, one per FK side. The relationship's FK fields are DERIVED from those
# references (the identity.reference SSOT for FK direction), never restated.
RELATIONSHIP_ATTR_THROUGH = "through"
# M:N directed-self-join disambiguator — names the source-side FK field on the
# junction (the other reference is the target side). Mutually exclusive with
# @symmetric.
RELATIONSHIP_ATTR_SOURCE_REF_FIELD = "sourceRefField"
# M:N undirected-self-join flag — union-on-read; valid only when @objectRef ==
# the declaring entity. Mutually exclusive with @sourceRefField.
RELATIONSHIP_ATTR_SYMMETRIC = "symmetric"

# Cardinality values (for @cardinality). Open string at the metamodel level; the
# CARDINALITY_MANY constant gates M:N validation/derivation.
CARDINALITY_ONE = "one"
CARDINALITY_MANY = "many"

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
