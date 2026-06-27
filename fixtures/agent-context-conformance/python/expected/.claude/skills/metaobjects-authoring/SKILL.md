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

## The operating principle: model-first, generate-first

You are not hand-writing an application — you are **declaring the model it is
generated from.** Persistence, data access, validation, APIs, and UI scaffolding are
**derived from metadata, never authored by hand.** Model-first is the default for
*every* capability; hand-writing one of these layers is an exception you must
**justify**, not a convenience you reach for.

**This requires thinking differently.** Imperative code asks *"how do I implement
this endpoint?"* Model-first asks *"what is this resource, and what is true about
it?"* — and lets codegen own the *how*. **Describe WHAT, not HOW.** The metadata is
the source of truth; generated code is a disposable, regenerable artifact — delete
it and `meta gen` restores it identically.

**Why model-first wins even when hand-writing is cheaper this once — and it often
is, this once:**
- **Hand-writing a layer the metadata could own creates a second source of truth for
  one fact.** A field's type, validation, column, route, and form then change in N
  places and must stay consistent forever — not drift *risk*, but two sources of
  truth for one fact, broken by construction.
- **The hand-roll saving is paid once; the consistency tax is paid on every future
  change.** Assume the system will grow — it always does. The metadata amortizes
  toward zero as the model is reused across layers and time; the hand-rolled
  liability compounds with every field, refactor, and language port.
- **One metadata change regenerates persistence + DAO + API + UI consistently** —
  and inherits every future generator improvement. Hand-writing opts out of all of
  it, permanently.

**Before you hand-write anything data-shaped, STOP and find the model.** The moment
you reach for a hand-written query, route, validator, form, relationship, or
aggregate — that is almost always **metadata you have not declared yet.** In order:
1. **Search the vocabulary** — `meta types <term>`, or `meta types --all
   <what-it-does>` to search by behavior. There are field subtypes, relationships,
   projections, origins, identities, sources, and attributes you may not know exist.
   Find the construct that models it.
2. **Declare it and generate** — then *consume* the generated query/type/route;
   never reimplement it alongside.
3. **Only if no construct can express it** — and you have actually looked —
   hand-write it, wired to generated types. Business algorithms, external
   integrations, and bespoke interactions are legitimately hand-written; CRUD,
   validation, finders, relationships, and derived/aggregate data are not.

Rule of thumb: **if the metadata could describe it, declaring it is never the wrong
call** — even when a one-off hand-write would be faster today.


## The fused-key encoding (non-negotiable)

Every node is `{ "<type>.<subType>": { <body> } }`. The wrapper key fuses type and
subtype — there is **no** separate `subType` body key.

```json
{ "object.entity": { "name": "User" } }
{ "field.string": { "name": "email", "@required": true } }
{ "field.enum":   { "name": "status", "@values": ["OPEN", "CLOSED"] } }
{ "identity.primary": { "name": "id", "@fields": ["id"] } }
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
            { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } }
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
          - identity.primary: { name: id, fields: id, generation: increment }
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

**Arrays of value objects** — set `isArray: true` with `@storage: jsonb`. The whole
array lives in **one** jsonb column (a JSON array), never a native `jsonb[]`. The
generated Postgres column is typed `.$type<VO[]>()` and the Zod schema is
`z.array(<VO>InsertSchema)`:

```json
{ "field.object": { "name": "triples", "@objectRef": "Triple",
    "@storage": "jsonb", "isArray": true } }
```

**Opaque jsonb (no value object)** — when the payload has no fixed shape (freeform
config, passthrough metadata, an open-keyed map), do NOT use `field.object` (it
requires `@objectRef`, and a partial VO would let the generated Zod strip unknown
keys → data loss). Model it as a `field.string` with the physical-type override
`@dbColumnType: jsonb` — the logical type stays string-bound, the column is jsonb:

```json
{ "field.string": { "name": "metadata", "@dbColumnType": "jsonb" } }
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
| `identity.secondary` | a unique secondary index | `@fields` (or `@expr` for a functional index) |
| `identity.reference` | an inbound FK from this entity to another | `@fields`, `@references`, `@enforce` |

`@generation` on a primary controls value generation (e.g. `increment`).
`@fields` accepts a single string in authoring; it normalizes to an array in
canonical JSON. `@enforce` on a reference (default `true`) controls whether the
backend physically enforces it (a SQL FK constraint); set `false` for a logical
reference for navigation/typing/codegen only. Referential actions
(`@onDelete`/`@onUpdate`) are NOT on `identity.reference` — they live on the
`relationship.*` node (see Relationships below).

`@references` resolves cross-package by **fully-qualified name**
(`@references: "shared::billing::Account"`), the same rule as `extends`; a bare
name resolves within the current package. The FK target must be an entity with a
single-column primary key (the FK points at that PK); a target with a composite
PK needs the explicit dotted form `@references: "pkg::Target.fieldA,fieldB"`.

**A dangling reference fails the load (0.11.0+).** An unresolved
`identity.reference.@references` raises `ERR_INVALID_REFERENCE` and an unresolved
`relationship.@objectRef` raises `ERR_INVALID_RELATIONSHIP` — the target entity must
exist (previously such references loaded silently). So every `@references` /
`@objectRef` you author must name a real entity.

A `identity.secondary` can index an **expression** instead of plain columns: use
`@expr` (e.g. `"lower(email)"`) in place of `@fields`, optionally with `@using` (the
index method — `gin` / `gist` / `hash`; default `btree`) and `@where` (a partial-index
predicate).

```json
{ "identity.primary":   { "name": "id", "@fields": ["id"], "@generation": "increment" } }
{ "identity.secondary": { "name": "byEmail", "@fields": ["email"] } }
{ "identity.secondary": { "name": "byEmailCI", "@expr": "lower(email)" } }
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

**Adoption footgun — pin BOTH actions.** `@onDelete` and `@onUpdate` each default to
`cascade` when omitted, but a plain SQL foreign key is `NO ACTION` on both. If you're
adopting an existing database (matching metadata to a live schema), omitting these
makes the metadata declare `CASCADE` where the DB has `NO ACTION` — a perpetual
`verify --db` drift. Pin **both** explicitly to the DB's real behavior:

```json
{ "relationship.composition": { "name": "author", "@objectRef": "User",
    "@cardinality": "one", "@onDelete": "no-action", "@onUpdate": "no-action" } }
```

## Validators — cross-field rules

Entity-scoped `validator.*` children declare invariants that reference sibling fields
**by name** (the same name-reference pattern as `identity.*`). The backend derives the
enforcement (a CHECK constraint / cross-field assertion) — no raw expression is stored.

| Subtype | Rule | Key attrs |
|---|---|---|
| `validator.comparison` | two fields stand in a relational order (`@left @op @right`) | `@left`, `@op` (`gt`/`gte`/`lt`/`lte`/`ne`/`eq`), `@right` |
| `validator.requiredWhen` | `@field` is required when `@when` equals `@equals` | `@field`, `@when`, `@equals` |
| `validator.presentIff` | `@field` is present **iff** `@when` equals `@equals` (biconditional) | `@field`, `@when`, `@equals` |
| `validator.atLeastOne` | at least one of `@fields` (2+) is present | `@fields` |

```json
{ "validator.comparison":   { "name": "hpInRange", "@left": "currentHp", "@op": "lte", "@right": "maxHp" } }
{ "validator.requiredWhen": { "name": "reasonIfRejected", "@field": "rejectReason", "@when": "status", "@equals": "rejected" } }
{ "validator.presentIff":   { "name": "usedAtWhenUsed", "@field": "usedAt", "@when": "isUsed", "@equals": "true" } }
{ "validator.atLeastOne":   { "name": "emailOrPhone", "@fields": ["email", "phone"] } }
```

These are children of `object.entity`, alongside its fields and identities.

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

**An entity's PRIMARY source must be writable** (`table`) — read-only kinds are
legal only in non-primary roles (e.g. table `primary` + view `replica` for
read-through). A derived read model over a view/proc is an **`object.projection`**
(FR-024): its fields `extends` entity fields (`extends: "Author.id"` — dotted
child traversal, package only on the root segment) and/or carry `origin.*`
children (`passthrough` / `aggregate` / `collection`) declaring assembly; its
identity passes through via `extends` (`identity.primary: { name: id, extends:
"Author.id" }`); it is read-only by construction and the declared field set IS
the exposure (fail-closed). Give it a read-only `source.rdb` `@kind: view`
child (`source.rdb: { kind: view, table: v_author }`) — codegen keys projection
detection + view DDL off that read-only source, so without it `meta gen` emits
nothing for the projection.

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
      - identity.primary: { name: id, fields: id }
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
