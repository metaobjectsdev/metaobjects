"""The base metamodel type names + the shared base/root subtype names."""
TYPE_METADATA = "metadata"
TYPE_OBJECT = "object"
TYPE_FIELD = "field"
TYPE_ATTR = "attr"
TYPE_VALIDATOR = "validator"
TYPE_IDENTITY = "identity"
TYPE_INDEX = "index"
TYPE_RELATIONSHIP = "relationship"
TYPE_VIEW = "view"
TYPE_LAYOUT = "layout"
TYPE_SOURCE = "source"
TYPE_ORIGIN = "origin"
TYPE_TEMPLATE = "template"
TYPE_REQUIREMENT = "requirement"
# FR-044 reporting vocabulary — a named group-by attribute (dimension.attribute,
# dimension.time), a named aggregate (measure.aggregate, measure.ratio) and a named
# row filter (segment.filter), all declared on an object.entity. Mirrors TS
# shared/base-types.ts.
TYPE_DIMENSION = "dimension"
TYPE_MEASURE = "measure"
TYPE_SEGMENT = "segment"
# ADR-0030 / ADR-0063 — the declared API surface (api > operation > binding) and the
# lifecycle moves of a field.enum (transition). Mirrors TS shared/base-types.ts.
TYPE_API = "api"
TYPE_OPERATION = "operation"
TYPE_BINDING = "binding"
TYPE_TRANSITION = "transition"

SUBTYPE_BASE = "base"
SUBTYPE_ROOT = "root"
