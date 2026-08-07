"""Origin subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

ORIGIN_SUBTYPE_PASSTHROUGH = "passthrough"
ORIGIN_SUBTYPE_AGGREGATE = "aggregate"
ORIGIN_SUBTYPE_COLLECTION = "collection"
# #195 — computed: a row-level value from the base entity's own fields via a
# structured @expr tree. first: the single related row picked by @orderBy along
# @via, projecting @of.
ORIGIN_SUBTYPE_COMPUTED = "computed"
ORIGIN_SUBTYPE_FIRST = "first"
ORIGIN_SUBTYPES = (
    SUBTYPE_BASE,
    ORIGIN_SUBTYPE_PASSTHROUGH,
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_COLLECTION,
    ORIGIN_SUBTYPE_COMPUTED,
    ORIGIN_SUBTYPE_FIRST,
)

# #210 — the ASSEMBLY origins: they derive a value by rolling up, computing, or
# collecting from a backing store, which is what an object.projection is for.
# They are illegal on an object.value-hosted field (ERR_SUBTYPE_RULE_VIOLATION);
# ORIGIN_SUBTYPE_PASSTHROUGH is NOT in this set — on a value it is FR-015
# parameter lineage, not an assembly path (ADR-0028). Mirrors the TS
# ASSEMBLY_ORIGIN_SUBTYPES.
ASSEMBLY_ORIGIN_SUBTYPES = (
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_COMPUTED,
    ORIGIN_SUBTYPE_COLLECTION,
    ORIGIN_SUBTYPE_FIRST,
)

# passthrough attrs
ORIGIN_ATTR_FROM = "from"
ORIGIN_ATTR_VIA = "via"
# #185 — acknowledges a deliberate type change on origin.passthrough (opt out of
# the type-preserving ERR_PASSTHROUGH_TYPE_MISMATCH check). Mirrors the TS
# ORIGIN_PASSTHROUGH_ATTR_CONVERT.
ORIGIN_ATTR_CONVERT = "convert"

# aggregate attrs
ORIGIN_ATTR_AGG = "agg"
# #195 — @agg vocabulary: the scalar reducers (count|sum|avg|min|max) plus the
# predicate quantifiers any|all (→ boolean) and the array rollup collect (→ list).
# Mirrors the TS AGG_ANY / AGG_ALL / AGG_COLLECT.
AGG_ANY = "any"
AGG_ALL = "all"
AGG_COLLECT = "collect"
ORIGIN_ATTR_OF = "of"
# @filter (attr.filter object): an optional PORTABLE structured predicate scoping the
# aggregated rows (same shape as a preset filter). On @agg:any|all it is the QUANTIFIED
# predicate (required there); on origin.first it scopes the eligible rows. Codegen renders
# it per target -- the projection view emitter turns it into SQL FILTER (WHERE ...) / CASE WHEN.
ORIGIN_ATTR_FILTER = "filter"
# #195 — shared origin attrs. @distinct (collect-only) applies set semantics;
# @orderBy carries ordering keys ('field[:asc|desc]', nulls-last) used by
# @agg:collect (element order) and required by origin.first (row selection).
ORIGIN_ATTR_DISTINCT = "distinct"
ORIGIN_ATTR_ORDER_BY = "orderBy"
# computed attr — @expr is the structured expression tree (attr.expression).
ORIGIN_ATTR_EXPR = "expr"
