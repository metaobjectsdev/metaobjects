---
name: metaobjects-authoring
description: Use when authoring or modifying MetaObjects metadata — fields, entities, relationships, sources, enums, abstracts/inheritance — in YAML or canonical JSON; includes designing, registering or changing custom vocabulary (your own types, subtypes or attributes via a provider) and modelling a domain, a config file or infrastructure with it.
---

# Authoring MetaObjects metadata

Metadata is the typed declaration of the application's model. The loader reads it, codegen
emits code in each language from it, and the drift gates check everything against it.

## Essentials

- **Declare it; do not hand-write it.** Persistence, data access, validation, APIs and UI
  scaffolding are derived from metadata. When you reach for a hand-written query, route,
  validator, relationship or aggregate, that is usually metadata nobody has declared yet:
  look for the construct first (`meta types <term>`).
- **Adoption reverses the direction.** When working code or a populated schema already
  exists, it is the specification and the metadata reproduces it: its names, types and
  nullability. Read `references/adopting-existing-code.md` before modeling anything.
- **Every node is `{ "<type>.<subType>": { <body> } }`.** Reserved keys (`name`, `isArray`,
  `children`, …) are bare; every attribute is `@`-prefixed in JSON and bare in YAML.
- **Never invent a subtype or attribute.** The loader is strict, so an unregistered name
  fails the load. `meta types` says what exists; vocabulary of your own is a provider class.
- **Vocabulary of your own is modelled semantically.** A type says what a thing is and what it
  relates to, a subtype says which kind, and products, versions, steps and environment values
  stay in generators and configuration. Read `references/semantic-modelling.md` first.
- **Choose a field's shape by what the value is, not how it is stored**: a UUID is
  `field.uuid`, money is `field.currency`, a list is `isArray: true`, and a JSON column takes
  the type its writer already declares. The canonical-form table below covers the common
  cases.
- **A relationship's subtype sets the default delete action, and the FK-owning (child) side
  governs.** Modeling every link as `composition` arms cascades nobody asked for.
- **In YAML, quote any scalar that looks like a boolean, number, date or null.**

Metadata lives in files under the project's metadata directory (`metaobjects/` unless the
project's configuration names another: `sources` in `.metaobjects/config.json`, or the port's
own setting), one file per domain concept (`meta.commerce.json`, `meta.users.yaml`, …). Each
file declares a `package` on its root node. Files in the same `package` with the same object
`name` are merged by the loader.

## Reference files — open only the one your task needs

This file covers what almost every model needs. The topics below live in
`references/` beside it; open one when its row matches what you are doing, not up front.

| File | Open it when |
|---|---|
| `references/adopting-existing-code.md` | working code or a populated schema already exists for what you are modeling |
| `references/adopting-existing-models.md` | moving existing Zod, Drizzle or Pydantic models into the model: the step-by-step recipe, and how to prove the generated types match before the switch |
| `references/choosing-a-shape.md` | no row of "Canonical form for common field needs" fits; you need the full UUID / timestamp / URI / `@autoSet` rule; or you are registering your own vocabulary |
| `references/semantic-modelling.md` | **open first** when you add or change a custom type, subtype, attribute or provider, author nodes of vocabulary the project registered, or are asked to put a config file, a script or infrastructure "in the metadata" |
| `references/json-columns.md` | a JSON column beyond the ladder below: coverage per port, `field.map` at runtime, version caveats, bag → native array |
| `references/identities-and-indexes.md` | declaring a primary, secondary or reference identity, an FK, or a non-unique `index.lookup` |
| `references/sources.md` | the `source.rdb` shape and `@kind`; a store MetaObjects does not manage; a derived or computed column (reach for an entity read-view first) |
| `references/abstracts-and-overlay.md` | a shared `abstract` base, `extends`, or a layered `overlay` file |
| `references/declaring-reports.md` | **open first** for a report, dashboard, totals, `GROUP BY`, "per client / per month" or a read-only summary view: declaring `dimension.*`, `measure.*`, `segment.filter` or an `object.report` |
| `references/model-first-rationale.md` | someone argues that hand-writing a layer is cheaper this once |
| `references/relationships.md` | a many-to-many link or self-join, or a "rows that reference this one" query |
| `references/read-views-and-projections.md` | an `object.projection`, `origin.*` vocabulary, `@filter` / `@expr`, or an `@sql` / `@unmanaged` view (a grouped or aggregate view is `declaring-reports.md` first) |
| `references/inheritance-tph.md` | several entities are variants of one thing sharing a single table (`@discriminator`) |
| `references/metadata-dependencies.md` | the project builds on another package's metadata (`dependencies`, cross-package `overlay`) |
| `references/reporting.md` | what a declared report gives you: what columns a report gets, time grains, null rules, rows with no facts (`@spine`), defaults (`@default`), engine differences |
| `references/requirements.md` | you add, change or review a `requirement.*` node |

## Model first, then generate

You are declaring the model the application is generated from: the question is "what is this
resource, and what is true about it?", and codegen owns the "how". Hand-writing a layer the
model can describe is the exception, because a hand-written copy is checked by nothing and
drifts the day the model changes.

When you are about to hand-write something data-shaped, find the model for it:

1. **Check whether the design already ships.** `meta gen --list --format json` carries
   `kind: "library"` rows, each with a `useWhen`. If one matches, opt in and adapt it: you
   inherit its entities, requirements and recorded rulings. The bare name is the core layer
   (sourceless: no tables, no generated code); `<lib>/db` adds the schema.
2. **Search the vocabulary.** `meta types <term>`, or `meta types --all <what-it-does>` to
   search by behavior; there are subtypes, origins, identities and attributes you may not
   know exist. `--detail` shows one construct's valid `@attrs`; `--format json` gives every
   match with each attr's `allowedValues`, so you read the accepted values, not guess them.
3. **Declare it, generate, and consume the generated query, type or route.** Do not
   reimplement it alongside.
4. **If the model is right and the generated output is wrong, change your generator.**
   Naming, file layout, imports, framework and signatures are generator concerns. The
   generators are in your repo and yours to edit; a rule against changing MetaObjects itself
   does not reach them (`metaobjects-codegen`, "When generated output does not fit").
5. **Hand-write only what no construct can express**, wired to the generated types: business
   algorithms, external integrations, bespoke interactions. CRUD, validation, finders,
   relationships and derived or aggregate data are not in that group.

If the metadata could describe it, declaring it is the right call even when a one-off
hand-write would be faster today (`references/model-first-rationale.md`).

## Adopting onto an existing codebase: metadata follows the code

Model-first is the greenfield default. When working code or a populated schema already exists
for what you are modeling, that code is the specification and the metadata's first job is to
reproduce it: its native types, column and table names, nullability, and the types its JSON
writers already declare. Tune the generator to match the code before you change the code.
`references/adopting-existing-code.md` has the rules; read it before modeling.

## The fused-key encoding

Every node is `{ "<type>.<subType>": { <body> } }`. The wrapper key fuses type and
subtype; there is no separate `subType` body key.

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

## Declare each attribute once

A node body must not declare the same attribute name twice. An inline `@attr` and a child
`attr.*` node with the same name are the same slot written two ways, so use one form: setting
`@required` inline and also adding an `attr.boolean` child named `required` is a double
declaration.

## Field subtypes (closed vocabulary)

| Subtype | Stores | Notes |
|---|---|---|
| `field.string` | text | `@maxLength` drives `varchar(N)` |
| `field.int` | 32-bit integer | |
| `field.long` | 64-bit integer | |
| `field.double` | double float | approximate; not for money |
| `field.float` | single-precision float | native double/number (TS has no distinct float); DB `REAL`; not for money |
| `field.boolean` | true/false | |
| `field.date` | calendar date | ISO 8601 `YYYY-MM-DD` on the wire |
| `field.time` | time-of-day | no calendar date; DB `TIME` |
| `field.timestamp` | instant (tz-aware) | ISO 8601 with timezone on the wire; `@localTime: true` for a naive wall-clock value |
| `field.decimal` | exact decimal | `@precision` / `@scale`; lossless money/quantity |
| `field.currency` | integer minor units | see Currency below |
| `field.enum` | string member | `@values` required; see Enum below |
| `field.uuid` | UUID | canonical lowercase hex on the wire |
| `field.object` | embedded value object | `@objectRef` + `@storage`; see below |
| `field.map` | dynamic keys over a TYPED value | one jsonb column; string keys; exactly one of `@valueType` (scalar) / `@objectRef` (value object); `isArray` does not apply. The typed form of "a dict column" — NOT the open bag (see "A JSON column") |

Common field attributes: `@required`, `@maxLength`, `@column` (physical column
name), `@default`, `@filterable`, `@sortable`. On temporal fields
(`field.date`/`field.time`/`field.timestamp`) `@autoSet` stamps the value
automatically (`references/choosing-a-shape.md`).

#### What `@required` means

`@required: true` is NOT NULL (presence). On a non-array string, generated *input* validation
(the create and patch models behind POST and PATCH) also rejects `""`; whitespace-only is
accepted, and read models never enforce it, so reading an existing row containing `""` does
not throw. To say "must be provided, but may be empty", author a `validator.length` with
`@min: 0`: an authored `@min` always wins over the implicit non-empty floor. Dropping
`@required` is not the way to say it, because that makes the field optional.

```jsonc
// must be provided; empty string allowed
{ "field.string": { "name": "note", "@required": true, "children": [
  { "validator.length": { "name": "noteLen", "@min": 0 } }
]}}
```

Arrays are unaffected: `@required` on an array field is presence only.

### Canonical form for common field needs

Reach for these before inventing anything. When no row fits, run the decision procedure in
`references/choosing-a-shape.md` (ADR-0037): ask what the concept *does*, never how it is stored.

| Need | Author it as | Note |
|---|---|---|
| IDs / unique keys / any UUID column | `field.uuid` | native UUID type. `field.string` + `@dbColumnType: uuid` generates a string over a uuid column: a smell no drift gate catches |
| Money | `field.currency` | integer minor units; never a float |
| Closed set of symbols | `field.enum` | `@values` required |
| Instant / event time (created/updated) | `field.timestamp` + `@autoSet` | instant / tz-aware by default (Postgres `timestamptz`; native `Instant`/`DateTimeOffset`/aware `datetime`); `@autoSet: onCreate` for `createdAt`, `@autoSet: onUpdate` for `updatedAt` — never hand-stamp |
| Naive wall-clock value (store-open time, birthday-with-time) | `field.timestamp` + `@localTime: true` | `timestamp without time zone` — opt out of zone-awareness only for a genuine wall-clock value |
| A list of anything | `isArray: true` | on the base subtype (e.g. `field.string` + `isArray`) — there is **no** array `@dbColumnType` (retired) |
| Long / unbounded text | bare `field.string` | add `@maxLength` only when you want `varchar(N)` |
| Nested structured value | `field.object` | `@objectRef` + `@storage` |
| Dynamic keys over a known value type | `field.map` | `@objectRef` or `@valueType` |
| Open JSON, no reader narrows it | `field.string` + `@dbColumnType: jsonb` | the LAST rung — see "A JSON column" |
| URL / URI | `field.uri` | native `URI`/`Uri`; `text` column; strict absolute-URI validation (add `@lenient: true` to store any string) — a real native type + behavior, so a subtype (not a validated string) |
| IP address | `field.inet` | native IP type; Postgres `inet` column; strict IPv4/IPv6-literal validation (add `@lenient: true` for a plain-string `text` column) |
| Elapsed time / timeout / delay | `field.duration` | native `TimeSpan`/`Duration`/`timedelta`; Postgres `interval` column; wire form is the port's native one by default, canonical ISO-8601 (`PT1H30M`) under `wire.durations: iso`. Not for a calendar span ("every 3 months"): that is an int and a unit. Never a string or a count of seconds |
| Validated plain string (email / hostname) | `field.string` + `@stringFormat` | `@stringFormat: email` or `@stringFormat: hostname` — idiomatic per-port validation; don't hand-write the `validator.regex` |

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

- `flattened` — one DB column per sub-field (`address_street`, …); illegal on arrays. `@flattenedColumnPrefix`
  replaces the `<column>_` prefix verbatim (`""` keeps the members' own columns).
- `jsonb` — one `jsonb` column; also the default when `@storage` is not set.
- `subdocument` — single jsonb column (a hint for document-store targets).

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

### A JSON column — choose the rung by the type the WRITER already declares

"Add a jsonb column and cast on read" is the habit to drop here. Every other subtype binds a
native type in five languages; `field.string` + `@dbColumnType: jsonb` binds `unknown` / `Any`
/ `Object`, so every reader casts, the keys live in each call site and not in one
declaration, and no gate can see it (`verify --db` sees a jsonb column that matches;
`--codegen` sees output that is correct for a bag). The cast you write on read is the shape
you did not declare.

**The test: read the signature of the function that writes the column.** It already names the
type, and that is the metadata. Take the first rung that fits:

| The writer's type | Author it as | What comes back |
|---|---|---|
| `list[str]` / `string[]` / `List<X>` — plural name, typed elements | the element subtype + `isArray: true` | a native array — **never** a bag holding a list |
| a dataclass / DTO / record / `@Serializable` class — a fixed key set | an **`object.value`** (no identity, no source), then `field.object` + `@objectRef` + `@storage: jsonb` (`isArray: true` for a list of them) | the VO's own type: `.$type<VO>()` + its Zod schema, the Pydantic model (`<VO>Create` on the wire), a Jackson-coded Exposed column, an EF owned type — gated in all five ports |
| `dict[str, X]` / `Record<string, X>` / `Map<String, X>` — dynamic keys, KNOWN value type | **`field.map`** + `@objectRef` (a value object) or `@valueType` (a scalar) | `Record<string, X>` + `z.record(...)` (TS), `dict[str, X]` (Python), `Map<String, X>` over a Jackson jsonb codec (Kotlin), `java.util.Map<String, V>` (Java), `Dictionary<string, V>` over an EF jsonb converter (C#). **Codegen completes on all five ports; the runtime persistence tier does not — see `references/json-columns.md`** |
| `dict[str, Any]` / `JsonNode` / `unknown`, and no reader pins a key | `field.string` + `@dbColumnType: jsonb` | the parsed value, untyped — the deliberate escape hatch |

Only the last row is an open bag, and there it is correct: a pass-through payload, a raw
third-party or LLM response stored verbatim, a column whose shape genuinely differs per row.
**The bag is wrong exactly when the code already knows the shape.** A `*Json`-suffixed name
(`configJson`, `definitionJson`) is admitting there is one. A plural name over a bag (`scopes`,
`participantEmails`) is a list nobody declared. A writer typed `dict[str, Preference]` whose
`Preference` is already an `object.value` in the same repo is one line from the typed rung.

```json
{ "field.string": { "name": "relatedMemoryIds", "isArray": true } }                                // writer: list[str]
{ "field.double": { "name": "vectorScores", "isArray": true } }                                    // writer: list[float]
{ "field.object": { "name": "profile", "@objectRef": "InstructorProfile", "@storage": "jsonb" } }  // writer: a dataclass
{ "field.map":    { "name": "preferences", "@objectRef": "Preference" } }                          // writer: dict[str, Preference]
{ "field.map":    { "name": "sitePages", "@valueType": "string" } }                                // writer: Record<string, string>
{ "field.string": { "name": "rawResponse", "@dbColumnType": "jsonb" } }                            // writer: dict[str, Any], nothing pinned
```

The objections that are not reasons to take the bag, per-port coverage, `field.map` at
runtime, version caveats, and migrating a bag to a native array are in
`references/json-columns.md`.

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

## Relationships

A `relationship.*` child is the navigation / ownership side of a link to another
entity; `identity.reference` (see `references/identities-and-indexes.md`) is the FK-column side. They are the two halves
of one FK. **Choose the subtype by ownership semantics — it decides the default
referential action**, so modeling every FK as `composition` silently arms unintended
`CASCADE` deletes:

| Subtype | Ownership | Default `@onDelete` | Use when |
|---|---|---|---|
| `relationship.composition` | owns the target's lifecycle | `cascade` | children are owned and deleted with the parent |
| `relationship.aggregation` | groups, does NOT own | `set-null` | children outlive the parent; delete nulls the FK |
| `relationship.association` | plain reference, no ownership | `restrict` | you just point at an independent entity |

Common attrs (on any subtype): `@objectRef` (target entity name / FQN),
`@cardinality` (`one` / `many`), and `@onDelete` / `@onUpdate`
(`cascade` / `set-null` / `restrict` / `no-action`). `@onDelete` defaults **per
subtype** as in the table; `@onUpdate` defaults to `cascade` on every subtype.

```json
{ "relationship.composition": { "name": "posts",   "@objectRef": "Post", "@cardinality": "many" } }
{ "relationship.aggregation": { "name": "members", "@objectRef": "User", "@cardinality": "many" } }
{ "relationship.association": { "name": "author",  "@objectRef": "User", "@cardinality": "one" } }
```

**A 1:N declared on both sides: the FK-owning side governs.** The parent-side form
(`Author` → `posts`, `@cardinality: many`) and the child-side form (`Post` → `author`,
`@cardinality: one`) are both supported, and the FK is always derived from the child's
`identity.reference`. When both are declared, the **child's** relationship sets the FK's
actions and the parent's has no effect on the constraint. So a parent `composition` plus a
child `association` gives `ON DELETE RESTRICT`, not cascade, and deleting a parent that has
children is refused. `meta verify` flags that pair (rule `overridden-referential-action`) and
`meta migrate` warns. To get the cascade, put it on the FK itself:
`"@onDelete": "cascade"` on the child's `identity.reference` (it overrides both sides), or
make the child's relationship agree. In TypeScript a parent-side `many` relationship emits
no Drizzle `many()` member; reverse navigation is the generated finder
`find<ChildPlural>By<Fk>` (and its batched `…In`) on the child's queries module.

**Many-to-many and self-joins** use `@through` a junction entity whose two
`identity.reference` children supply the FK sides; see `references/relationships.md`.
Reverse finders (`find<Source>By<FkField>` and the batched `…In`) are **generated** for every
FK, so never hand-write a `WHERE fk = ?` helper.

**Adopting an existing database: pin both actions.** `@onDelete` defaults per subtype
(above) and `@onUpdate` defaults to `cascade`, but a plain SQL foreign key is `NO ACTION` on
both. Left implicit, the metadata declares a referential action the database does not have,
which is a permanent `verify --db` drift. Pin both to what the database really does:

```json
{ "relationship.association": { "name": "author", "@objectRef": "User",
    "@cardinality": "one", "@onDelete": "no-action", "@onUpdate": "no-action" } }
```

## Validators — cross-field rules

Entity-scoped `validator.*` children declare invariants that reference sibling fields
**by name** (the same name-reference pattern as `identity.*`). The backend derives the
enforcement — no raw expression is stored. A DB `CHECK` constraint is emitted by `meta migrate`,
and the generated full create/record model also enforces the rule in every port (Zod refinement,
Bean Validation class-level constraint, `IValidatableObject`, Pydantic `model_validator`), so a
store with no `CHECK` support is still covered. PATCH and partial-update models do not enforce them
(a partial body cannot see the merged row); the DB `CHECK` is the enforcement there.

| Subtype | Rule | Key attrs |
|---|---|---|
| `validator.comparison` | two fields stand in a relational order (`@left @op @right`). Numerics compare with each other; strings, temporals and durations only with the same subtype and `@localTime`; boolean, enum, uuid, uri and inet only `eq`/`ne`. Any other pair is skipped, never rejected. | `@left`, `@op` (`gt`/`gte`/`lt`/`lte`/`ne`/`eq`), `@right` |
| `validator.requiredWhen` | `@field` is required when `@when` equals `@equals` | `@field`, `@when`, `@equals` |
| `validator.presentIff` | `@field` is present **iff** `@when` equals `@equals` (biconditional) | `@field`, `@when`, `@equals` |
| `validator.atLeastOne` | at least one of `@fields` (2+) is present | `@fields` |
| `validator.exactlyOne` | exactly one of `@fields` (2+) is present | `@fields` |

All five take an optional `@condition` (the `origin.computed` grammar): the rule holds only where it does.
Every validator that becomes a CHECK takes an optional `@constraintName`.

```json
{ "validator.comparison":   { "name": "hpInRange", "@left": "currentHp", "@op": "lte", "@right": "maxHp" } }
{ "validator.requiredWhen": { "name": "reasonIfRejected", "@field": "rejectReason", "@when": "status", "@equals": "rejected" } }
{ "validator.presentIff":   { "name": "usedAtWhenUsed", "@field": "usedAt", "@when": "isUsed", "@equals": "true" } }
{ "validator.atLeastOne":   { "name": "emailOrPhone", "@fields": ["email", "phone"] } }
{ "validator.exactlyOne":   { "name": "oneOwner", "@fields": ["customerId", "accountId"] } }
```

These are children of `object.entity`, alongside its fields and identities.

## Discriminator inheritance (TPH)

Several variants of one thing sharing **one table**: the base `object.entity` declares
`@discriminator` (naming a `field.enum` of subtype tags) and each subtype `extends` it with a
`@discriminatorValue`. Codegen emits per-subtype routes with the discriminator injected and
immutable. Supported in all five ports; the worked example is in `references/inheritance-tph.md`.

## Your own vocabulary: a provider class, in every language

A subtype or attribute the core does not ship (a `layout.picker`, `@searchable` on fields) is
registered by a **provider class** in the project's own language, never a side file and
never a loosened `strict`. Model it semantically first (`references/semantic-modelling.md`:
what the thing is and relates to, never a product, a version or a step), then decide each
concept's shape (`references/choosing-a-shape.md`, which also has the register and extend
rules). List the provider once in the port's project
configuration and every command that loads metadata (gen and its docs generators, verify,
fmt) composes it. Where each port lists it, with a worked example:
`references/typescript-providers.md`, `references/python-providers.md`,
`references/csharp-providers.md`, `references/java-providers.md`,
`references/kotlin-providers.md` (only this stack's are installed).

Every port whose tools load the metadata needs its own copy: a TypeScript-only provider
leaves the Java, Python or C# side, and its docs build, failing with `ERR_UNKNOWN_SUBTYPE` /
`ERR_UNKNOWN_ATTR`.

## Requirements: a capability ledger (opt-in)

`requirement.functional` and `requirement.architectural` are registered metadata types,
declared beside the entities they describe and loaded by the same loader, available whether
or not the project uses them yet. They record why each part of the model exists, so a field
with no reason to exist becomes visible. Reach for them when the project needs to answer:

- **"Why is this field here?"** A requirement binds a claim to a specific member.
- **"What is broken but known?"** `@status: partial` plus `@disposition: accepted | deferred`.
  No disposition means undecided, and `meta verify` counts those.
- **"What have we committed to build and not built yet?"** `@status: planned`: the one status
  where a dangling `@implementedBy` is correct. It never counts toward object coverage.
- **"Which ticket covers this?"** `@trackedBy`.

Every requirement must be violable: if you cannot say what breaking it looks like, it is a
description, not a requirement.

A commit that adds, changes or removes behaviour updates the ledger in the same commit (the
claim, its `@status` and `@implementedBy`), or says in the commit message why it does not:
`verify` checks that links resolve, not that the ledger is current.

`references/requirements.md` has the full authoring rules. The shape of one node:

```yaml
- requirement.architectural:
    name: everyStoredRowIsAddressable
    status: live
    statement: Every persisted row declares the identity by which it is addressed.
    counterexample: A row that can be inserted but never pointed at.
    implementedBy: [acme::shop::Order]
```
