"""Field subtype vocabulary (colocated)."""

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

FIELD_SUBTYPES = (
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
    # Note: FIELD_SUBTYPE_ENUM is intentionally excluded here; it is registered
    # separately in core_types.py with its dedicated @values AttrSchema.
)

# Reserved field attribute names (read by codegen; open attrs at load time).
# Mirrors server/typescript/packages/metadata/src/core/field/field-constants.ts.
FIELD_ATTR_REQUIRED = "required"
FIELD_ATTR_UNIQUE = "unique"
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
