"""Attribute subtype vocabulary (colocated with the attr node — ADR-0003)."""
from ....shared.base_types import SUBTYPE_BASE  # noqa: F401 (re-export convenience)

ATTR_SUBTYPE_STRING = "string"
ATTR_SUBTYPE_INT = "int"
ATTR_SUBTYPE_LONG = "long"
ATTR_SUBTYPE_DOUBLE = "double"
ATTR_SUBTYPE_BOOLEAN = "boolean"
ATTR_SUBTYPE_FILTER = "filter"
ATTR_SUBTYPE_PROPERTIES = "properties"
ATTR_SUBTYPE_CLASS = "class"
# #195 — a structured expression tree over a base entity's own fields (backs
# origin.computed). Object-shaped; a closed node grammar. Mirrors TS
# ATTR_SUBTYPE_EXPRESSION / meta-attr-expression.ts.
ATTR_SUBTYPE_EXPRESSION = "expression"

# The retired "stringarray" array attr subtype. It is NO LONGER a registered
# (attr, sub_type) (not in ATTR_SUBTYPES) — array-ness is modeled as a "string"
# attr with the orthogonal AttrSchema.is_array flag (matching Java's
# StringAttribute + @isArray), so "stringarray" never appears in the registry
# manifest. The constant survives only as the array-coercion class-map key
# (bare-string → one-element list).
ATTR_SUBTYPE_STRINGARRAY = "stringarray"

ATTR_SUBTYPES = (
    SUBTYPE_BASE,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_LONG,
    ATTR_SUBTYPE_DOUBLE,
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_FILTER,
    ATTR_SUBTYPE_PROPERTIES,
    ATTR_SUBTYPE_CLASS,
    ATTR_SUBTYPE_EXPRESSION,
)
