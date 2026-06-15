<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `identity` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `identity` types

Each section below is one `identity.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### identity.primary

The primary key — one per entity; @fields names its column(s), @generation the value strategy.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@fields` | string[] | yes |  |  | metaobjects-core-types | The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite. |
| `@generation` | string | no |  | `increment`, `uuid`, `assigned` | metaobjects-core-types | Primary-key value generation strategy: 'increment' (auto-increment), 'uuid', or 'assigned' (caller-supplied). |

**Allowed children**

_No structural children._

### identity.reference

A foreign-key reference to another entity (@references target; @enforce toggles a physical FK).

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@enforce` | boolean | no |  |  | metaobjects-core-types | When true (default), the backend physically enforces the reference (SQL FK constraint, document validation rule, graph edge guarantee). Set false to declare a logical reference for navigation/typing/codegen only — the value may dangle at the backend level. |
| `@fields` | string[] | yes |  |  | metaobjects-core-types | The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite. |
| `@references` | string | yes |  |  | metaobjects-core-types | Target of the reference. Bare entity name (e.g. 'Program') resolves to that entity's primary identity. Dotted forms ('Program.id' or 'Program.fieldA,fieldB') target an explicit field set on the entity. |

**Allowed children**

_No structural children._

### identity.secondary

A secondary index (unique by default via @unique).

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@fields` | string[] | yes |  |  | metaobjects-core-types | The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true (default), the secondary identity is a UNIQUE index; false makes it a plain (non-unique) index. |

**Allowed children**

_No structural children._

