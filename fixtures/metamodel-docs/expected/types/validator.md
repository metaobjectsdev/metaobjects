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

### validator.atLeastOne

Cardinality of presence: at least one of the named fields (@fields) must be present (NOT NULL). Entity-scoped; references fields by name (same @fields-by-name pattern as identity.*).

**Owning provider:** metaobjects-core-types

**Rules:** @fields names two or more fields of the owning entity. Satisfied when any one of them is non-null.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@fields` | string[] | yes |  |  | metaobjects-core-types | Names of the candidate fields; at least one must be present. |

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

### validator.comparison

Cross-field ordering: requires two sibling fields of the owning entity stand in a relational order (@left @op @right), e.g. current_hp <= max_hp or expires_at > created_at. Entity-scoped; references fields by name. Backends derive the rule (CHECK constraint, cross-field assertion) — no raw expression is stored.

**Owning provider:** metaobjects-core-types

**Rules:** @left and @right must name fields of the owning entity. @op is one of gt/gte/lt/lte/ne/eq. The comparison is null-tolerant where the backend's relational operator is (SQL: a NULL operand yields no violation).

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@left` | string | yes |  |  | metaobjects-core-types | Name of the left-hand field of the owning entity. |
| `@op` | string | yes |  | `gt`, `gte`, `lt`, `lte`, `ne`, `eq` | metaobjects-core-types | Relational operator: gt (>), gte (>=), lt (<), lte (<=), ne (<>), eq (=). |
| `@right` | string | yes |  |  | metaobjects-core-types | Name of the right-hand field of the owning entity. |

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

### validator.presentIff

Biconditional presence: the target field (@field) is present (NOT NULL) if and only if the gating field (@when) equals @equals. Models paired flag/companion-column invariants, e.g. used_at present iff is_used=true. Entity-scoped; references fields by name.

**Owning provider:** metaobjects-core-types

**Rules:** @field and @when must name fields of the owning entity. @equals is rendered per @when's field subtype. Stricter than requiredWhen — also forbids @field when the condition is false.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@equals` | string | yes |  |  | metaobjects-core-types | The gating value; @field is present exactly when @when equals this. |
| `@field` | string | yes |  |  | metaobjects-core-types | Name of the field whose presence is governed by the condition. |
| `@when` | string | yes |  |  | metaobjects-core-types | Name of the gating field. |

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

### validator.requiredWhen

One-directional conditional presence: when the gating field (@when) equals @equals, the target field (@field) must be present (NOT NULL); otherwise @field is unconstrained. Mirrors JSON Schema dependentRequired / Rails validates_presence_of :x, if:. Entity-scoped; references fields by name.

**Owning provider:** metaobjects-core-types

**Rules:** @field and @when must name fields of the owning entity. @equals is the gating value, compared against @when's value (rendered per @when's field subtype — boolean true/false, enum/string literal, numeric literal).

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@equals` | string | yes |  |  | metaobjects-core-types | The gating value; when @when equals this, @field must be present. |
| `@field` | string | yes |  |  | metaobjects-core-types | Name of the field that becomes required when the condition holds. |
| `@when` | string | yes |  |  | metaobjects-core-types | Name of the gating field whose value triggers the requirement. |

**Allowed children**

_No structural children._

