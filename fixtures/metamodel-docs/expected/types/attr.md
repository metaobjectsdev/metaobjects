<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `attr` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `attr` types

Each section below is one `attr.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### attr.base

Abstract base attribute — the polymorphic/unconstrained value-type marker. Stores its value type-preserved (never stringified), accepting any type; used for an untyped attr (e.g. a field's @default, whose value-type follows the owning field's subtype).

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.boolean

A boolean-valued metadata attribute. Coerces to and validates as true/false.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.class

A class-/type-reference-valued metadata attribute. String-backed (a fully-qualified class or type name) used by binding facets.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.double

A double-precision floating-point-valued metadata attribute. Coerces to and validates as a number.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.expression

A structured expression tree over a base entity's own fields (closed node grammar: field/value refs, comparisons sharing the filter op vocabulary, isNull/isNotNull, and/or/not, coalesce). Backs origin.computed; a filter object embeds canonically. Additive node kinds (arithmetic/case/via-joined refs) are #159.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.filter

A filter-expression-valued metadata attribute. Object-shaped value that desugars a preset filter to the canonical { field: { op: value } } form (scalar→eq, array→in, null→isNull; or/and recurse).

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.int

A 32-bit-integer-valued metadata attribute. Coerces to and validates as a number.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.intMap

An object-shaped attribute whose values are all integers (e.g. field.enum's @intValueMap: {memberSymbol: int}). Generic shape check only; a consumer field type layers its own semantic rules (key-set membership, uniqueness) in its own content-rule validation.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.long

A 64-bit-integer-valued metadata attribute. Coerces to and validates as a number.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.properties

A key/value map attribute (a bag of arbitrary author-supplied properties). Object-shaped value; the registered escape hatch for author-supplied properties (exempt from the strict-attr check, ADR-0023).

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### attr.string

A string-valued metadata attribute. Coerces to and validates as text; the default value-type for inline @-syntax attrs (array-of-string is the same subtype with isArray).

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

