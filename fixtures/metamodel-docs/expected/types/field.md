<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `field` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `field` types

Each section below is one `field.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### field.base

Abstract base field — the shared root subtype that concrete field subtypes specialize. Carries the attrs common to every field but binds no concrete data type of its own (falls back to string).

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.boolean

True/false flag. Binds to the native boolean type; DB column is BOOLEAN.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.currency

Stores money as integer minor units (cents). Binds to long; the client formats via @currency/@locale. Float arithmetic for money is forbidden.

**Owning provider:** metaobjects-core-types

**Rules:** Storage is integer minor units (cents for USD, yen for JPY) — the wire form is unchanged from long. The server never formats currency; all formatting is client-side via Intl.NumberFormat using @currency (ISO 4217) and @locale (BCP 47). Float arithmetic for money is forbidden.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@currency` | string | no | `USD` |  | metaobjects-core-types | ISO 4217 currency code for a currency-subtype field. Storage is integer minor units; defaults to 'USD' when omitted. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.date

Calendar date (no time-of-day). Binds to the native date/temporal type; DB column is DATE.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@autoSet` | string | no |  | `onCreate`, `onUpdate` | metaobjects-db | Auto-set semantics for timestamp-like fields: 'onCreate' stamps on insert, 'onUpdate' stamps on every write. |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.decimal

Precision-exact decimal (use @precision/@scale). Native TS binding is string (lossless); DB column is NUMERIC(p,s); the wire form is a string. Classified DATA_TYPE_STRING so an exact decimal is never silently rounded through a double.

**Owning provider:** metaobjects-core-types

**Rules:** The wire and native-TS form is a STRING to stay precision-exact end-to-end (Drizzle pg numeric infers as string; SP-H/ADR-0019). Set @precision (total significant digits) and @scale (digits right of the point) to drive NUMERIC(p,s).

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@precision` | int | no |  |  | metaobjects-core-types | Total number of significant digits for decimal-typed fields. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@scale` | int | no |  |  | metaobjects-core-types | Number of digits to the right of the decimal point for decimal-typed fields. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.double

Double-precision (64-bit) IEEE-754 floating point. Binds to the native double/number type; DB column is DOUBLE PRECISION. Not for money — use field.currency or field.decimal.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.enum

String-backed enumeration constrained to a closed set of member symbols (@values). Each member is its own stored string with no name/value divergence.

**Owning provider:** metaobjects-core-types

**Rules:** Required @values is a non-empty, duplicate-free set; each member must match ^[A-Za-z_][A-Za-z0-9_]*$ so symbol == stored string in every target language. Optional FR-010/FR-011 overlays add tolerant-extract aliasing (@enumAlias), per-member docs (@enumDoc), an uncoercible-value fallback (@coerceDefault, must be one of @values), and ASCII normalization mode (@normalize).

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@coerceDefault` | string | no |  |  | metaobjects-prompt | Fallback enum member used by tolerant extract when a present value cannot be coerced; must be one of the field's @values. |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@enumAlias` | properties | no |  |  | metaobjects-prompt | Map of alternate/off-vocabulary tokens to canonical enum members; feeds the FR-010 tolerant extract alias-fold. |
| `@enumDoc` | properties | no |  |  | metaobjects-prompt | Map of enum member to a human-readable description; shown per-member in the FR-010 'guide'-style prompt fragment. |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@normalize` | string | no | `strip` | `none`, `collapse`, `strip` | metaobjects-prompt | ASCII normalization mode for tolerant enum extract (none\|collapse\|strip, default strip). On field.enum it is per-field; on object.value it is the default for the object's enum fields. |
| `@provided` | boolean | no |  |  | metaobjects-core-types | FR-019: marks an abstract package-level field.enum as externally provided — codegen references the type (resolved via per-port codegen config) instead of materializing it. Default false. Not a field attr — it lives on the type declaration. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@values` | string[] | yes |  |  | metaobjects-core-types | Member symbols of an enum-subtype field. Declaration order is significant; each is a legal identifier and its own stored string. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.float

Single-precision floating point. Binds to the native double/number type (TS has no distinct float); DB column is REAL. Not for money.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.int

32-bit signed integer. Binds to the native int type; DB column is INTEGER.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.long

64-bit signed integer. Binds to the native long/bigint type; DB column is BIGINT.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.map

An open-keyed map (Record<string,V> / dict[str,V]) stored in a single jsonb column. Keys are always strings (the JSON object constraint); the value type is set by @valueType (a scalar field subtype) or @objectRef (a value-object).

**Owning provider:** metaobjects-core-types

**Rules:** Keys are always strings. Set exactly one of @valueType (a scalar value subtype: string/int/long/double/float/decimal/boolean/date/time/timestamp/uuid) or @objectRef (a value-object name or FQN). Stored as a single jsonb column holding the JSON object — never a native array; isArray does not apply.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@objectRef` | string | no |  |  | metaobjects-core-types | Name (or FQN) of the value-object for a value-object-valued map. Mutually exclusive with @valueType; exactly one of the two must be set. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@valueType` | string | no |  |  | metaobjects-core-types | Scalar value subtype for a scalar-valued map (string/int/long/double/float/decimal/boolean/date/time/timestamp/uuid). Mutually exclusive with @objectRef; exactly one of the two must be set. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.object

A nested structured value (set @objectRef to the target object). Storage is governed by @storage: flattened (prefixed columns), jsonb (single jsonb column, supports isArray), or subdocument (document-store hint).

**Owning provider:** metaobjects-core-types

**Rules:** Set @objectRef to the nested object's name (or FQN). @storage selects physical layout — flattened expands into prefixed parent columns (isArray must be false), jsonb stores the structured value (or array when isArray=true) in one jsonb column, subdocument emits no Postgres column. Defaults to single-jsonb-column when @storage is absent.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@objectRef` | string | no |  |  | metaobjects-core-types | Name (or FQN) of the target object an object-typed field nests — drives nested-object (de)serialization. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@storage` | string | no |  | `flattened`, `jsonb`, `subdocument` | metaobjects-db | Storage strategy for an object-typed field (set with @objectRef). "flattened" expands the nested value into prefixed columns on the parent table. "jsonb" stores the structured value in a single jsonb column (supports isArray=true for arrays of values). "subdocument" is a hint for document-store codegen targets and emits no Postgres column. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.string

Variable-length text. Binds to the native string type; DB column is VARCHAR/TEXT (use @maxLength for VARCHAR(n)).

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@maxLength` | int | no |  |  | metaobjects-core-types | Maximum character length for string-typed fields (drives VARCHAR(n)). |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.time

Time-of-day (no calendar date). Binds to the native date/temporal type; DB column is TIME.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@autoSet` | string | no |  | `onCreate`, `onUpdate` | metaobjects-db | Auto-set semantics for timestamp-like fields: 'onCreate' stamps on insert, 'onUpdate' stamps on every write. |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.timestamp

Date + time-of-day instant (optionally with timezone). Binds to the native date/temporal type; DB column is TIMESTAMP(TZ). Pair with @autoSet for created/updated stamping.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@autoSet` | string | no |  | `onCreate`, `onUpdate` | metaobjects-db | Auto-set semantics for timestamp-like fields: 'onCreate' stamps on insert, 'onUpdate' stamps on every write. |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

### field.uuid

Logical UUID identity scalar. A bare scalar (no required attrs, no loader value-validation) — binds to TS string (no native UUID type); DB column is Postgres-native uuid.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@column` | string | no |  |  | metaobjects-db | Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy. |
| `@db.indexed` | boolean | no |  |  | metaobjects-db | When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means). |
| `@dbColumnType` | string | no |  |  | metaobjects-db | Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid \| jsonb \| timestamp_with_tz, each legal only on a specific logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). The logical field type and its native binding are unchanged. |
| `@default` | any | no |  |  | metaobjects-core-types | Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue(). |
| `@example` | string | no |  |  | metaobjects-prompt | FR-010: an example value for this field, shown in the generated output-format prompt fragment. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer). |
| `@instruction` | string | no |  |  | metaobjects-prompt | FR-010: a short instruction for this field, shown in the generated output-format prompt fragment. |
| `@readOnly` | boolean | no |  |  | metaobjects-core-types | FR-013: when true, the field is read-only — codegen emits no setter / writable property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/class-validator schemas mark it read-only on input variants. The value is populated by the database (computed column, default expression, trigger), by replication, or by another external owner. |
| `@required` | boolean | no |  |  | metaobjects-core-types | When true, the field is NOT NULL. Equivalent to attaching a validator.required child. |
| `@sortable` | boolean | no |  |  | metaobjects-ui | When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out. |
| `@sortableDefaultOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Default sort direction applied when this field is the default sort field. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true, the field gets a column-level UNIQUE constraint. |
| `@xmlText` | boolean | no |  |  | metaobjects-prompt | When true, this field receives its element's XML TEXT CONTENT during tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. No effect for @format: json. |

**Allowed children**

- `origin.*` — 0..*
- `validator.*` — 0..*
- `view.*` — 0..*

