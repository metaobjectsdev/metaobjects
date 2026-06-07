"""Object subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

OBJECT_SUBTYPE_ENTITY = "entity"
OBJECT_SUBTYPE_VALUE = "value"
OBJECT_SUBTYPES = (SUBTYPE_BASE, OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_VALUE)

# FR-014 — TPH (Table-per-Hierarchy single-table inheritance) discriminator attrs.
# On every object subtype (base/entity/value). Mirrors TS object-constants.ts.
#   @discriminator      — on a base entity: the field holding the subtype value.
#   @discriminatorValue — on a subtype: the value identifying its rows.
OBJECT_ATTR_DISCRIMINATOR = "discriminator"
OBJECT_ATTR_DISCRIMINATOR_VALUE = "discriminatorValue"
