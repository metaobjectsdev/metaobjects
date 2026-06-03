---
name: metaobjects-authoring
description: Use when authoring or modifying MetaObjects metadata — fields, entities, relationships, sources, enums, abstracts/inheritance — in YAML or canonical JSON.
---

# Authoring MetaObjects metadata

MetaObjects metadata is the durable spine of your app: typed entity declarations
that drive code generation, runtime behavior, and drift detection. You author it,
the loader reads it, the codegen emits idiomatic per-language code from it. This
skill is the procedure for writing it correctly.

Metadata lives in files under `metaobjects/` at project root, one file per domain
concept (`meta.commerce.json`, `meta.users.yaml`, …). Each file declares a
`package` on its root node. Files in the same `package` with the same object
`name` are merged by the loader.

Two on-disk formats, one shape:

- **Canonical JSON** — the on-disk interchange. Every node is a single-key map
  whose key fuses the type and subtype.
- **YAML** — the sigil-free authoring front-end. Lowered to canonical JSON at load
  time, so it shares the entire downstream pipeline.

Author in whichever fits the project. Prefer YAML for new hand-authored metadata
(it's less noisy); JSON is the format conformance fixtures and tooling pin.

## The fused-key encoding (non-negotiable)

Every node is `{ "<type>.<subType>": { <body> } }`. The wrapper key fuses type and
subtype — there is **no** separate `subType` body key.

```json
{ "object.entity": { "name": "User" } }
{ "field.string": { "name": "email", "@required": true } }
{ "field.enum":   { "name": "status", "@values": ["OPEN", "CLOSED"] } }
{ "identity.primary": { "@fields": ["id"] } }
```

A complete entity in canonical JSON:

```json
{
  "metadata.root": {
    "package": "acme::blog",
    "children": [
      {
        "object.entity": {
          "name": "Author",
          "children": [
            { "source.rdb":   { "@table": "authors" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
            { "field.string": { "name": "bio",  "@maxLength": 2000 } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
          ]
        }
      }
    ]
  }
}
```

The same entity in sigil-free YAML:

```yaml
metadata:
  package: acme::blog
  children:
    - object.entity:
        name: Author
        children:
          - source.rdb: { table: authors }
          - field.long:   { name: id }
          - field.string: { name: name, required: true, maxLength: 200 }
          - field.string: { name: bio, maxLength: 2000 }
          - identity.primary: { fields: id, generation: increment }
```

## Reserved structural keys vs. attributes

There is one closed set of **reserved structural keys**. Everything else is an
attribute.

```
name   package   extends   abstract   overlay   isArray   children   value
```

- In **canonical JSON**: reserved keys are bare (`"name"`, `"extends"`); every
  other key is `@`-prefixed (`"@required"`, `"@maxLength"`, `"@table"`).
- In **YAML**: reserved keys are bare AND attributes are bare too — the desugar
  re-adds the `@` when lowering.
- `@`-prefixing a reserved word (e.g. `"@isArray": true`) is invalid and fails the
  load with `ERR_RESERVED_ATTR`. Use the bare `isArray: true` (YAML) or the `[]`
  key-suffix sugar (`field.long[]: weekIds`).

## Two violation rules — internalize these

1. **Attribute-name uniqueness within a node.** A node body must not declare the
   same attribute name twice. `{ "field.string": { "name": "x", "@maxLength": 10,
   "@maxLength": 20 } }` is malformed.

2. **An inline `@attr` IS an `attr` child — never both.** An inline attribute and
   a child `attr.*` node with the same name are the same slot expressed two ways.
   Declare a given attribute once, in one form. Don't set `@required` inline AND
   also add an `attr.boolean` child named `required` — that's a double-declaration.

## Field subtypes (closed vocabulary)

| Subtype | Stores | Notes |
|---|---|---|
| `field.string` | text | `@maxLength` drives `varchar(N)` |
| `field.int` | 32-bit integer | |
| `field.long` | 64-bit integer | |
| `field.double` | float | |
| `field.boolean` | true/false | |
| `field.date` | calendar date | ISO 8601 `YYYY-MM-DD` on the wire |
| `field.timestamp` | instant | ISO 8601 with timezone on the wire |
| `field.decimal` | exact decimal | `@precision` / `@scale`; lossless money/quantity |
| `field.currency` | integer minor units | see Currency below |
| `field.enum` | string member | `@values` required; see Enum below |
| `field.uuid` | UUID | canonical lowercase hex on the wire |
| `field.object` | embedded value object | `@objectRef` + `@storage`; see below |

Common field attributes: `@required`, `@maxLength`, `@column` (physical column
name), `@default`, `@filterable`, `@sortable`.

### Currency

`field.currency` stores money as **integer minor units** (cents for USD, yen for
JPY) — never a float. `@currency` is ISO 4217; `@locale` (on a `view.currency`
child) is BCP 47. The server never formats currency; formatting is client-side.

```json
{ "field.currency": {
    "name": "priceCents", "@currency": "USD", "@required": true,
    "children": [ { "view.currency": { "@locale": "en-US" } } ]
}}
```

### Enum

`field.enum` is string-backed. `@values` is **required**: a non-empty set of
unique members, each matching `^[A-Za-z_][A-Za-z0-9_]*$`. Missing `@values` →
`ERR_MISSING_REQUIRED_ATTR`; a bad member → `ERR_BAD_ATTR_VALUE`.

```json
{ "field.enum": { "name": "status", "@required": true,
    "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } }
```

Reuse a constraint set across entities with an abstract `field.enum` + `extends`.

### Embedded value objects — `field.object` + `@storage`

`field.object` embeds another `object` declaration. `@objectRef` names it;
`@storage` controls persistence:

- `flattened` — one DB column per sub-field (`address_street`, `address_city`, …).
  Illegal on array fields.
- `jsonb` — one `jsonb` column.
- `subdocument` (default, back-compat) — single jsonb column.

```json
{ "field.object": { "name": "address", "@objectRef": "Address", "@storage": "flattened" } }
```

## YAML sigil-free authoring + the coercion footgun

In YAML, write the fused `type.subType` key with a **map body**, bare reserved
keys, bare attributes. Two house-style rules:

1. **Always write the explicit `type.subType`** (`field.string`, not `field`).
   Defaults change; the explicit form survives registry edits.

2. **Quote any scalar that looks like a boolean, number, date, or null.** YAML
   silently coerces unquoted `yes` / `no` / `on` / `off` to booleans and bare
   `2026-05-25` to a date. The loader's coercion guard rejects a coerced value in
   a slot that declares a different type (`ERR_YAML_COERCION`) — but quoting is how
   you *prevent* the surprise. Enum members are the classic trap:

   ```yaml
   # Rejected — Y and N coerce to booleans
   field.enum: { name: flag, values: [Y, N] }
   # Correct — quote domain-data members
   field.enum: { name: flag, values: ["Y", "N"] }
   ```

The `[]` key-suffix declares an array field: `field.long[]: weekIds` lowers to
`{ "field.long": { "name": "weekIds", "isArray": true } }`.

## Identities

| Subtype | Purpose | Key attrs |
|---|---|---|
| `identity.primary` | the PK field(s) | `@fields`, `@generation` |
| `identity.secondary` | a unique secondary index | `@fields` |
| `identity.reference` | an inbound FK from this entity to another | `@fields`, `@references`, `@enforce` |

`@generation` on a primary controls value generation (e.g. `increment`).
`@fields` accepts a single string in authoring; it normalizes to an array in
canonical JSON. `@enforce` on a reference (default `true`) controls whether the
backend physically enforces it (a SQL FK constraint); set `false` for a logical
reference for navigation/typing/codegen only. Referential actions
(`@onDelete`/`@onUpdate`) are NOT on `identity.reference` — they live on the
`relationship.*` node (see Relationships below).

```json
{ "identity.primary":   { "@fields": ["id"], "@generation": "increment" } }
{ "identity.secondary": { "@fields": ["email"] } }
{ "identity.reference": { "name": "fkAuthor", "@fields": ["authorId"], "@references": "Author", "@enforce": true } }
```

## Relationships

`relationship.composition` is the "this entity owns / aggregates instances of
that entity" side; `identity.reference` (above) is the FK-column side. They are
the two halves of one FK.

| Attr | On | Values |
|---|---|---|
| `@objectRef` | composition | target entity name |
| `@cardinality` | composition | `one` / `many` |
| `@onDelete` / `@onUpdate` | `relationship.*` only | `cascade` / `set-null` / `restrict` / `no-action` |

```json
{ "relationship.composition": {
    "name": "posts", "@objectRef": "Post",
    "@cardinality": "many", "@onDelete": "cascade" } }
```

## Sources — `source.rdb` + `@kind`

`source.rdb` declares where an entity's data lives. Read-only-ness derives from
`@kind` (it is NOT a separate subtype):

| `@kind` | Read-only | Default? |
|---|---|---|
| `table` | no | yes (when `@kind` omitted) |
| `view` | yes | – |
| `materializedView` | yes | – |
| `storedProc` | yes | – |
| `tableFunction` | yes | – |

The physical name is `@table` (NOT `@name`). The physical column name on a field
is `@column`. `@schema` namespaces the DB schema (Postgres default `public`;
SQLite rejects non-default values). Multi-source: multiple `source.rdb` children,
each with a `@role`, exactly one `primary`.

```json
{ "source.rdb": { "@kind": "view", "@table": "v_author", "@schema": "blog" } }
```

A `view`-kind entity's fields carry `origin.*` children (`passthrough` /
`aggregate` / `collection`) declaring where each value comes from.

## Abstracts + `extends` (deferred resolution) + `overlay`

An **abstract** node (`abstract: true`) describes a shape but is never emitted as
a concrete entity. A concrete node references it via `extends:` to inherit its
children + attrs. This is the lightest reuse mechanism — pure data, no codegen
change.

```yaml
- object.entity:
    name: BaseEntity
    abstract: true
    children:
      - field.long: { name: id }
      - field.timestamp: { name: createdAt, required: true }

- object.entity:
    name: Author
    extends: BaseEntity
    children:
      - source.rdb: { table: authors }
      - field.string: { name: name, required: true }
      - identity.primary: { fields: id }
```

Resolution facts:

- **Deferred.** `extends:` resolves *after all files load* — abstracts can live in
  any file, forward references are fine.
- **Multi-level chains flatten** (`Author extends BaseEntity extends Auditable`).
- **Cross-package** refs use the fully-qualified name (`extends: "shared::auditable"`);
  same-package refs use the bare name.
- An unresolved reference fails with `ERR_UNKNOWN_EXTENDS`.

`abstract` and `extends` are **structural keys** (bare, no `@`).

**`overlay` is a different concept.** `extends:` is an IS-A relationship between
two distinct nodes. `overlay: true` re-opens the *same* named node to amend it
across files (same `package` + same `name` → merged; last-writer-wins on attr
conflicts, structural children accumulate). Use `extends` to share shape between
distinct entities; use `overlay` to split one entity's declaration across files.

---

For non-trivial schema design, use `/superpowers:brainstorming` if installed;
otherwise proceed.
