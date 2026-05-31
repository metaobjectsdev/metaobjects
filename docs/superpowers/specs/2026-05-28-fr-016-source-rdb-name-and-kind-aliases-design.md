# FR-016 — `source.rdb` logical name + default-resolution closure + per-kind physical-name aliases

**Status:** Design (ready for implementation plan)
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python).
**Realizes:** [ADR-0007](../../../spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md) point 2 (logical `name` on source + default-resolution from `name`) and [ADR-0018](../../../spec/decisions/ADR-0018-per-kind-physical-name-attrs.md) (per-kind physical-name aliases within rdb).
**Related ADRs:** [ADR-0002](../../../spec/decisions/ADR-0002-open-closed-typed-nodes.md), [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md), [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md).

## Why this doc exists

`source.rdb` carries the relational-paradigm binding for an `object.entity`. Two design contracts about its attribute surface have been written but not fully implemented:

1. **[ADR-0007](../../../spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md) point 2** specified that `source.<paradigm>` carries an optional logical `name` attribute, and that the physical-address attribute (e.g., `@table` for rdb) defaults from the source's `name` via the project's naming strategy when omitted. The current loader defaults from the *owning entity's name* — a simpler shortcut that bypasses the source's own `name`. Reasonable for the single-source case; insufficient for multi-source.

2. **[ADR-0018](../../../spec/decisions/ADR-0018-per-kind-physical-name-attrs.md)** (issued alongside this FR) revises ADR-0007's choice of a universal `@table` within rdb to per-kind physical-name aliases — `@view` / `@materializedView` / `@proc` / `@function` for the non-table kinds. Same single internal slot; the canonical attr key matches the kind.

Both gaps surface together when authoring stored-proc and view declarations:
- Reader sees `@table: "fn_get_phase_summary_per_case"` with `@kind: "storedProc"` and translates mentally that this isn't actually a table.
- Reader sees a `source.rdb` with no `name` attr and no way to disambiguate it from other sources on the same entity in error messages.

This FR closes both gaps in one focused pass — same files, same registration points, same conformance corpus refresh.

## Layer placement

Both items live in the `dbProvider` layer (`persistence/source/`):
- `name` on `source.rdb` — logical-identifier attribute on a source node. Goes on the source schema.
- Per-kind physical-name aliases (`@view`, `@materializedView`, `@proc`, `@function`) — all physical attrs writing to the same internal `physicalName` slot. Same schema registration.

The single internal slot is the key contract: codegen and runtime read one field (`source.physicalName` or equivalent) regardless of which alias was used to write it.

## Decision

### Part 1 — Add `name` attribute on `source.rdb`

Constant in `persistence/source/source-constants.ts`:

```typescript
/** Logical name on source.rdb. Optional. Serves three roles:
 *  1. Default for the physical-name attr (@table/@view/@proc/@function) when omitted.
 *  2. Disambiguating identifier in loader diagnostics ("source 'X' on entity 'Y'").
 *  3. Multi-source addressing (an entity with multiple sources distinguished by name + role).
 *  See ADR-0007 point 2. */
export const SOURCE_ATTR_NAME = "name";
```

Schema entry on `sourceRdbAttrs`:

```typescript
{
  name: SOURCE_ATTR_NAME,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Logical name for this source. Optional. When set, the physical-name attribute " +
    "(@table / @view / @materializedView / @proc / @function) defaults from this " +
    "value via the project's naming strategy if no explicit physical-name attr is set. " +
    "Also used in loader diagnostics and to disambiguate multiple sources on one entity.",
}
```

### Part 2 — Per-kind physical-name aliases for rdb

Constants in `persistence/source/source-constants.ts`:

```typescript
/** Kind-aware physical-name aliases (ADR-0018). Each writes to the single
 *  `physicalName` slot internally; the canonical-serializer emits the alias
 *  matching @kind on round-trip. */
export const SOURCE_ATTR_TABLE              = "table";              // @kind: "table" (default)
export const SOURCE_ATTR_VIEW               = "view";               // @kind: "view"
export const SOURCE_ATTR_MATERIALIZED_VIEW  = "materializedView";   // @kind: "materializedView"
export const SOURCE_ATTR_PROC               = "proc";               // @kind: "storedProc"
export const SOURCE_ATTR_FUNCTION           = "function";           // @kind: "tableFunction"

/** Map @kind → canonical physical-name attr key. Used by the canonical-serializer
 *  to choose the output attr name and by the loader to enforce kind/alias matching. */
export const PHYSICAL_NAME_ATTR_BY_KIND: ReadonlyMap<string, string> = new Map([
  [SOURCE_KIND_TABLE,             SOURCE_ATTR_TABLE],
  [SOURCE_KIND_VIEW,              SOURCE_ATTR_VIEW],
  [SOURCE_KIND_MATERIALIZED_VIEW, SOURCE_ATTR_MATERIALIZED_VIEW],
  [SOURCE_KIND_STORED_PROC,       SOURCE_ATTR_PROC],
  [SOURCE_KIND_TABLE_FUNCTION,    SOURCE_ATTR_FUNCTION],
]);
```

Schema entries on `sourceRdbAttrs` — one per alias. All five carry the same physical semantics; the loader picks one based on `@kind`:

```typescript
const tableSchema: AttrSchema = {
  name: SOURCE_ATTR_TABLE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Physical SQL table name for source.rdb @kind: \"table\" (default). Defaults from " +
    "source.@name via columnNamingStrategy when omitted. ADR-0018: legacy spelling for " +
    "view/materializedView/storedProc/tableFunction kinds during the pre-1.0 transition; " +
    "canonical-serializer rewrites to the kind-matching alias.",
};

const viewSchema: AttrSchema = {
  name: SOURCE_ATTR_VIEW,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description: "Physical SQL view name for source.rdb @kind: \"view\". Same slot as @table.",
};

const materializedViewSchema: AttrSchema = {
  name: SOURCE_ATTR_MATERIALIZED_VIEW,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description: "Physical SQL materialized-view name for source.rdb @kind: \"materializedView\". Same slot as @table.",
};

const procSchema: AttrSchema = {
  name: SOURCE_ATTR_PROC,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description: "Physical SQL stored-procedure name for source.rdb @kind: \"storedProc\". Same slot as @table.",
};

const functionSchema: AttrSchema = {
  name: SOURCE_ATTR_FUNCTION,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description: "Physical SQL table-function name for source.rdb @kind: \"tableFunction\". Same slot as @table.",
};

export const sourceRdbAttrs: AttrSchema[] = [
  nameSchema,
  tableSchema, viewSchema, materializedViewSchema, procSchema, functionSchema,
  kindSchema, roleSchema, schemaSchema,
];
```

### Physical-name resolution rule (revised)

When the loader resolves the physical name for a `source.rdb`:

1. **Explicit kind-matching alias.** If any of `@table`/`@view`/`@materializedView`/`@proc`/`@function` is set AND matches `@kind`, that value is the physical name.
2. **Legacy `@table` for non-table kind (pre-1.0).** If `@table` is set and `@kind` is a non-`table` value, accept it as the physical name (legacy spelling) and emit `WARN_LEGACY_PHYSICAL_NAME_ALIAS` pointing to the canonical form.
3. **`source.@name` derivation.** If no explicit physical-name attr is set, derive the physical name from `source.@name` via the project's `columnNamingStrategy` (snake_case / literal / kebab-case).
4. **Entity-name fallback.** If `source.@name` is also absent, derive from the owning `object.entity`'s name via the same naming strategy. This is the current default behavior and remains the final fallback.

### Loader validation

| Code | When |
|---|---|
| `ERR_PHYSICAL_NAME_KIND_MISMATCH` | `@view`/`@materializedView`/`@proc`/`@function` set but `@kind` does not match (e.g., `@view: "X"` with `@kind: "storedProc"`). Strict — only the matching alias is permitted (except the `@table`-as-legacy-alias case in resolution rule 2, which warns rather than errors). |
| `ERR_PHYSICAL_NAME_MULTIPLE` | Two or more kind-aware aliases set on the same source (e.g., both `@table` and `@view`) |
| `WARN_LEGACY_PHYSICAL_NAME_ALIAS` | `@table` used with a non-`table` `@kind`. Emit at load time; canonical-serializer rewrites the attr on round-trip |

### Canonical serialization

The canonical serializer rewrites the physical-name attr key to match `@kind` regardless of which spelling was on input:

| Input | Canonical output |
|---|---|
| `{ "@kind": "storedProc", "@table": "fn_x" }` (legacy) | `{ "@kind": "storedProc", "@proc": "fn_x" }` |
| `{ "@kind": "view", "@table": "v_x" }` (legacy) | `{ "@kind": "view", "@view": "v_x" }` |
| `{ "@kind": "view", "@view": "v_x" }` | unchanged |
| `{ "name": "primary", "@kind": "table" }` (no explicit @table) | unchanged — physical name derives from `name`; canonical preserves `name` |

This pins the kind-matching alias as the conformance contract going forward.

## Per-port impact

| Port | Work |
|---|---|
| **TypeScript** | 5 new attr-schema entries (table/view/materializedView/proc/function); name-schema entry; resolution logic in `migrate-ts/src/expected-schema.ts`; canonical-serializer rewrite rule. |
| **Java / Kotlin / C# / Python** | Mirror the TS attr registration; canonical-serialize symmetric output; no DDL work (ADR-0015: TS owns migrate). |

Cross-port: the canonical-output contract must be byte-identical. Tested via the existing cross-port byte-equivalence harness on the fixtures listed below.

## `migrate-ts` impact

- **Physical-name resolution rewrite.** `expected-schema.ts` updates from "default to entity name" to the four-step rule above. Existing fixtures with `@table` set explicitly continue to behave identically (rule 1).
- **DDL emit picks the resolved name** regardless of which alias was on input. The schema diff compares physical names; the attribute key on the metadata side is independent.
- **No new introspection.** The live DB returns the column / table / view / proc / function name; the metadata side's alias is purely an authoring convenience and has no effect on what's read from `information_schema` / `pg_proc`.

## Corpus regeneration

After the TS reference implementation lands, every fixture under `fixtures/conformance/` containing a `source.rdb` with a non-table `@kind` gets regenerated through the canonical serializer:

```
@kind: "view"            + @table → @view
@kind: "materializedView" + @table → @materializedView
@kind: "storedProc"      + @table → @proc
@kind: "tableFunction"   + @table → @function
```

The wire-format LOGICAL contract is unchanged — same fixtures express the same metadata models, just under the canonical kind-matching attr keys. Each port's conformance run validates byte-equivalence to TS's canonical output.

## Conformance fixtures

Under `fixtures/conformance/`:

**Positive (6):**

1. `source-rdb-name-only/` — `source.rdb` with `name: "Customers"` and no explicit physical-name attr; `@kind: "table"` (default). Physical name derives from `name` via naming strategy.
2. `source-rdb-name-and-explicit-table/` — `name: "primary"` + `@table: "T_CUST_2024"`. Both retained on canonical round-trip; physical name = `T_CUST_2024`.
3. `source-rdb-kind-view-with-view-attr/` — `@kind: "view"` + `@view: "v_program_summary"`. Canonical round-trip preserves.
4. `source-rdb-kind-proc-with-proc-attr/` — `@kind: "storedProc"` + `@proc: "fn_x"`. Canonical round-trip preserves.
5. `source-rdb-kind-function-with-function-attr/` — `@kind: "tableFunction"` + `@function: "fn_x"`. Canonical round-trip preserves.
6. `source-rdb-legacy-table-for-view-rewrites/` — input `@kind: "view"` + `@table: "v_x"`; expected canonical output uses `@view: "v_x"`. Asserts the rewrite rule and that the loader emits `WARN_LEGACY_PHYSICAL_NAME_ALIAS`.

**Error (3):**

7. `error-source-rdb-physical-name-kind-mismatch/` — `@kind: "view"` + `@proc: "X"`. Expect `ERR_PHYSICAL_NAME_KIND_MISMATCH`.
8. `error-source-rdb-multiple-physical-names/` — both `@table` and `@view` on one source. Expect `ERR_PHYSICAL_NAME_MULTIPLE`.
9. `error-source-rdb-physical-name-empty-string/` — `@view: ""`. Expect `ERR_BAD_ATTR_VALUE` (the standard empty-string check).

## Effort estimate

- TS reference (constants + schema + resolution-rule update + canonical-serializer rewrite + 9 fixtures + corpus regeneration): **~1-2 days.**
- Per-port fanout — five attr registrations + mirror canonical output: **~half day each, parallel.**
- Total elapsed if ports fan out in parallel: **~1 week.**

## Out of scope

- **Renaming `@table` to something else when `@kind: "table"`.** No need — `@table` is the natural noun for actual tables. Only the non-table kinds get new alias spellings.
- **Per-kind aliases in non-rdb paradigms.** ADR-0018 specifies which paradigms use per-kind vs. single attrs. This FR implements only the rdb side. Other paradigms (`graph` already per-kind in ADR-0007; `event` to be decided when paradigm lands) ship separately.
- **Renaming `@dbColumn` to be field-kind-aware.** Field-level `@column` already covers all field subtypes uniformly; there is no kind-distinction in SQL between "column for a string" and "column for an int." Per-kind aliasing applies to source-level kinds, not field-level subtypes.

## Cross-references

- ADR-0007 — paradigm/kind structure + the original `name` + default-resolution rule this FR closes.
- ADR-0013 — physical/logical layer split. Both new attribute families are physical (lives in the `dbProvider`).
- ADR-0015 — TS owns schema migration; the `expected-schema.ts` rewrite is the TS-only piece.
- ADR-0018 — the kind-aware physical-name rule this FR implements for the rdb paradigm.
- FR-015 — uses these new spellings (`@proc` for storedProc, `@function` for tableFunction) in its example metadata.
