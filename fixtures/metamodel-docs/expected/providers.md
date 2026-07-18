<!-- @generated — DO NOT EDIT.
     Concern-provider ownership index — which provider owns each type and contributes each attribute.
     Regenerate with: meta docs --metamodel -->

# MetaObjects Metamodel — Providers

The metamodel is composed from concern providers. Each **owns** the
type/subtypes it registers and may **contribute** attributes to types another
provider owns. This is the ownership lens over the same vocabulary
[INDEX.md](INDEX.md) lists by type.

## metaobjects-core-types

Core metaobjects metamodel types and subtypes.

**Owns (registers):** `attr.base`, `attr.boolean`, `attr.class`, `attr.double`, `attr.expression`, `attr.filter`, `attr.int`, `attr.long`, `attr.properties`, `attr.string`, `field.base`, `field.boolean`, `field.currency`, `field.date`, `field.decimal`, `field.double`, `field.enum`, `field.float`, `field.inet`, `field.int`, `field.long`, `field.map`, `field.object`, `field.string`, `field.time`, `field.timestamp`, `field.uri`, `field.uuid`, `identity.primary`, `identity.reference`, `identity.secondary`, `layout.base`, `layout.dataGrid`, `object.base`, `object.entity`, `object.projection`, `object.value`, `origin.aggregate`, `origin.base`, `origin.collection`, `origin.computed`, `origin.first`, `origin.passthrough`, `relationship.aggregation`, `relationship.association`, `relationship.base`, `relationship.composition`, `source.base`, `source.rdb`, `template.base`, `template.output`, `template.prompt`, `template.toolcall`, `validator.array`, `validator.atLeastOne`, `validator.base`, `validator.comparison`, `validator.length`, `validator.numeric`, `validator.presentIff`, `validator.regex`, `validator.required`, `validator.requiredWhen`, `view.base`, `view.currency`

**Contributes attributes:**

- `field.base`: `@default`, `@readOnly`, `@required`, `@unique`
- `field.currency`: `@currency`
- `field.decimal`: `@precision`, `@scale`
- `field.enum`: `@provided`, `@values`
- `field.map`: `@objectRef`, `@valueType`
- `field.object`: `@objectRef`
- `field.string`: `@maxLength`, `@stringFormat`
- `identity.primary`: `@fields`, `@generation`
- `identity.reference`: `@enforce`, `@fields`, `@references`
- `identity.secondary`: `@fields`
- `object.entity`: `@discriminator`, `@discriminatorValue`
- `object.projection`: `@filter`
- `origin.aggregate`: `@agg`, `@distinct`, `@filter`, `@of`, `@orderBy`, `@via`
- `origin.collection`: `@via`
- `origin.computed`: `@expr`
- `origin.first`: `@filter`, `@of`, `@orderBy`, `@via`
- `origin.passthrough`: `@convert`, `@from`, `@via`
- `relationship.aggregation`: `@cardinality`, `@objectRef`, `@onDelete`, `@onUpdate`, `@sourceRefField`, `@symmetric`, `@through`
- `relationship.association`: `@cardinality`, `@objectRef`, `@onDelete`, `@onUpdate`, `@sourceRefField`, `@symmetric`, `@through`
- `relationship.base`: `@cardinality`, `@objectRef`, `@onDelete`, `@onUpdate`, `@sourceRefField`, `@symmetric`, `@through`
- `relationship.composition`: `@cardinality`, `@objectRef`, `@onDelete`, `@onUpdate`, `@sourceRefField`, `@symmetric`, `@through`
- `validator.array`: `@max`, `@min`
- `validator.atLeastOne`: `@fields`
- `validator.base`: `@max`, `@min`
- `validator.comparison`: `@left`, `@op`, `@right`
- `validator.length`: `@max`, `@min`
- `validator.numeric`: `@max`, `@min`
- `validator.presentIff`: `@equals`, `@field`, `@when`
- `validator.regex`: `@max`, `@min`, `@pattern`
- `validator.requiredWhen`: `@equals`, `@field`, `@when`

## metaobjects-db

DB-domain attributes — @column / @db.indexed / @dbColumnType on every field, @storage on field.object, @autoSet on temporal fields, @table/@kind/@role/@schema on source.rdb.

**Contributes attributes:**

- `field.base`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.boolean`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.currency`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.date`: `@autoSet`, `@column`, `@db.indexed`, `@dbColumnType`
- `field.decimal`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.double`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.enum`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.float`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.inet`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.int`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.long`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.map`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.object`: `@column`, `@db.indexed`, `@dbColumnType`, `@storage`
- `field.string`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.time`: `@autoSet`, `@column`, `@db.indexed`, `@dbColumnType`
- `field.timestamp`: `@autoSet`, `@column`, `@db.indexed`, `@dbColumnType`, `@localTime`
- `field.uri`: `@column`, `@db.indexed`, `@dbColumnType`
- `field.uuid`: `@column`, `@db.indexed`, `@dbColumnType`
- `identity.reference`: `@constraintName`
- `identity.secondary`: `@expr`, `@orders`, `@using`, `@where`
- `index.lookup`: `@expr`, `@orders`, `@using`, `@where`
- `source.rdb`: `@function`, `@kind`, `@materializedView`, `@parameterRef`, `@proc`, `@role`, `@schema`, `@sql`, `@table`, `@unmanaged`, `@view`

## metaobjects-documentation

Universal documentation common attrs (description / title / notes / deprecated / replacedBy / seeAlso / aliases) accepted on every metatype.

**Universal attributes (every node):** `@aliases`, `@deprecated`, `@description`, `@notes`, `@replacedBy`, `@seeAlso`, `@summary`, `@title`

## metaobjects-prompt

Prompt / AI + serialization domain — @xmlText / @example / @instruction field markers on every field subtype, the @enumAlias/@enumDoc/@coerceDefault/@normalize tolerant-extract overlays on field.enum, and the object-level @normalize default on object.value.

**Contributes attributes:**

- `field.base`: `@example`, `@instruction`, `@xmlText`
- `field.boolean`: `@example`, `@instruction`, `@xmlText`
- `field.currency`: `@example`, `@instruction`, `@xmlText`
- `field.date`: `@example`, `@instruction`, `@xmlText`
- `field.decimal`: `@example`, `@instruction`, `@xmlText`
- `field.double`: `@example`, `@instruction`, `@xmlText`
- `field.enum`: `@coerceDefault`, `@enumAlias`, `@enumDoc`, `@example`, `@instruction`, `@normalize`, `@xmlText`
- `field.float`: `@example`, `@instruction`, `@xmlText`
- `field.inet`: `@example`, `@instruction`, `@xmlText`
- `field.int`: `@example`, `@instruction`, `@xmlText`
- `field.long`: `@example`, `@instruction`, `@xmlText`
- `field.map`: `@example`, `@instruction`, `@xmlText`
- `field.object`: `@example`, `@instruction`, `@xmlText`
- `field.string`: `@example`, `@instruction`, `@xmlText`
- `field.time`: `@example`, `@instruction`, `@xmlText`
- `field.timestamp`: `@example`, `@instruction`, `@xmlText`
- `field.uri`: `@example`, `@instruction`, `@xmlText`
- `field.uuid`: `@example`, `@instruction`, `@xmlText`
- `object.value`: `@normalize`
- `template.output`: `@format`, `@htmlBodyRef`, `@kind`, `@maxChars`, `@owner`, `@payloadRef`, `@promptStyle`, `@requiredTags`, `@since`, `@subjectRef`, `@textBodyRef`, `@textRef`
- `template.prompt`: `@format`, `@maxChars`, `@maxTokens`, `@model`, `@owner`, `@payloadRef`, `@requiredSlots`, `@requiredTags`, `@responseRef`, `@since`, `@textRef`
- `template.toolcall`: `@owner`, `@payloadRef`, `@since`, `@toolName`

## metaobjects-ui

UI/query-surface domain — @filterable / @sortable / @sortableDefaultOrder field markers driving generated CRUD filter + sort allowlists (Project D).

**Contributes attributes:**

- `field.base`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.boolean`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.currency`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.date`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.decimal`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.double`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.enum`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.float`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.inet`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.int`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.long`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.map`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.object`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.string`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.time`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.timestamp`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.uri`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `field.uuid`: `@filterable`, `@sortable`, `@sortableDefaultOrder`
- `layout.dataGrid`: `@columns`, `@defaultSortField`, `@defaultSortOrder`, `@filter`, `@filterable`, `@pageSize`
- `view.currency`: `@locale`

