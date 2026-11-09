<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `object` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta gen (the metamodel-docs generator, metamodelDocsFile()) -->

# Metamodel — `object` types

Each section below is one `object.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### object.base

Abstract object base — the shared root subtype that concrete object subtypes (entity/value/projection) specialize. Declares the structural children common to EVERY object subtype (the intersection: field/identity/validator/layout/source); subtype-specific children (relationship, template) and attrs (discriminator) ride their own subtypes. Has no runtime semantics of its own; not authored directly. A `object.base` node fails to load (ERR_ABSTRACT_SUBTYPE_AUTHORED): this subtype is a registry anchor concrete subtypes inherit from, never a node in a document.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@object` | string | no |  |  | metaobjects-core-types | The native class an object binds to (ADR-0001), in place of its default runtime class: on the JVM, a fully-qualified class name. Cross-port vocabulary only Java implements so far; every port loads and type-checks it, and the others do not act on it yet. |
| `@objectAdapter` | string | no |  |  | metaobjects-core-types | JVM-only (ADR-0005): the fully-qualified name of an ObjectAdapter that takes over value access for this object's instances. Every port loads and type-checks it; only Java and Kotlin act on it. |

**Allowed children**

- `field.*` — 0..*
- `identity.*` — 0..*
- `index.*` — 0..*
- `layout.*` — 0..*
- `source.*` — 0..*
- `validator.*` — 0..*

### object.entity

An object that owns its data: own identity, writable sources, and lifecycle. The default object subtype — a bare `object:` key resolves to entity. May co-locate templates (template.prompt and friends) with the owning entity.

**Owning provider:** metaobjects-core-types

**Rules:** object.entity owns data — it declares its own identity, its primary source must be a writable @kind (read-only kinds may appear only in a read role), and it carries lifecycle. A field carrying origin.* is derived ⇒ read-only wherever it lives, including on an entity. Templates (template.*) may be nested so a prompt can be co-located with its owning entity. See ADR-0028 (object taxonomy).

**When to use:** The thing owns its own data and lifecycle — a table you create/read/update/delete. The default for any persisted resource.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@collectionName` | string | no |  |  | metaobjects-core-types | The name of this object's collection, in the object's own casing (e.g. 'CaseHistory', 'Queues'): the C# DbSet property, the REST collection segment (snake_cased: case_history), the TypeScript collection exports and finders (list<Name>), and the reverse @via hop other objects walk to reach it. It need not be a grammatical plural. Absent, the project's pluralizer derives it from the object's name (naming.collections in .metaobjects/config.json; built in: standard, none; an application may register its own). |
| `@dbSetName` | string | no |  |  | metaobjects-core-types | DEPRECATED (rc.19): use @collectionName, which this is an alias of for one release; code generation warns where it reads it, and refuses an object declaring both. Every port loads and type-checks it. |
| `@discriminator` | string | no |  |  | metaobjects-core-types | FR-014: names the field on this entity (resolvable via extends:) that holds the subtype-discriminator value. Subtypes of this entity declare @discriminatorValue to bind their rows to a discriminator value. The discriminator field itself is an ordinary field declaration (typically field.enum or field.int / field.string). |
| `@discriminatorValue` | string | no |  |  | metaobjects-core-types | FR-014: on a subtype of an entity with @discriminator — the value that identifies rows of this subtype in the shared discriminator field. Wire form is always a string; the underlying field's subtype (enum / int / string) controls codegen + storage coercion. Required on every concrete subtype of a discriminated entity. |
| `@object` | string | no |  |  | metaobjects-core-types | The native class an object binds to (ADR-0001), in place of its default runtime class: on the JVM, a fully-qualified class name. Cross-port vocabulary only Java implements so far; every port loads and type-checks it, and the others do not act on it yet. |
| `@objectAdapter` | string | no |  |  | metaobjects-core-types | JVM-only (ADR-0005): the fully-qualified name of an ObjectAdapter that takes over value access for this object's instances. Every port loads and type-checks it; only Java and Kotlin act on it. |

**Allowed children**

- `dimension.*` — 0..*
- `field.*` — 0..*
- `identity.*` — 0..*
- `index.*` — 0..*
- `layout.*` — 0..*
- `measure.*` — 0..*
- `relationship.*` — 0..*
- `segment.*` — 0..*
- `source.*` — 0..*
- `template.*` — 0..*
- `validator.*` — 0..*

### object.projection

A derived read-only representation of entities. Its fields are extends-bound / origin-derived / self-declared-under-external-assembly, all read-only at the subtype level. Identity is optional and MUST extend an entity identity; sources are restricted to read-only @kinds. The declared field set IS the exposure (inclusive, fail-closed).

**Owning provider:** metaobjects-core-types

**Rules:** object.projection is a derived read-only representation: every field is extends-bound, origin-derived, or self-declared-under-external-assembly, and all are read-only at the subtype level. Identity is optional and, when present, MUST extend an entity identity. Sources are restricted to read-only @kinds. The declared field set IS the exposure — an inclusive list, fail-closed. A projection NEVER declares relationships (derivation is expressed via @via, not a relationship child) and NEVER co-locates templates — hence its child set omits both relationship and template. The assembly origins (origin.aggregate / origin.computed / origin.first) live HERE, not on object.value; a SOURCELESS projection is the legal shape for a wire-assembled read model, and a template-level @payloadRef/@responseRef may target one (#210). See ADR-0028 (object taxonomy, projection).

**When to use:** You need a derived, read-only view over entities — a report, summary, or joined/aggregated read model. Declare it (with origin.* children) instead of hand-writing the SELECT/joins; it stays read-only and regenerates.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@collectionName` | string | no |  |  | metaobjects-core-types | The name of this object's collection, in the object's own casing (e.g. 'CaseHistory', 'Queues'): the C# DbSet property, the REST collection segment (snake_cased: case_history), the TypeScript collection exports and finders (list<Name>), and the reverse @via hop other objects walk to reach it. It need not be a grammatical plural. Absent, the project's pluralizer derives it from the object's name (naming.collections in .metaobjects/config.json; built in: standard, none; an application may register its own). |
| `@dbSetName` | string | no |  |  | metaobjects-core-types | DEPRECATED (rc.19): use @collectionName, which this is an alias of for one release; code generation warns where it reads it, and refuses an object declaring both. Every port loads and type-checks it. |
| `@filter` | filter | no |  |  | metaobjects-core-types | Optional row-scope predicate (a portable attr.filter object: eq/ne/gt/gte/lt/lte/like/in/isNull with and/or, desugared to { field: { op: value } } at parse time) selecting which rows the view returns — lowered to an outer SQL WHERE. A key names one of the projection's own fields, else a field of its base entity the view need not output, else a PATH of to-one hops (identity.reference or @cardinality one relationship names) from the base then a field of the entity reached ('caseId.patientId.hasActiveHipaaConsent'), joined but not output. A reached entity field may itself be derived (entity-derived: an origin.computed or origin.first declared on the entity, inlined where the filter reaches it). An aggregate-derived field is not addressable (fail-closed); a to-many hop is refused. A value may be a relative date ({ now: "<ISO-8601 duration>", startOf? }) on a date or timestamp field (rc.19). |
| `@object` | string | no |  |  | metaobjects-core-types | The native class an object binds to (ADR-0001), in place of its default runtime class: on the JVM, a fully-qualified class name. Cross-port vocabulary only Java implements so far; every port loads and type-checks it, and the others do not act on it yet. |
| `@objectAdapter` | string | no |  |  | metaobjects-core-types | JVM-only (ADR-0005): the fully-qualified name of an ObjectAdapter that takes over value access for this object's instances. Every port loads and type-checks it; only Java and Kotlin act on it. |

**Allowed children**

- `field.*` — 0..*
- `identity.*` — 0..*
- `index.*` — 0..*
- `layout.*` — 0..*
- `source.*` — 0..*
- `validator.*` — 0..*

### object.report

A declared report (FR-044): a fixed combination of dimensions and measures of ONE entity (@from), compiled to a read-only view. One row per distinct dimension tuple; no dimensions means exactly one row. Fields are DERIVED, not declared: one per dimension (a time dimension's field is <dimension><Grain>, e.g. purchasedAtDay) and one per measure. Every measure must belong to @from (two fact tables are two reports). @filter and @segment scope rows before grouping and combine by AND. Read-only: no writes, no get-by-id.

**Owning provider:** metaobjects-core-types

**When to use:** Dashboard totals, per-day series and per-group summaries that would otherwise be hand-written GROUP BY queries.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@collectionName` | string | no |  |  | metaobjects-core-types | The name of this object's collection, in the object's own casing (e.g. 'CaseHistory', 'Queues'): the C# DbSet property, the REST collection segment (snake_cased: case_history), the TypeScript collection exports and finders (list<Name>), and the reverse @via hop other objects walk to reach it. It need not be a grammatical plural. Absent, the project's pluralizer derives it from the object's name (naming.collections in .metaobjects/config.json; built in: standard, none; an application may register its own). |
| `@dbSetName` | string | no |  |  | metaobjects-core-types | DEPRECATED (rc.19): use @collectionName, which this is an alias of for one release; code generation warns where it reads it, and refuses an object declaring both. Every port loads and type-checks it. |
| `@dimensions` | string[] | no |  |  | metaobjects-core-types | Dimension names of @from; a time dimension is written 'name:grain'. Absent means one global row. |
| `@filter` | filter | no |  |  | metaobjects-core-types | Optional row scope over @from's fields; may use relative-date values. |
| `@from` | string | yes |  |  | metaobjects-core-types | The object.entity whose rows the report aggregates. |
| `@measures` | string[] | yes |  |  | metaobjects-core-types | Measure names of @from. |
| `@object` | string | no |  |  | metaobjects-core-types | The native class an object binds to (ADR-0001), in place of its default runtime class: on the JVM, a fully-qualified class name. Cross-port vocabulary only Java implements so far; every port loads and type-checks it, and the others do not act on it yet. |
| `@objectAdapter` | string | no |  |  | metaobjects-core-types | JVM-only (ADR-0005): the fully-qualified name of an ObjectAdapter that takes over value access for this object's instances. Every port loads and type-checks it; only Java and Kotlin act on it. |
| `@segment` | string | no |  |  | metaobjects-core-types | Optional segment of @from scoping the rows. |
| `@spine` | string | no |  |  | metaobjects-core-types | Optional to-one path from @from to the entity whose rows supply the report's rows (e.g. 'Purchase.program'), written like a dimension's @via. With it the report has one row per distinct dimension tuple among THAT entity's rows, including the ones no row of @from refers to: a count there is 0 and any other measure is null unless it declares @default. Every listed dimension must be reached through this path. @segment and @filter still scope the rows of @from and never remove a row. A row of @from whose reference is null or matches nothing is in no row of the report. |

**Allowed children**

- `field.*` — 0..*
- `identity.*` — 0..*
- `index.*` — 0..*
- `layout.*` — 0..*
- `source.*` — 0..*
- `validator.*` — 0..*

### object.value

A value object — pure shape with NO identity and NO source, ever. Constructed (by caller / embedding), never populated from a store. May `extends` an entity's fields to reuse shape. Equality is by content.

**Owning provider:** metaobjects-core-types

**Rules:** object.value is pure shape: it NEVER declares an identity and NEVER declares a source, in any role. It is constructed — by a caller or by embedding — and is never populated from a backing store. A value-hosted field may carry origin.passthrough (FR-015 parameter lineage) but NEVER an assembly origin (origin.aggregate / origin.computed / origin.first) — passthrough on a value is lineage; assembly origins live on object.projection (#210). It may `extends` an entity's fields to reuse their shape. @normalize is the object-level default ASCII normalization mode applied to this value's enum fields' tolerant extract (each field may still override per-field). See ADR-0028 (object taxonomy, value purity).

**When to use:** You need a reusable typed shape with NO identity and NO table — an embedded value, a DTO, a prompt/response payload. Constructed in memory, never persisted on its own.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@normalize` | string | no | `strip` | `none`, `collapse`, `strip` | metaobjects-prompt | ASCII normalization mode for tolerant enum extract (none\|collapse\|strip, default strip). On field.enum it is per-field; on object.value it is the default for the object's enum fields. |
| `@object` | string | no |  |  | metaobjects-core-types | The native class an object binds to (ADR-0001), in place of its default runtime class: on the JVM, a fully-qualified class name. Cross-port vocabulary only Java implements so far; every port loads and type-checks it, and the others do not act on it yet. |
| `@objectAdapter` | string | no |  |  | metaobjects-core-types | JVM-only (ADR-0005): the fully-qualified name of an ObjectAdapter that takes over value access for this object's instances. Every port loads and type-checks it; only Java and Kotlin act on it. |

**Allowed children**

- `field.*` — 0..*
- `identity.*` — 0..*
- `index.*` — 0..*
- `layout.*` — 0..*
- `relationship.*` — 0..*
- `source.*` — 0..*
- `validator.*` — 0..*

