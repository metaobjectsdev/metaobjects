# FR-013 — Field-level `@readOnly` attribute design

**Status:** Design (ready for implementation plan)
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python).
**Related ADRs:** [ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md) (cross-language native-type binding), [ADR-0002](../../../spec/decisions/ADR-0002-open-closed-typed-nodes.md) (open-closed typed nodes), [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md) (logical/physical layer split).

## Why this doc exists

The metamodel already expresses *entity-level* read-only-ness through `source.rdb @kind` — `view` / `materializedView` / `storedProc` / `tableFunction` make the whole entity read-only. There is no *field-level* read-only mechanism. A writable `@kind: "table"` entity is all-or-nothing today, which is wrong for five common shapes every adopter eventually needs:

1. **Computed / generated columns** — Postgres `GENERATED ALWAYS AS (...) STORED`, SQL Server computed columns, MySQL generated columns. The database computes the value; the application must not write it.
2. **Audit timestamps populated by triggers** — `created_at` / `updated_at` written by DB triggers, not by application code.
3. **Server-generated identity columns on update** — secondary fields populated by `DEFAULT` clauses on update that the application must treat as read-after-write.
4. **View / projection extension** — an `object.entity` with `@kind: "view"` extending a writable `object.entity` should propagate read-only-ness to inherited fields through the projection, even when the projection re-publishes only some of them.
5. **Replication / ETL inputs** — columns populated by external systems where the application must treat them as inputs only.

Every adopter today either hand-codes per-field read-only-ness in `partial class`-style escape hatches or accepts that codegen emits writable setters for fields that must not be written. Adding a single logical attr — `@readOnly: true` — closes the gap cleanly.

## Layer placement (ADR-0013 litmus test)

`@readOnly` changes the field's **native binding** in every language (presence or absence of a setter). That is a *logical* concern, not a physical one. It is **not** introspectable from `information_schema` — DB introspection sees a column with a default expression but cannot know whether the application is supposed to treat it as read-only. The application's contract is the source of truth.

Therefore: **`@readOnly` lives in `core/field/field-schema.ts`**, registered on `commonFieldAttrs` alongside `@required` / `@unique` / `@default` / `@objectRef`. It is *not* a `dbProvider` attribute.

## Decision

Add a single boolean attribute `@readOnly` to every `field.<subtype>`. Default: `false` (writable; existing behavior preserved).

### Schema declaration

In `server/typescript/packages/metadata/src/core/field/field-schema.ts`, append to `commonFieldAttrs`:

```typescript
{
  name: FIELD_ATTR_READ_ONLY,
  valueType: ATTR_SUBTYPE_BOOLEAN,
  required: false,
  description:
    "When true, the field is read-only: codegen emits no setter / writable property, " +
    "and the persistence layer skips the column on INSERT / UPDATE. The value is " +
    "populated by the database (computed column, default expression, trigger), by " +
    "replication, or by another external owner. Conceptually orthogonal to @required.",
}
```

Constant in `field-constants.ts`:

```typescript
/** Field-level read-only flag. When true, codegen emits no setter and persistence
 *  skips the column on writes. Default false. */
export const FIELD_ATTR_READ_ONLY = "readOnly";
```

### Semantics

- `@readOnly: true` → the field is read-only from the application's perspective.
  - Codegen emits a getter only (no setter / no writable property).
  - The persistence layer omits the column from generated INSERT and UPDATE statements.
  - Zod / Pydantic / class-validator schemas mark the field read-only on input variants (create / update) and present on output variants (read).
- `@readOnly: false` (or omitted) → writable. Existing behavior. No change.
- The attribute applies to fields of any subtype (`field.string`, `field.int`, `field.timestamp`, ...). It does not interact with `field.object @storage` differently from other subtypes — a read-only object-field is read-only as a whole.

### Cross-attribute validation rules

1. **`@readOnly: true` with `identity.primary @generation: "assigned"`** is rejected: the application has no path to populate the identity value (no setter; not generated; not defaulted). Emit `ERR_READONLY_ASSIGNED_PRIMARY`.

2. **`@readOnly: true` inside `object.value`** is currently a no-op (value-objects do not expose mutability semantics at the field level). The loader accepts the metadata without error and emits `WARN_READONLY_VALUE_OBJECT` for visibility — codegen may use the attribute for record / struct treatment in some languages (e.g., Kotlin `val` instead of `var`) but the persistence implication does not apply.

### Inheritance / `extends:` interaction

Inherited fields carry their declared `@readOnly` value through `extends:` resolution. A concrete subtype may **upgrade** a writable inherited field to read-only (`@readOnly: true`), but **cannot downgrade** a read-only inherited field to writable. Attempting `@readOnly: false` on a field whose base declares `@readOnly: true` produces `ERR_READONLY_DOWNGRADE` at the effective-tree resolution step.

Special case for view projections: when an `object.entity` extends a writable base AND its `source.rdb @kind` is in `SOURCE_READ_ONLY_KINDS`, the source's read-only-ness wins entity-wide. Every inherited field becomes read-only at the persistence layer regardless of per-field `@readOnly`. The codegen contract is "max-restrictive read-only-ness wins."

## Per-port codegen mapping

| Port | Emission for `@readOnly: true` |
|---|---|
| **TypeScript** | `readonly` property on the entity type; Zod schema's `omit(...)` removes the field from the create/update input variants; Drizzle insert/update column lists exclude it. |
| **Java** | Private field + public getter only (no setter); Lombok `@Setter` excludes the field; JPA `@Column(insertable = false, updatable = false)`. |
| **Kotlin** | `val` instead of `var` in the data class; Exposed table omits from `insert`/`update` builders. |
| **C#** | `public T Field { get; private set; }`; EF Core `.Property(x => x.Field).ValueGeneratedOnAddOrUpdate().Metadata.SetAfterSaveBehavior(PropertySaveBehavior.Ignore)`. |
| **Python** | `@property` getter only (no setter); Pydantic `Field(frozen=True)` or `Final[...]`; SQLAlchemy column marked `Column(..., readonly=True)` or excluded from mutation paths. |

### `migrate-ts` impact

**No DDL emission.** `@readOnly` is a runtime / native-binding concern, not a DDL concern. The underlying mechanism (computed column, trigger, replication target, etc.) is declared independently — by hand-coded migration SQL, by a future `@externalSql` reference, or by an `@dbColumnType` physical attribute. `migrate-ts` does not infer DDL from `@readOnly`.

**Optional verify-time warning** (post-implementation polish): `migrate-ts verify` may emit `WARN_READONLY_NO_GENERATOR` when a column declared `@readOnly: true` has neither a `GENERATED ALWAYS` clause, nor a `DEFAULT` expression, nor a documented external owner. This is a quality-of-life check, not a load-time error.

## Conformance fixtures

Under `fixtures/conformance/`:

1. **`field-readonly-basic/`** — single field with `@readOnly: true`; canonical round-trip preserves the attr.
2. **`field-readonly-inherited/`** — concrete entity extends an abstract base; `@readOnly` carried through inheritance without re-declaration on the subtype.
3. **`field-readonly-upgrade-on-subtype/`** — subtype upgrades a writable inherited field to `@readOnly: true`; effective tree shows read-only.
4. **`field-readonly-on-view-projection/`** — entity with `source.rdb @kind: "view"` declaring `@readOnly: true` on every projection column. Legal; canonical round-trip preserves.
5. **`error-field-readonly-downgrade/`** — subtype attempts `@readOnly: false` over a parent's `@readOnly: true`. Expect `ERR_READONLY_DOWNGRADE`.
6. **`error-field-readonly-assigned-primary/`** — `identity.primary @generation: "assigned"` on a `@readOnly: true` field. Expect `ERR_READONLY_ASSIGNED_PRIMARY`.

Fixture format follows the existing `field-object-storage-*` precedent (`input/meta.demo.json` + `expected.json`).

## Effort estimate

- TS reference (constants + schema + loader validation + 6 fixtures): ~1 day.
- Per-port fanout (Java / Kotlin / C# / Python) — register the attr, wire codegen, run shared corpus: ~1 day each, parallel.
- Total elapsed if ports fan out in parallel: **~2-3 days.**

Smallest of the four FRs in the current metamodel batch.

## Out of scope

- The DDL machinery that *makes* a column read-only (computed column generation, trigger emission, replication target binding). That is downstream of this metadata attribute and lives in dialect-specific migration code or hand-written SQL.
- Auto-detection of read-only-ness from introspection. DB introspection cannot reliably distinguish "computed by database" from "computed once at insert" — the application's contract is the source of truth, not the schema.
- Method-level read-only semantics (e.g., a method that doesn't mutate). Not a field concern.

## Cross-references

- ADR-0013 — logical/physical placement (this addition is logical; lives in `core/field/`).
- ADR-0002 — open-closed; this is one attr declaration + one canonical-serializer entry, no central edits.
- Conformance corpus README at `fixtures/conformance/README.md` for fixture format.
