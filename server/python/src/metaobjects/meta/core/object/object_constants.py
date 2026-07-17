"""Object subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

OBJECT_SUBTYPE_ENTITY = "entity"
OBJECT_SUBTYPE_VALUE = "value"
# FR-024 (ADR-0028): derived read-only representation of entities.
OBJECT_SUBTYPE_PROJECTION = "projection"
OBJECT_SUBTYPES = (
    SUBTYPE_BASE,
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_VALUE,
    OBJECT_SUBTYPE_PROJECTION,
)

# FR-014 — TPH (Table-per-Hierarchy single-table inheritance) discriminator attrs.
# On every object subtype (base/entity/value). Mirrors TS object-constants.ts.
#   @discriminator      — on a base entity: the field holding the subtype value.
#   @discriminatorValue — on a subtype: the value identifying its rows.
OBJECT_ATTR_DISCRIMINATOR = "discriminator"
OBJECT_ATTR_DISCRIMINATOR_VALUE = "discriminatorValue"

# #207 — object.projection row-scope @filter (view-level WHERE). An optional
# row-scope predicate on an object.projection (a portable attr.filter object —
# the SAME attr subtype as origin.aggregate's @filter) that lowers to an outer
# SQL WHERE. Mirrors TS object-constants.ts OBJECT_PROJECTION_ATTR_FILTER.
OBJECT_PROJECTION_ATTR_FILTER = "filter"
