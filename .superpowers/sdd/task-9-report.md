# Task 9 Report: Kotlin Codegen (Exposed) — index.lookup + identity.secondary

## Summary

`KotlinExposedTableGenerator` now emits `index.lookup` children as non-unique Exposed indexes,
and `identity.secondary` was already (correctly) always emitting `uniqueIndex(...)` — no
`isUniqueKey()` call existed in the generator; Task 8 had already removed it from the metadata class
before this task started.

## Files Changed

### `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt`

1. **Added import**: `import com.metaobjects.index.LookupIndex`
2. **Extended init-block emission** (lines ~483–502): The existing secondaries-only `init` block was
   expanded to also iterate `entity.getChildren(LookupIndex::class.java, true)` (ADR-0039 resolving
   accessor — `includeParentData=true` so inherited lookup indexes from abstract base entities are
   visible). For each non-empty lookup index, emits `index("name", false, col1, col2, ...)`. The
   combined `init` block is only emitted when at least one secondary or lookup index is present.
   Views are excluded (same guard as secondaries: `if (isView) emptyList()`).

### `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGeneratorTest.kt`

Three new tests added in the `// === index.lookup coverage` section:

- **`single index lookup emits non-unique Exposed index`**: single-field `index.lookup` → 
  `index("idx_orders_status", false, status)` inside `init { }`.
- **`composite index lookup emits multi-column non-unique index`**: two-field `index.lookup` →
  `index("idx_events_tenant_type", false, tenantId, eventType)`.
- **`entity with both identity secondary and index lookup shares one init block`**: mixed entity with
  one `identity.secondary` and one `index.lookup` → exactly one `init { }` block containing both
  `uniqueIndex(...)` and `index(..., false, ...)`.

## Test Results

```
Tests run: 269, Failures: 0, Errors: 0, Skipped: 0  — BUILD SUCCESS
KotlinExposedTableGeneratorTest: 37 tests (was 34 before, +3 new)
```

All 269 codegen-kotlin tests pass.

## Golden / Snapshot Changes

None. All assertions are behavioral (string containment in generated output), not snapshot files.

## Implementation Notes

- `identity.secondary` was already always emitting `uniqueIndex(...)` — no `isUniqueKey()` call
  was present in the generator (Task 8 had already removed it from `SecondaryIdentity`). The
  generator logic was correct; only the `index.lookup` fan-out was missing.
- `@orders` (per-field sort direction on lookup indexes) is not emitted: the standard Exposed
  `Table.index(name, isUnique, *columns)` API does not support per-column sort direction in the
  version used by this project. The brief's "if the generator supports column ordering" clause
  applies — Exposed does not, so it is deferred.
- No named constants were needed beyond the already-imported Java constants (`LookupIndex`,
  `Index.ATTR_FIELDS` is accessed via `idx.fields` which calls `getFields()` on the Java class
  using the resolving accessor per ADR-0039).

## Concerns

None. The implementation is minimal, correct, and backward-compatible (entities without
`index.lookup` children emit identical output to before).
