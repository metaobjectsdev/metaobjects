"""Validator subtype + attr vocabulary (colocated).

Mirrors server/typescript/packages/metadata/src/core/validator/validator-constants.ts.
These are the cross-port-identical names for the ``validator.*`` type family and the
attrs codegen reads when emitting input-validation constraints.
"""

# Validator subtypes (peer of TS VALIDATOR_SUBTYPES).
VALIDATOR_SUBTYPE_REQUIRED = "required"
VALIDATOR_SUBTYPE_LENGTH = "length"
VALIDATOR_SUBTYPE_REGEX = "regex"
VALIDATOR_SUBTYPE_NUMERIC = "numeric"
VALIDATOR_SUBTYPE_ARRAY = "array"
# Cross-field validators — entity-scoped, reference sibling fields by name.
VALIDATOR_SUBTYPE_COMPARISON = "comparison"
VALIDATOR_SUBTYPE_REQUIRED_WHEN = "requiredWhen"
VALIDATOR_SUBTYPE_PRESENT_IFF = "presentIff"
VALIDATOR_SUBTYPE_AT_LEAST_ONE = "atLeastOne"

# Validator attr keys (read by codegen when lowering validator children).
VALIDATOR_ATTR_MIN = "min"
VALIDATOR_ATTR_MAX = "max"
VALIDATOR_ATTR_PATTERN = "pattern"
# Cross-field validator attrs (field references by name + operator/value).
VALIDATOR_ATTR_LEFT = "left"
VALIDATOR_ATTR_OP = "op"
VALIDATOR_ATTR_RIGHT = "right"
VALIDATOR_ATTR_FIELD = "field"
VALIDATOR_ATTR_WHEN = "when"
VALIDATOR_ATTR_EQUALS = "equals"
VALIDATOR_ATTR_FIELDS = "fields"
