<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `origin` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `origin` types

Each section below is one `origin.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### origin.aggregate

A count/sum/avg/min/max (@agg) computed over a column (@of) reached along a relationship path (@via) from the base entity.

**Owning provider:** metaobjects-core-types

**Rules:** @via may be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (single-hop-unique inference; FR-024, ADR-0029). Multi-hop paths must always be stated explicitly.

**When to use:** A projection needs a derived count/sum/avg/min/max over related rows. Declare it instead of hand-writing the aggregate query — it stays consistent and regenerates.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@agg` | string | yes |  | `count`, `sum`, `avg`, `min`, `max` | metaobjects-core-types | Aggregate function applied over the relationship path: count, sum, avg, min, or max. |
| `@of` | string | yes |  |  | metaobjects-core-types | Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes'). |
| `@via` | string | no |  |  | metaobjects-core-types | Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029). |

**Allowed children**

_No structural children._

### origin.base

Abstract base origin — the shared root subtype for field-level provenance. A field carrying any origin.* is derived ⇒ read-only wherever it lives. The base carries no attrs of its own; concrete subtypes add their provenance attrs.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### origin.collection

A relationship-derived array of nested view-objects: walks @via to produce the collection (e.g. 'Author.posts'), or a wildcard selector for a package-spanning collection.

**Owning provider:** metaobjects-core-types

**When to use:** A projection needs an array of nested child view-objects (a parent with its children inline). Declare it instead of hand-assembling the nested query + mapping.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@via` | string | yes |  |  | metaobjects-core-types | Dotted relationship path the collection walks to produce an array of nested view-objects (e.g. 'Author.posts'), or a wildcard selector for a package-spanning collection (e.g. '*.User'). |

**Allowed children**

_No structural children._

### origin.passthrough

A cross-entity field reference: this projection field passes a source entity's value straight through (@from), optionally reached via a relationship path (@via).

**Owning provider:** metaobjects-core-types

**When to use:** A projection field just surfaces a field from a related entity. Declare the cross-entity passthrough instead of re-joining and re-selecting it by hand.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@convert` | boolean | no |  |  | metaobjects-core-types | Acknowledges that this field's declared type deliberately differs from its @from source field's type (#185). Absent/false (the default), a passthrough is type-preserving — a differing field.<subType> or array-ness fails with ERR_PASSTHROUGH_TYPE_MISMATCH. Set true to opt out. This is an acknowledgement only: it does NOT generate a cast — the value flows through unchanged and the consumer owns any coercion. Real type-converting projections are origin.expression's job (#159). |
| `@from` | string | yes |  |  | metaobjects-core-types | Dotted Entity.field reference identifying the source value this projection field passes through (e.g. 'Program.title'). |
| `@via` | string | no |  |  | metaobjects-core-types | Optional dotted relationship path used to reach the source entity (e.g. 'Program.weeks'). |

**Allowed children**

_No structural children._

