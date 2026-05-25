"""Origin subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

ORIGIN_SUBTYPE_PASSTHROUGH = "passthrough"
ORIGIN_SUBTYPE_AGGREGATE = "aggregate"
ORIGIN_SUBTYPE_COLLECTION = "collection"
ORIGIN_SUBTYPES = (
    SUBTYPE_BASE,
    ORIGIN_SUBTYPE_PASSTHROUGH,
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_COLLECTION,
)

# passthrough attrs
ORIGIN_ATTR_FROM = "from"
ORIGIN_ATTR_VIA = "via"

# aggregate attrs
ORIGIN_ATTR_AGG = "agg"
ORIGIN_ATTR_OF = "of"
