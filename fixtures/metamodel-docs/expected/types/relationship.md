<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `relationship` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `relationship` types

Each section below is one `relationship.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### relationship.aggregation

A shared/independent containment — the parent groups the target but does not own its lifecycle (default @onDelete set-null).

**Owning provider:** metaobjects-core-types

**Rules:** M:N is expressed by @cardinality:'many' + @objectRef + @through: @through names a junction entity that MUST declare two identity.reference children (one per FK side), and the relationship's FK fields are DERIVED from those references — never restated. @sourceRefField disambiguates a DIRECTED self-join by naming the source-side FK field on the junction; @symmetric marks an UNDIRECTED self-join (union-on-read) valid only when @objectRef == the declaring entity; the two are mutually exclusive. Aggregation is shared/independent — the target outlives the parent (default @onDelete set-null).

**When to use:** One entity groups others it does NOT own (children outlive the parent; delete sets the FK null). Use instead of composition when there is no ownership.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@cardinality` | string | no |  |  | metaobjects-core-types | Cardinality of the relationship target (e.g. 'one', 'many', 'many-to-one'). |
| `@objectRef` | string | no |  |  | metaobjects-core-types | Name or fully-qualified name of the target object the relationship points to (e.g. 'Week' or 'acme::vehicle::Car'). |
| `@onDelete` | string | no |  | `cascade`, `set-null`, `restrict`, `no-action` | metaobjects-core-types | Referential action on parent delete. Default derives from subtype (composition→cascade, aggregation→set-null, association→restrict). |
| `@onUpdate` | string | no |  | `cascade`, `set-null`, `restrict`, `no-action` | metaobjects-core-types | Referential action on key update. Default cascade. |
| `@sourceRefField` | string | no |  |  | metaobjects-core-types | Directed self-join disambiguator: names the source-side FK field on the junction (the other reference is the target side). Required only for directed/ambiguous self-join M:N. Mutually exclusive with @symmetric. |
| `@symmetric` | boolean | no |  |  | metaobjects-core-types | Undirected self-join flag (union-on-read). Valid only when @objectRef == the declaring entity. Mutually exclusive with @sourceRefField. |
| `@through` | string | no |  |  | metaobjects-core-types | Junction (through) entity name for M:N relationships — a third entity declaring two identity.reference children, one per FK side. The relationship's FK fields are derived from those references. |

**Allowed children**

_No structural children._

### relationship.association

A plain reference to another entity — no ownership; the target has an independent lifecycle (default @onDelete restrict).

**Owning provider:** metaobjects-core-types

**Rules:** M:N is expressed by @cardinality:'many' + @objectRef + @through: @through names a junction entity that MUST declare two identity.reference children (one per FK side), and the relationship's FK fields are DERIVED from those references — never restated. @sourceRefField disambiguates a DIRECTED self-join by naming the source-side FK field on the junction; @symmetric marks an UNDIRECTED self-join (union-on-read) valid only when @objectRef == the declaring entity; the two are mutually exclusive. Association is a plain reference — the target's lifecycle is independent (default @onDelete restrict).

**When to use:** A plain directed reference to another entity, no ownership or cascade. The lightest link — when you just need to point at another entity.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@cardinality` | string | no |  |  | metaobjects-core-types | Cardinality of the relationship target (e.g. 'one', 'many', 'many-to-one'). |
| `@objectRef` | string | no |  |  | metaobjects-core-types | Name or fully-qualified name of the target object the relationship points to (e.g. 'Week' or 'acme::vehicle::Car'). |
| `@onDelete` | string | no |  | `cascade`, `set-null`, `restrict`, `no-action` | metaobjects-core-types | Referential action on parent delete. Default derives from subtype (composition→cascade, aggregation→set-null, association→restrict). |
| `@onUpdate` | string | no |  | `cascade`, `set-null`, `restrict`, `no-action` | metaobjects-core-types | Referential action on key update. Default cascade. |
| `@sourceRefField` | string | no |  |  | metaobjects-core-types | Directed self-join disambiguator: names the source-side FK field on the junction (the other reference is the target side). Required only for directed/ambiguous self-join M:N. Mutually exclusive with @symmetric. |
| `@symmetric` | boolean | no |  |  | metaobjects-core-types | Undirected self-join flag (union-on-read). Valid only when @objectRef == the declaring entity. Mutually exclusive with @sourceRefField. |
| `@through` | string | no |  |  | metaobjects-core-types | Junction (through) entity name for M:N relationships — a third entity declaring two identity.reference children, one per FK side. The relationship's FK fields are derived from those references. |

**Allowed children**

_No structural children._

### relationship.base

Abstract relationship base — shared shape for the concrete association/aggregation/composition subtypes; not authored directly.

**Owning provider:** metaobjects-core-types

**Rules:** @cardinality is an open string at the metamodel level ('one'/'many', and Java-canonical composite forms such as 'many-to-one'); @objectRef names the target entity. M:N is expressed by @cardinality:'many' + @objectRef + @through: @through names a junction entity that MUST declare two identity.reference children (one per FK side), and the relationship's FK fields are DERIVED from those references — never restated. @sourceRefField disambiguates a DIRECTED self-join by naming the source-side FK field on the junction; @symmetric marks an UNDIRECTED self-join (union-on-read) valid only when @objectRef == the declaring entity; the two are mutually exclusive. @onDelete/@onUpdate carry referential actions (cascade/set-null/restrict/no-action).

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@cardinality` | string | no |  |  | metaobjects-core-types | Cardinality of the relationship target (e.g. 'one', 'many', 'many-to-one'). |
| `@objectRef` | string | no |  |  | metaobjects-core-types | Name or fully-qualified name of the target object the relationship points to (e.g. 'Week' or 'acme::vehicle::Car'). |
| `@onDelete` | string | no |  | `cascade`, `set-null`, `restrict`, `no-action` | metaobjects-core-types | Referential action on parent delete. Default derives from subtype (composition→cascade, aggregation→set-null, association→restrict). |
| `@onUpdate` | string | no |  | `cascade`, `set-null`, `restrict`, `no-action` | metaobjects-core-types | Referential action on key update. Default cascade. |
| `@sourceRefField` | string | no |  |  | metaobjects-core-types | Directed self-join disambiguator: names the source-side FK field on the junction (the other reference is the target side). Required only for directed/ambiguous self-join M:N. Mutually exclusive with @symmetric. |
| `@symmetric` | boolean | no |  |  | metaobjects-core-types | Undirected self-join flag (union-on-read). Valid only when @objectRef == the declaring entity. Mutually exclusive with @sourceRefField. |
| `@through` | string | no |  |  | metaobjects-core-types | Junction (through) entity name for M:N relationships — a third entity declaring two identity.reference children, one per FK side. The relationship's FK fields are derived from those references. |

**Allowed children**

_No structural children._

### relationship.composition

An owned containment — the parent owns the target's lifecycle; deleting the parent deletes the children (default @onDelete cascade).

**Owning provider:** metaobjects-core-types

**Rules:** M:N is expressed by @cardinality:'many' + @objectRef + @through: @through names a junction entity that MUST declare two identity.reference children (one per FK side), and the relationship's FK fields are DERIVED from those references — never restated. @sourceRefField disambiguates a DIRECTED self-join by naming the source-side FK field on the junction; @symmetric marks an UNDIRECTED self-join (union-on-read) valid only when @objectRef == the declaring entity; the two are mutually exclusive. Composition is owned lifecycle — the children do not outlive the parent (default @onDelete cascade).

**When to use:** You need a parent that OWNS a child collection (one-to-many, cascade on delete). Declare it to generate the FK + typed navigation instead of a bare FK field + hand-written joins.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@cardinality` | string | no |  |  | metaobjects-core-types | Cardinality of the relationship target (e.g. 'one', 'many', 'many-to-one'). |
| `@objectRef` | string | no |  |  | metaobjects-core-types | Name or fully-qualified name of the target object the relationship points to (e.g. 'Week' or 'acme::vehicle::Car'). |
| `@onDelete` | string | no |  | `cascade`, `set-null`, `restrict`, `no-action` | metaobjects-core-types | Referential action on parent delete. Default derives from subtype (composition→cascade, aggregation→set-null, association→restrict). |
| `@onUpdate` | string | no |  | `cascade`, `set-null`, `restrict`, `no-action` | metaobjects-core-types | Referential action on key update. Default cascade. |
| `@sourceRefField` | string | no |  |  | metaobjects-core-types | Directed self-join disambiguator: names the source-side FK field on the junction (the other reference is the target side). Required only for directed/ambiguous self-join M:N. Mutually exclusive with @symmetric. |
| `@symmetric` | boolean | no |  |  | metaobjects-core-types | Undirected self-join flag (union-on-read). Valid only when @objectRef == the declaring entity. Mutually exclusive with @sourceRefField. |
| `@through` | string | no |  |  | metaobjects-core-types | Junction (through) entity name for M:N relationships — a third entity declaring two identity.reference children, one per FK side. The relationship's FK fields are derived from those references. |

**Allowed children**

_No structural children._

