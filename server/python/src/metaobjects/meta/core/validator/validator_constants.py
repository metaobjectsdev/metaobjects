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

# Validator attr keys (read by codegen when lowering validator children).
VALIDATOR_ATTR_MIN = "min"
VALIDATOR_ATTR_MAX = "max"
VALIDATOR_ATTR_PATTERN = "pattern"
