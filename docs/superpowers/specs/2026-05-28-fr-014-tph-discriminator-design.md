# FR-014 — TPH discriminator on `object.entity` design

**Status:** Design (ready for implementation plan)
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python).
**Supersedes:** the `@discriminator` proposal in [`docs/superpowers/specs/2026-05-20-csharp-tool-and-metamodel-extensions-design.md`](2026-05-20-csharp-tool-and-metamodel-extensions-design.md) (which predated [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md) and conflated layers) and the `source.rdb @discriminatorColumn` framing in `/tmp/metaobjects-proposals.md` (which placed the discriminator on the wrong layer).
**Related ADRs:** [ADR-0002](../../../spec/decisions/ADR-0002-open-closed-typed-nodes.md), [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md), [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) (TS-only schema migration).

## Why this doc exists

`object.entity extends:` is shipped and inherits field declarations across subtypes. There is no way to declare the **discriminator mechanics** for table-per-hierarchy (TPH) persistence: a single physical table holding rows from multiple subtypes, with one column whose value identifies the subtype of each row.

TPH is the canonical inheritance-with-persistence pattern across every major ORM:
- EF Core — `HasDiscriminator(...).HasValue<T>(...)`
- Hibernate / JPA — `@DiscriminatorColumn` + `@DiscriminatorValue`
- SQLAlchemy — `polymorphic_on` + `polymorphic_identity`
- Django — abstract base + `type` field convention
- Drizzle, Prisma, etc. — discriminated single-table inheritance

Every non-trivial domain has at least one polymorphic root (workflow tasks, payments, events, documents, communications, audit entries). Adopters with these shapes today either decline to model them in metaobjects metadata or hand-write the ORM-layer inheritance code, defeating the codegen contract.

## Layer placement (ADR-0013 litmus test)

The discriminator is **an object-modeling concept that happens to physicalize in some way** — a column in RDB, an `_type` field in Mongo, an `@type` key in JSON serialization, the wire tag for cross-language polymorphism. Metaobjects already uses `@type` for the JSON-serializer discriminator (see `object-serializer.ts:24` `TYPE_DISCRIMINATOR = "@type"`) with no DB involvement at all.

The litmus test from ADR-0013: *"If DB introspection is the source of truth for the property and round-trips it from the live schema, it is physical."*

DB introspection can read the column NAME and TYPE from `information_schema`. It **cannot tell you which column is the discriminator** — that semantic fact is an object-modeling decision, not a schema property. Therefore:

- **Which field carries the discriminator value** — logical. Lives on `object.entity`.
- **Which value identifies each subtype** — logical. Lives on each subtype's `object.entity`.
- **The DB column the discriminator field maps to** — already physical, already handled by the field's `@column` attribute. No additional source-level attribute needed.

Both new attributes live on `core/object/object-schema.ts`. Neither is a `dbProvider` attribute.

## Decision

Add two logical attributes on `object.entity`:

- **`@discriminator`** (string) on the base entity — references the **field name** on that entity (and its inheritance tree) that holds the discriminator value.
- **`@discriminatorValue`** (string) on each subtype `object.entity` — the value that identifies this subtype's rows.

### Wire-format example

```jsonc
// Base entity declares the discriminator field by name.
{ "object.entity": {
    "name": "Authorization",
    "@discriminator": "type",          // field name on this entity (resolved through extends:)
    "children": [
      { "source.rdb": { "@table": "Authorizations" } },
      { "field.enum": {                 // the discriminator field itself
          "name": "type",
          "@column": "Type",             // physical column name lives here, not on source.rdb
          "@values": ["Unknown", "Bridge", "Copay", "PriorAuth", "QuickStart"]
      }},
      { "field.string": { "name": "number" } },
      { "identity.primary": { "@fields": "id" } }
    ]
}}

// Subtypes declare their discriminator value; field inheritance handled by `extends:`.
{ "object.entity": {
    "name": "BridgeAuthorization",
    "extends": "Authorization",
    "@discriminatorValue": "Bridge",
    "children": [
      { "field.int": { "name": "quantity" } }
    ]
}}

{ "object.entity": {
    "name": "CopayAuthorization",
    "extends": "Authorization",
    "@discriminatorValue": "Copay",
    "children": [
      { "field.decimal": { "name": "copayAmount", "@precision": 18, "@scale": 2 } }
    ]
}}
```

Constants in `core/object/object-constants.ts`:

```typescript
/** Base-entity attr: field name carrying the discriminator value. Logical (resolved
 *  via extends:). Cross-language metamodel attr — every port round-trips it. */
export const OBJECT_ATTR_DISCRIMINATOR = "discriminator";

/** Subtype-entity attr: this subtype's discriminator value. String wire form;
 *  the canonical-serializer preserves the value as written. */
export const OBJECT_ATTR_DISCRIMINATOR_VALUE = "discriminatorValue";
```

Schema entries on `objectAttrs` in `core/object/object-schema.ts`:

```typescript
{
  name: OBJECT_ATTR_DISCRIMINATOR,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Names the field on this entity (resolvable via extends:) that holds the " +
    "subtype-discriminator value. Subtypes of this entity declare @discriminatorValue " +
    "to bind their rows to a discriminator value. The discriminator field itself is " +
    "an ordinary field declaration (typically field.enum or field.int).",
},
{
  name: OBJECT_ATTR_DISCRIMINATOR_VALUE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "On a subtype of an entity with @discriminator: the value that identifies rows " +
    "of this subtype in the shared discriminator field. Wire form is always a string; " +
    "the underlying field's subtype (enum / int / string) determines codegen + storage " +
    "coercion. Required on every subtype of a discriminated entity.",
},
```

### Loader validation

The loader runs these checks after `extends:` resolution (pass 9+ in the validation pipeline):

| Code | When |
|---|---|
| `ERR_DISCRIMINATOR_FIELD_NOT_FOUND` | `@discriminator` names a field that does not exist on the entity (including inherited fields) |
| `ERR_DISCRIMINATOR_VALUE_DUPLICATE` | Two subtypes of the same `@discriminator`-bearing root declare the same `@discriminatorValue` |
| `ERR_DISCRIMINATOR_VALUE_MISSING` | A concrete entity `extends:` a chain whose root declares `@discriminator` but the subtype lacks `@discriminatorValue` |
| `ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH` | `@discriminatorValue` value cannot be coerced to the discriminator field's subtype (e.g., subtype declares `"Bridge"` but the field is `field.int` and the string is not in the enum's `@values` if the field is `field.enum`) |
| `WARN_DISCRIMINATOR_BASE_NO_DEFAULT` | The discriminator field has no default on the base entity (some ORM stacks need a sentinel default for unmapped rows) |

Multi-level hierarchies (`Base → Mid → Leaf`) are supported. `@discriminator` is declared once on the root; intermediate entities may add `@discriminatorValue` (treated as concrete) or omit it (treated as abstract). The loader walks `extends:` to find the root carrying `@discriminator`.

## Per-port codegen mapping

| Port | Emission |
|---|---|
| **TypeScript** | Discriminated union type: `type Auth = Bridge \| Copay \| ...`; per-subtype Zod schemas via `.merge(BaseSchema)`; Drizzle: one `pgTable` for the base + per-subtype TypeScript narrowing. |
| **Java** | `@Inheritance(strategy = InheritanceType.SINGLE_TABLE)` + `@DiscriminatorColumn(name="...")` on the base + `@DiscriminatorValue("...")` on each subtype. Spring repo methods on the base; per-subtype query methods optional. |
| **Kotlin** | Sealed class hierarchy with KotlinPoet: `sealed class Auth` + per-subtype `data class` with `@DiscriminatorValue`-equivalent. Exposed: single-table query with subtype dispatch. |
| **C#** | EF Core: `modelBuilder.Entity<Auth>().HasDiscriminator<T>(x => x.Type).HasValue<BridgeAuth>(AuthType.Bridge)...`; subtype POCOs inherit from base; `OfType<T>()` polymorphic queries. |
| **Python** | SQLAlchemy: base declarative class with `__mapper_args__ = {"polymorphic_on": "type", "polymorphic_identity": "auth"}`; subtypes inherit with their own `polymorphic_identity`. Pydantic: tagged-union via `discriminator` field. |

Each port also emits polymorphic query helpers (e.g., `.OfType<Bridge>()` in C#, `session.query(Bridge)` in Python, `findAllByType(BRIDGE)` in Java).

## `migrate-ts` impact

Per [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md), schema migration is TS-only. The TS reference work:

- **TPH detection.** `migrate-ts/src/expected-schema.ts` recognizes a TPH root by: an `object.entity` carrying `@discriminator` + the presence of one or more entities `extends:`-ing it with `@discriminatorValue`.
- **DDL emission.** A single `CREATE TABLE` for the base. Every subtype's own fields become columns on the base table, **automatically nullable** if any subtype omits them (the TPH nullability rule — a row that's a `Bridge` won't have `Copay`'s columns populated).
- **Discriminator-column type derivation.** The discriminator column's type follows from the named field's subtype (`field.enum` → `varchar` with CHECK; `field.int` → `integer`; `field.string` → `varchar`).
- **Introspection round-trip.** Reading the live DB recovers the column set but **not** the discriminator semantic (which column IS the discriminator). Drift detection compares the metadata-declared expected column set against the actual columns; the discriminator-column identity itself is metadata-declared, not introspected.

### Drift detection notes

- Subtypes' fields appearing as columns on the base table — expected.
- A subtype declared but its fields missing from the actual table — flagged.
- The discriminator column missing or having a mismatched type — flagged.
- Discriminator values present in actual rows that aren't declared by any subtype — surfaced as a `WARN_DISCRIMINATOR_VALUE_UNKNOWN` during `verify` (not a `migrate emit` blocker).

## Conformance fixtures

Under `fixtures/conformance/`:

**Positive (6):**

1. `tph-discriminator-string-no-subtypes/` — base entity declares `@discriminator` referencing a `field.string`; no subtypes yet (refactor-in-progress shape). Canonical round-trip preserves; no codegen inheritance emission.
2. `tph-discriminator-int-no-subtypes/` — same but with `field.int` as the discriminator field.
3. `tph-discriminator-enum-with-subtypes/` — `field.enum`-backed discriminator with three concrete subtypes; effective tree resolves; canonical preserves.
4. `tph-discriminator-int-with-subtypes/` — int-backed mirror of the enum case.
5. `tph-discriminator-nullable-subtype-fields/` — subtypes add fields; expected-schema marks those columns nullable on the base table snapshot.
6. `tph-discriminator-multi-level/` — three-level hierarchy (`Base → Mid → Leaf`). Each level declares `@discriminatorValue` (Mid is concrete). Validates multi-step `extends:` resolution.

**Error (3):**

7. `error-tph-duplicate-discriminator-value/` — two subtypes claim `"Bridge"`. Expect `ERR_DISCRIMINATOR_VALUE_DUPLICATE`.
8. `error-tph-missing-discriminator-value/` — subtype extends a `@discriminator`-bearing root but omits `@discriminatorValue`. Expect `ERR_DISCRIMINATOR_VALUE_MISSING`.
9. `error-tph-unknown-discriminator-field/` — `@discriminator: "type"` referenced but no `type` field on the entity or its ancestors. Expect `ERR_DISCRIMINATOR_FIELD_NOT_FOUND`.

## Effort estimate

- TS reference (metamodel + 9 fixtures + `migrate-ts` TPH emit and diff): **~5-7 days.** Largest of the four FRs in the current metamodel batch — `migrate-ts` is the heavy lift here.
- Per-port fanout (Java / Kotlin / C# / Python) — register attrs, wire TPH codegen idiom per stack, run shared corpus: **~3-4 days each, parallel.**
- Total elapsed if ports fan out in parallel after TS reference lands: **~2 weeks.**

## Out of scope

- **Table-per-Type (TPT) and Table-per-Class (TPC) inheritance.** These store subtypes in separate tables. Different DDL, different polymorphic-query mechanics. Add if/when a real adopter need surfaces; do not preemptively design.
- **Joined-table inheritance** (Hibernate `JOINED` strategy). Same — different mechanics, defer.
- **Per-subtype `@kind` divergence.** All subtypes of a discriminated root share the base's `source.rdb` binding by definition (TPH is single-table). The metamodel does not currently allow a subtype to override `source.rdb`; this remains true and is not relaxed by FR-014.

## Cross-references

- ADR-0013 — the layer-split principle. `@discriminator` and `@discriminatorValue` are both logical; both live in `core/object/`.
- ADR-0002 — open-closed registration; each attr is one schema entry, no central edits.
- ADR-0015 — TS owns DDL. The migrate-ts TPH emit + diff work lands in TS only.
- The superseded `@discriminator` proposal in `2026-05-20-csharp-tool-and-metamodel-extensions-design.md` — same name, but the old design didn't separate the field-name semantic from the column-name semantic. This FR's version uses the field name (logical), letting the field's own `@column` attribute handle the physical mapping.
- The superseded `source.rdb @discriminatorColumn` framing in `/tmp/metaobjects-proposals.md` — placed on the physical layer; reconsidered (DB introspection cannot recover the discriminator semantic, so it is not physical per ADR-0013).
