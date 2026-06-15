<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `validator` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `validator` types

Each section below is one `validator.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### validator.array

Bounds the element count of an array-valued field via @min/@max.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@max` | int | no |  |  | metaobjects-core-types | Maximum allowed value (length, numeric value, or array element count depending on the validator subtype). |
| `@min` | int | no |  |  | metaobjects-core-types | Minimum allowed value (length, numeric value, or array element count depending on the validator subtype). |

**Allowed children**

_No structural children._

### validator.base

Abstract base validator — the shared root subtype concrete validators specialize. Carries the @min/@max bounds attrs but enforces no rule of its own.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@max` | int | no |  |  | metaobjects-core-types | Maximum allowed value (length, numeric value, or array element count depending on the validator subtype). |
| `@min` | int | no |  |  | metaobjects-core-types | Minimum allowed value (length, numeric value, or array element count depending on the validator subtype). |

**Allowed children**

_No structural children._

### validator.length

Bounds string length / collection size via @min/@max.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@max` | int | no |  |  | metaobjects-core-types | Maximum allowed value (length, numeric value, or array element count depending on the validator subtype). |
| `@min` | int | no |  |  | metaobjects-core-types | Minimum allowed value (length, numeric value, or array element count depending on the validator subtype). |

**Allowed children**

_No structural children._

### validator.numeric

Bounds a numeric value's magnitude via @min/@max.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@max` | int | no |  |  | metaobjects-core-types | Maximum allowed value (length, numeric value, or array element count depending on the validator subtype). |
| `@min` | int | no |  |  | metaobjects-core-types | Minimum allowed value (length, numeric value, or array element count depending on the validator subtype). |

**Allowed children**

_No structural children._

### validator.regex

Requires the value match a regular expression (@pattern).

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@max` | int | no |  |  | metaobjects-core-types | Maximum allowed value (length, numeric value, or array element count depending on the validator subtype). |
| `@min` | int | no |  |  | metaobjects-core-types | Minimum allowed value (length, numeric value, or array element count depending on the validator subtype). |
| `@pattern` | string | no |  |  | metaobjects-core-types | Regular expression the value must match. |

**Allowed children**

_No structural children._

### validator.required

Fails when the value is null/empty (NOT NULL). Equivalent to @required on the owning field.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

