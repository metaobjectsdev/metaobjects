<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `object` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `object` types

Each section below is one `object.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### object.base

Abstract object base — the shared root subtype that concrete object subtypes (entity/value/projection) specialize. Declares the structural children common to EVERY object subtype (the intersection: field/identity/validator/layout/source); subtype-specific children (relationship, template) and attrs (discriminator) ride their own subtypes. Has no runtime semantics of its own; not authored directly.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

- `field.*` — 0..*
- `identity.*` — 0..*
- `layout.*` — 0..*
- `source.*` — 0..*
- `validator.*` — 0..*

### object.entity

An object that owns its data: own identity, writable sources, and lifecycle. The default object subtype — a bare `object:` key resolves to entity. May co-locate templates (template.prompt and friends) with the owning entity.

**Owning provider:** metaobjects-core-types

**Rules:** object.entity owns data — it declares its own identity, its primary source must be a writable @kind (read-only kinds may appear only in a read role), and it carries lifecycle. A field carrying origin.* is derived ⇒ read-only wherever it lives, including on an entity. Templates (template.*) may be nested so a prompt can be co-located with its owning entity. See ADR-0028 (object taxonomy).

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@discriminator` | string | no |  |  | metaobjects-core-types | FR-014: names the field on this entity (resolvable via extends:) that holds the subtype-discriminator value. Subtypes of this entity declare @discriminatorValue to bind their rows to a discriminator value. The discriminator field itself is an ordinary field declaration (typically field.enum or field.int / field.string). |
| `@discriminatorValue` | string | no |  |  | metaobjects-core-types | FR-014: on a subtype of an entity with @discriminator — the value that identifies rows of this subtype in the shared discriminator field. Wire form is always a string; the underlying field's subtype (enum / int / string) controls codegen + storage coercion. Required on every concrete subtype of a discriminated entity. |

**Allowed children**

- `field.*` — 0..*
- `identity.*` — 0..*
- `layout.*` — 0..*
- `relationship.*` — 0..*
- `source.*` — 0..*
- `template.*` — 0..*
- `validator.*` — 0..*

### object.projection

A derived read-only representation of entities. Its fields are extends-bound / origin-derived / self-declared-under-external-assembly, all read-only at the subtype level. Identity is optional and MUST extend an entity identity; sources are restricted to read-only @kinds. The declared field set IS the exposure (inclusive, fail-closed).

**Owning provider:** metaobjects-core-types

**Rules:** object.projection is a derived read-only representation: every field is extends-bound, origin-derived, or self-declared-under-external-assembly, and all are read-only at the subtype level. Identity is optional and, when present, MUST extend an entity identity. Sources are restricted to read-only @kinds. The declared field set IS the exposure — an inclusive list, fail-closed. A projection NEVER declares relationships (derivation is expressed via @via, not a relationship child) and NEVER co-locates templates — hence its child set omits both relationship and template. See ADR-0028 (object taxonomy, projection).

**Attributes**

_No subtype-specific attributes._

**Allowed children**

- `field.*` — 0..*
- `identity.*` — 0..*
- `layout.*` — 0..*
- `source.*` — 0..*
- `validator.*` — 0..*

### object.value

A value object — pure shape with NO identity and NO source, ever. Constructed (by caller / assembly / embedding), never populated from a store. May `extends` an entity's fields to reuse shape. Equality is by content.

**Owning provider:** metaobjects-core-types

**Rules:** object.value is pure shape: it NEVER declares an identity and NEVER declares a source, in any role. It is constructed — by a caller, by assembly, or by embedding — and is never populated from a backing store. It may `extends` an entity's fields to reuse their shape. @normalize is the object-level default ASCII normalization mode applied to this value's enum fields' tolerant extract (each field may still override per-field). See ADR-0028 (object taxonomy, value purity).

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@normalize` | string | no | `strip` | `none`, `collapse`, `strip` | metaobjects-prompt | ASCII normalization mode for tolerant enum extract (none\|collapse\|strip, default strip). On field.enum it is per-field; on object.value it is the default for the object's enum fields. |

**Allowed children**

- `field.*` — 0..*
- `identity.*` — 0..*
- `layout.*` — 0..*
- `relationship.*` — 0..*
- `source.*` — 0..*
- `validator.*` — 0..*

