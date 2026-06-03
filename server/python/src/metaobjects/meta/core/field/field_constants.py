"""Field subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

FIELD_SUBTYPE_STRING = "string"
FIELD_SUBTYPE_INT = "int"
FIELD_SUBTYPE_LONG = "long"
FIELD_SUBTYPE_DOUBLE = "double"
FIELD_SUBTYPE_FLOAT = "float"
FIELD_SUBTYPE_BOOLEAN = "boolean"
FIELD_SUBTYPE_DATE = "date"
FIELD_SUBTYPE_TIMESTAMP = "timestamp"
FIELD_SUBTYPE_TIME = "time"
FIELD_SUBTYPE_DECIMAL = "decimal"
FIELD_SUBTYPE_OBJECT = "object"
FIELD_SUBTYPE_CLASS = "class"
FIELD_SUBTYPE_CURRENCY = "currency"
FIELD_SUBTYPE_ENUM = "enum"
# R6 Plan 2a — field.uuid is a logical identity scalar (ADR-0013). String-backed
# on the wire (lowercase-canonical UUID string); the idiomatic native binding
# (Python uuid.UUID) is a build-time codegen concern. A bare scalar like
# field.long: no required attrs, no loader value-validation.
FIELD_SUBTYPE_UUID = "uuid"

FIELD_SUBTYPES = (
    SUBTYPE_BASE,
    FIELD_SUBTYPE_STRING,
    FIELD_SUBTYPE_INT,
    FIELD_SUBTYPE_LONG,
    FIELD_SUBTYPE_DOUBLE,
    FIELD_SUBTYPE_FLOAT,
    FIELD_SUBTYPE_BOOLEAN,
    FIELD_SUBTYPE_DATE,
    FIELD_SUBTYPE_TIMESTAMP,
    FIELD_SUBTYPE_TIME,
    FIELD_SUBTYPE_DECIMAL,
    FIELD_SUBTYPE_OBJECT,
    FIELD_SUBTYPE_CLASS,
    FIELD_SUBTYPE_CURRENCY,
    FIELD_SUBTYPE_UUID,
    # Note: FIELD_SUBTYPE_ENUM is intentionally excluded here; it is registered
    # separately in core_types.py with its dedicated @values AttrSchema.
)

# Reserved field attribute names (read by codegen; open attrs at load time).
# Mirrors server/typescript/packages/metadata/src/core/field/field-constants.ts.
FIELD_ATTR_REQUIRED = "required"
# @readOnly — boolean; the field is exposed read-only (omitted from create/update
# input DTOs). On every field subtype. Mirrors TS FIELD_ATTR_READ_ONLY.
FIELD_ATTR_READ_ONLY = "readOnly"
FIELD_ATTR_UNIQUE = "unique"
# @currency — ISO 4217 code on a field.currency. Storage is integer minor units;
# defaults to "USD" when omitted. Only on field.currency. Mirrors TS FIELD_ATTR_CURRENCY.
FIELD_ATTR_CURRENCY = "currency"
FIELD_ATTR_DEFAULT = "default"
FIELD_ATTR_MAX_LENGTH = "maxLength"
FIELD_ATTR_PRECISION = "precision"
FIELD_ATTR_SCALE = "scale"
FIELD_ATTR_FILTERABLE = "filterable"
FIELD_ATTR_SORTABLE = "sortable"
FIELD_ATTR_SORTABLE_DEFAULT_ORDER = "sortableDefaultOrder"
FIELD_ATTR_AUTO_SET = "autoSet"
FIELD_ATTR_OBJECT_REF = "objectRef"
FIELD_ATTR_VALUES = "values"
# FR-010 field-teaching attrs (any field; drive the output-format prompt fragment).
# Never carried in comments.
FIELD_ATTR_EXAMPLE = "example"
FIELD_ATTR_INSTRUCTION = "instruction"
# FR-010 enum attrs (field.enum only). `properties`-shaped maps:
#   @enumAlias: off-vocabulary token -> canonical member (feeds the extract alias-fold).
#   @enumDoc:   member -> human-readable description (shown per-member in the 'guide' prompt).
FIELD_ATTR_ENUM_ALIAS = "enumAlias"
FIELD_ATTR_ENUM_DOC = "enumDoc"
# FR-011 enum extract-hardening attrs (field.enum only).
#   @coerceDefault: present-but-uncoercible extract fallback member → DEFAULTED.
#       Member-validated against the effective @values (own or inherited).
#   @normalize:     ASCII normalization mode applied during tolerant enum extract.
#       Closed enum (none|collapse|strip, default strip). On field.enum (per-field)
#       and object.value (object-level default for its enum fields). NOT on entity/base.
# @default (FIELD_ATTR_DEFAULT, declared above) doubles as the enum absent-fill member.
FIELD_ATTR_COERCE_DEFAULT = "coerceDefault"
FIELD_ATTR_NORMALIZE = "normalize"
# @normalize closed-enum modes (cross-port; ASCII-only normalization rule).
NORMALIZE_NONE = "none"
NORMALIZE_COLLAPSE = "collapse"
NORMALIZE_STRIP = "strip"
# Default @normalize mode when absent on both field and owning object.
NORMALIZE_DEFAULT = NORMALIZE_STRIP
NORMALIZE_MODES = (NORMALIZE_NONE, NORMALIZE_COLLAPSE, NORMALIZE_STRIP)
# Persistence-side storage shape for owned field.object data. Cross-port values.
FIELD_ATTR_STORAGE = "storage"
STORAGE_VALUES = ("flattened", "jsonb", "subdocument")
# Physical column name override (cross-port; renamed from @dbColumn).
FIELD_ATTR_COLUMN = "column"

# @autoSet allowed values (cross-port).
AUTO_SET_ON_CREATE = "onCreate"
AUTO_SET_ON_UPDATE = "onUpdate"
AUTO_SET_VALUES = (AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE)

# @sortableDefaultOrder allowed values (cross-port).
SORT_ORDER_ASC = "asc"
SORT_ORDER_DESC = "desc"
SORT_ORDER_VALUES = (SORT_ORDER_ASC, SORT_ORDER_DESC)

# Regex pattern for enum member symbols — must be identifier-safe.
# Cross-language contract: every port enforces this pattern.
ENUM_MEMBER_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"
