# Metadata Constants Co-location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shatter `@metaobjectsdev/metadata`'s god-files (`constants.ts` + `core-attr-schemas.ts`) into per-concern modules co-located with their type, grouped by metamodel layer (core/persistence/presentation), delete the Java-only `@javaRuntime` leak, and preserve the public bare-name import surface via a barrel — all wire-format/conformance neutral.

**Architecture:** Pure code-organization refactor inside one package. Constants, AttrSchema inventories, and node accessors for each metamodel concern move into a single per-concern folder. `registerCoreTypes()` is rewired to import from the new locations. `metadata/src/index.ts` re-exports everything so the 7 consumer packages need zero import changes. The 45 conformance fixtures + codegen golden snapshots are the byte-identical safety gate at every phase.

**Tech Stack:** TypeScript 5.6, Bun 1.3.8 workspaces, the existing `MetaDataTypeProvider` + `composeRegistry` registry model.

**Spec:** [docs/superpowers/specs/2026-05-21-metadata-constants-colocation-design.md](../specs/2026-05-21-metadata-constants-colocation-design.md)

---

## The safety invariant (read first)

This refactor changes **where code lives**, never **what it does**. The gate after every phase:

```
cd <repo-root>/server/typescript && bun test 2>&1 | tail -4
```
Must stay **2034 pass / 0 fail** (server-side; the conformance fixtures live here and are the frozen canonical-output check). Plus the codegen golden snapshots must show **zero diff** (no `git diff` under `test/golden/`). If either breaks, the move was not behavior-neutral — stop and fix before continuing.

The ONLY intentional behavior change in the whole plan: `@javaRuntime` is no longer validated (Task 1). Verified safe — unknown attrs are not rejected by `attr-schema-validate.ts`, and no fixture carries `@javaRuntime`.

---

## File Structure (target)

```
metadata/src/
├── shared/
│   ├── base-types.ts        TYPE_* (11), BASE_TYPES, BaseType, SUBTYPE_BASE, SUBTYPE_ROOT
│   └── structural.ts        name/package/extends/abstract/overlay/isArray/children, JSON special keys,
│                            ATTR_PREFIX (@), FUSED_KEY_SEP (.), PACKAGE_SEP (::), wildcards, package-path
├── core/
│   ├── object/    object-constants.ts, object-schema.ts, meta-object.ts
│   ├── field/     field-constants.ts (incl. currency attrs), field-schema.ts, meta-field.ts
│   ├── attr/      attr-constants.ts, meta-attr*.ts
│   ├── validator/ validator-constants.ts, validator-schema.ts, meta-validator.ts
│   ├── identity/  identity-constants.ts, identity-schema.ts, meta-identity.ts
│   ├── relationship/ relationship-constants.ts, relationship-schema.ts, meta-relationship.ts
│   └── query/     query-constants.ts (9 filter operators + sort-order values)
├── persistence/
│   ├── source/    source-constants.ts, source-schema.ts, meta-source.ts
│   ├── origin/    origin-constants.ts, origin-schema.ts, meta-origin.ts
│   └── db/        db-constants.ts, db-attr-schemas.ts, db-provider.ts   (moved from src/db/)
├── presentation/
│   ├── view/      view-constants.ts, view-schema.ts, meta-view.ts
│   └── layout/    layout-constants.ts, layout-schema.ts, meta-layout.ts   (dataGrid HERE)
├── core-types.ts   → rewired to import per-concern schemas; registerCoreTypes() composition stays
├── registry.ts  provider.ts  loader/  serializer-json.ts  ...  (unchanged)
└── index.ts        → barrel re-exporting every concern's public constants (preserves bare-name surface)
```

**DELETED at the end:** `constants.ts`, `core-attr-schemas.ts`, `src/db/` (moved to `persistence/db/`), all `OBJECT_JAVA_RUNTIME_*`, the `meta-object.javaRuntime` accessor.

---

## Phasing

- **Phase 1** — delete `@javaRuntime` (isolated, smallest, removes the clear leak).
- **Phase 2** — scaffold folders + barrel; split `constants.ts` into per-concern `*-constants.ts` modules; delete `constants.ts`. Constants only — schemas + accessors stay put, re-pointed.
- **Phase 3** — split `core-attr-schemas.ts` into per-concern `*-schema.ts` modules; rewire `core-types.ts`; delete `core-attr-schemas.ts`.
- **Phase 4** — relocate `meta/*` accessors + `db/` into their concern folders (highest churn, lowest risk-per-value — separable checkpoint).
- **Phase 5** — final verification.

Each phase is independently green (tests + golden + typecheck). Phase 4 may be deferred without leaving the tree broken — Phases 1-3 deliver the god-file fix; Phase 4 completes physical co-location.

---

## Pre-flight

- [ ] **Baseline + branch:**

```
cd <repo-root>/server/typescript && bun install && bun test 2>&1 | tail -4
cd <repo-root> && git checkout -b refactor/metadata-constants-colocation
git status --short   # must be clean
```
Expected: 2034 pass / 0 fail. Record the exact count.

- [ ] **Capture golden baseline (for the zero-diff gate):**

```
cd <repo-root>
git rev-parse HEAD > /tmp/colocation-base-sha.txt
```
After each phase, `git diff <base-sha> -- server/typescript/packages/codegen-ts/test/golden server/typescript/packages/codegen-ts-tanstack/test/golden` must be **empty** (constants moving must not change emitted output).

---

## Task 1: Delete `@javaRuntime` from TS

**Files:**
- Modify: `server/typescript/packages/metadata/src/constants.ts` (remove OBJECT_JAVA_RUNTIME_*)
- Modify: `server/typescript/packages/metadata/src/core-attr-schemas.ts` (remove the @javaRuntime schema)
- Modify: `server/typescript/packages/metadata/src/meta/meta-object.ts` (remove the javaRuntime getter)
- Modify: `server/typescript/packages/metadata/test/meta/meta-object.test.ts` (remove .javaRuntime assertions)

- [ ] **Step 1: Find every reference.**

```
cd <repo-root>
grep -rn "OBJECT_JAVA_RUNTIME\|javaRuntime\|JAVA_RUNTIME" server/typescript/packages/metadata/src server/typescript/packages/metadata/test --include="*.ts" 2>/dev/null
```
Record the full list. Expected hits: `constants.ts` (the constants + type), `core-attr-schemas.ts` (the schema entry referencing `OBJECT_JAVA_RUNTIME_VALUES`), `meta/meta-object.ts` (the `javaRuntime` getter), `test/meta/meta-object.test.ts` (assertions). Confirm there are no others (e.g., serializer, codegen) — if any appear outside this list, STOP and report.

- [ ] **Step 2: Remove the constants** in `constants.ts` — delete `OBJECT_JAVA_RUNTIME_POJO`, `_MAP`, `_PROXY`, `OBJECT_JAVA_RUNTIME_VALUES`, `ObjectJavaRuntimeValue`, and the section comment (lines ~385-395 + the JSDoc near line 453).

- [ ] **Step 3: Remove the schema entry** in `core-attr-schemas.ts` — delete the `OBJECT_JAVA_RUNTIME_VALUES` import and the object-attr schema entry that registers `@javaRuntime` with `allowedValues`.

- [ ] **Step 4: Remove the accessor** in `meta/meta-object.ts` — delete the `get javaRuntime()` getter (around line 40).

- [ ] **Step 5: Remove the test assertions** in `test/meta/meta-object.test.ts` — delete the `describe("MetaObject.javaRuntime", ...)` block (around line 116-129).

- [ ] **Step 6: Verify no references remain + tests pass.**

```
cd <repo-root>
grep -rn "javaRuntime\|JAVA_RUNTIME" server/typescript/packages/metadata --include="*.ts" | grep -v "/dist/"   # expect empty
cd server/typescript && bun test 2>&1 | tail -4
```
Expected: empty grep; tests pass (count drops by the number of removed `.javaRuntime` assertions — that's expected, they were deleted, not broken).

- [ ] **Step 7: Golden gate + commit.**

```
cd <repo-root>
git diff $(cat /tmp/colocation-base-sha.txt) -- server/typescript/packages/codegen-ts/test/golden server/typescript/packages/codegen-ts-tanstack/test/golden   # expect empty
git add -A && git commit -m "refactor(metadata): delete Java-only @javaRuntime from TS (leak removal)"
```

---

## Task 2: Scaffold layered folders + `shared/` module

**Files:**
- Create: `server/typescript/packages/metadata/src/shared/base-types.ts`
- Create: `server/typescript/packages/metadata/src/shared/structural.ts`
- Create: empty dirs `core/{object,field,attr,validator,identity,relationship,query}`, `persistence/{source,origin}`, `presentation/{view,layout}`

- [ ] **Step 1: Read the current constants.ts sections to extract exact members.**

```
cd <repo-root>
sed -n '1,60p' server/typescript/packages/metadata/src/constants.ts          # base types + universal/metadata subtypes
grep -nE "STRUCTURAL|RESERVED|JSON_|ATTR_PREFIX|SEP|WILDCARD|PACKAGE" server/typescript/packages/metadata/src/constants.ts
```
Use the real names from the file (do not invent). The sections to extract for `shared/`: the 11 `TYPE_*` + `BASE_TYPES` + `BaseType` + `SUBTYPE_BASE` + `SUBTYPE_ROOT` (base-types.ts); and the structural keys + JSON special keys + `@` prefix + fused-key sep + `::` package sep + wildcard + package-path conventions (structural.ts).

- [ ] **Step 2: Create `shared/base-types.ts`** — move the 11 `TYPE_*` constants, `BASE_TYPES` array, `BaseType` type, `SUBTYPE_BASE`, `METADATA_SUBTYPES`/`SUBTYPE_ROOT` verbatim from constants.ts (cut, not copy). Keep all JSDoc.

- [ ] **Step 3: Create `shared/structural.ts`** — move the reserved structural body keys, JSON document special keys, `ATTR_PREFIX`, fused-key separator, `PACKAGE_SEP` (`::`), wildcard, and package-path constants verbatim.

- [ ] **Step 4: Update `constants.ts` to re-export the moved members** (transitional shim so nothing breaks mid-phase):

```ts
export * from "./shared/base-types.js";
export * from "./shared/structural.js";
```
(Place at top of constants.ts; the moved declarations are now in shared/.)

- [ ] **Step 5: Verify + commit.**

```
cd <repo-root>/server/typescript && bun test 2>&1 | tail -4
cd <repo-root>
git diff $(cat /tmp/colocation-base-sha.txt) -- server/typescript/packages/codegen-ts/test/golden server/typescript/packages/codegen-ts-tanstack/test/golden  # empty
git add -A && git commit -m "refactor(metadata): extract shared/ base-types + structural constants"
```
Expected: tests pass, golden empty.

---

## Task 3: Split per-concern constants out of `constants.ts`

**Files:**
- Create: `core/object/object-constants.ts`, `core/field/field-constants.ts`, `core/attr/attr-constants.ts`, `core/validator/validator-constants.ts`, `core/identity/identity-constants.ts`, `core/relationship/relationship-constants.ts`, `core/query/query-constants.ts`
- Create: `persistence/source/source-constants.ts`, `persistence/origin/origin-constants.ts`, `persistence/db/db-constants.ts`
- Create: `presentation/view/view-constants.ts`, `presentation/layout/layout-constants.ts`
- Delete (end of task): `constants.ts`

- [ ] **Step 1: Move each concern's constants** out of `constants.ts` into its `*-constants.ts` file, verbatim (cut). Mapping (use the exact constant names present in the file):
  - `core/object/object-constants.ts` ← `OBJECT_SUBTYPE_*`, `OBJECT_SUBTYPES`, `ObjectSubType`
  - `core/field/field-constants.ts` ← `FIELD_SUBTYPE_*`, `FIELD_SUBTYPES`, `FieldSubType`, `FIELD_ATTR_*` (incl. autoSet, default, required, unique, maxLength, filterable, sortable, sortableDefaultOrder, objectRef), `CURRENCY_ATTR_*`
  - `core/attr/attr-constants.ts` ← `ATTR_SUBTYPE_*`, `ATTR_SUBTYPES`, `AttrSubType`
  - `core/validator/validator-constants.ts` ← `VALIDATOR_SUBTYPE_*`, `VALIDATOR_SUBTYPES`, validator attr keys
  - `core/identity/identity-constants.ts` ← `IDENTITY_SUBTYPE_*`, `IDENTITY_ATTR_*`, generation-strategy values
  - `core/relationship/relationship-constants.ts` ← `RELATIONSHIP_SUBTYPE_*`, cardinality values
  - `core/query/query-constants.ts` ← the 9 `FILTER_OP_*` + `FILTER_OPERATORS` array + `SORT_ORDER_*`
  - `persistence/source/source-constants.ts` ← `SOURCE_SUBTYPE_*`, `SOURCE_ATTR_*` (`@schema`, `@name`)
  - `persistence/origin/origin-constants.ts` ← `ORIGIN_SUBTYPE_*`
  - `persistence/db/db-constants.ts` ← `FIELD_ATTR_DB_COLUMN`, `FIELD_ATTR_DB_INDEXED`
  - `presentation/view/view-constants.ts` ← `VIEW_SUBTYPE_*`, `VIEW_SUBTYPES`, view attr keys (incl. currency view locale)
  - `presentation/layout/layout-constants.ts` ← `LAYOUT_SUBTYPE_*`, `LAYOUT_SUBTYPES`, dataGrid attr-name constants

Each new file imports any cross-references it needs (e.g., field-constants may reference an attr-subtype value for a default — import from `../attr/attr-constants.js`). Keep all JSDoc.

- [ ] **Step 2: Replace `constants.ts` with a barrel** that re-exports every new module (transitional — keeps `./constants.js` working for internal importers until they're repointed):

```ts
export * from "./shared/base-types.js";
export * from "./shared/structural.js";
export * from "./core/object/object-constants.js";
export * from "./core/field/field-constants.js";
export * from "./core/attr/attr-constants.js";
export * from "./core/validator/validator-constants.js";
export * from "./core/identity/identity-constants.js";
export * from "./core/relationship/relationship-constants.js";
export * from "./core/query/query-constants.js";
export * from "./persistence/source/source-constants.js";
export * from "./persistence/origin/origin-constants.js";
export * from "./persistence/db/db-constants.js";
export * from "./presentation/view/view-constants.js";
export * from "./presentation/layout/layout-constants.js";
```

- [ ] **Step 3: Verify the barrel preserves everything + tests pass.**

```
cd <repo-root>/server/typescript && bun run --filter '@metaobjectsdev/metadata' typecheck && bun test 2>&1 | tail -4
```
Expected: typecheck clean, 2034-ish pass / 0 fail. (Any "X is not exported" error means a constant was missed in the split — find it in git history of constants.ts and place it.)

- [ ] **Step 4: Repoint internal importers off `./constants.js` onto the concern modules.** Find them:

```
cd <repo-root>
grep -rln 'from "\.\./constants\.js"\|from "\./constants\.js"\|from "\.\./\.\./constants\.js"' server/typescript/packages/metadata/src --include="*.ts"
```
For each file, change its import to the specific concern module(s) it actually uses (e.g., `db-attr-schemas.ts` imports `FIELD_ATTR_DB_COLUMN` → from `./db-constants.js` once db moves, or `../persistence/db/db-constants.js`). This is the bulk of the work; do it file by file, re-running typecheck after each batch.

- [ ] **Step 5: Delete the now-unused `constants.ts`** once nothing imports `./constants.js` internally and `index.ts` re-exports the concern modules directly (next step).

- [ ] **Step 6: Update `metadata/src/index.ts`** — replace `export * from "./constants.js"` with the per-concern re-exports (same list as Step 2's barrel). This preserves the public bare-name surface for the 7 consumer packages.

```
grep -n "constants" server/typescript/packages/metadata/src/index.ts   # confirm old line replaced
```

- [ ] **Step 7: Full verify + golden gate + commit.**

```
cd <repo-root>/server/typescript && bun test 2>&1 | tail -4 && bun run --filter '*' typecheck 2>&1 | grep -c "Exited with code 0"
cd <repo-root>
test -f server/typescript/packages/metadata/src/constants.ts && echo "STILL EXISTS — should be deleted" || echo "constants.ts deleted OK"
git diff $(cat /tmp/colocation-base-sha.txt) -- server/typescript/packages/codegen-ts/test/golden server/typescript/packages/codegen-ts-tanstack/test/golden  # empty
git add -A && git commit -m "refactor(metadata): shatter constants.ts into per-concern co-located modules"
```
Expected: tests pass, all packages typecheck (13), constants.ts gone, golden empty.

---

## Task 4: Split `core-attr-schemas.ts` into per-concern schema modules

**Files:**
- Create: `core/{object,field,validator,identity,relationship}/`*-schema.ts`, `persistence/{source,origin}/`*-schema.ts`, `presentation/{view,layout}/`*-schema.ts`
- Modify: `core-types.ts` (repoint schema imports)
- Delete (end): `core-attr-schemas.ts`

- [ ] **Step 1: Inventory the exported schema arrays.**

```
cd <repo-root>
grep -nE "^export const .*Attrs|^export const .*Schema" server/typescript/packages/metadata/src/core-attr-schemas.ts
```
Record each array (e.g., `objectAttrs`, `fieldAttrs`, `validatorAttrs`, `idAttrs`, `relationshipAttrs`, `viewAttrs`, `dataGridLayoutAttrs`, `originAttrs`, source attrs).

- [ ] **Step 2: Move each schema array** into its concern's `*-schema.ts` file (cut), updating its imports to pull constants from the co-located `*-constants.ts` (e.g., `field-schema.ts` imports field attr names from `./field-constants.js`). `dataGridLayoutAttrs` → `presentation/layout/layout-schema.ts`.

- [ ] **Step 3: Rewire `core-types.ts`** — replace the single `import { ... } from "./core-attr-schemas.js"` with imports from each concern's `*-schema.ts`. The `registerCoreTypes()` body and `def()` calls are unchanged — only the import sources move.

```
grep -n "core-attr-schemas" server/typescript/packages/metadata/src/core-types.ts   # confirm replaced
```

- [ ] **Step 4: Delete `core-attr-schemas.ts`** once nothing imports it.

```
grep -rln "core-attr-schemas" server/typescript/packages/metadata/src --include="*.ts"   # expect empty
git rm server/typescript/packages/metadata/src/core-attr-schemas.ts
```

- [ ] **Step 5: Full verify + golden gate + commit.**

```
cd <repo-root>/server/typescript && bun test 2>&1 | tail -4 && bun run --filter '@metaobjectsdev/metadata' typecheck
cd <repo-root>
git diff $(cat /tmp/colocation-base-sha.txt) -- server/typescript/packages/codegen-ts/test/golden server/typescript/packages/codegen-ts-tanstack/test/golden  # empty
git add -A && git commit -m "refactor(metadata): split core-attr-schemas into per-concern schema modules"
```
Expected: 2034 pass / 0 fail (conformance fixtures = canonical-output gate), golden empty.

---

## Task 5: Relocate node accessors + db/ into concern folders

**Files:** move `meta/meta-*.ts` → concern folders; move `src/db/` → `persistence/db/`.

> This is the highest-churn, lowest-risk-per-value phase. It completes physical co-location. It can be a review checkpoint — Phases 1-4 already delivered the god-file fix.

- [ ] **Step 1: Move each accessor** with `git mv`, then fix its internal relative imports. Mapping:
  - `meta/meta-object.ts` → `core/object/meta-object.ts`
  - `meta/meta-field.ts` → `core/field/meta-field.ts`
  - `meta/meta-attr*.ts` → `core/attr/`
  - `meta/meta-validator.ts` → `core/validator/`
  - `meta/meta-identity.ts` → `core/identity/`
  - `meta/meta-relationship.ts` → `core/relationship/`
  - `meta/meta-source.ts` → `persistence/source/`
  - `meta/meta-origin.ts` → `persistence/origin/`
  - `meta/meta-view.ts` → `presentation/view/`
  - `meta/meta-layout.ts` → `presentation/layout/`
  - `meta/meta-data.ts`, `meta/meta-root.ts`, `meta/find-reference.ts` → keep in a `core/` or `shared/` base location (they are cross-concern base classes — put `meta-data.ts`/`meta-root.ts` in `shared/`).

Do ONE accessor at a time: `git mv`, update that file's relative imports, update importers of that file (grep for its old path), run `bun run --filter '@metaobjectsdev/metadata' typecheck`. Commit per accessor or per concern group to keep diffs reviewable.

- [ ] **Step 2: Move `src/db/`** → `persistence/db/` (`git mv server/typescript/packages/metadata/src/db server/typescript/packages/metadata/src/persistence/db`), fix imports in `db-provider.ts`, `db-attr-schemas.ts`, and `core-types.ts`'s `import { dbProvider } from "./db/db-provider.js"` → `"./persistence/db/db-provider.js"`.

- [ ] **Step 3: Delete the now-empty `meta/` dir** (if fully drained) and verify.

```
cd <repo-root>
ls server/typescript/packages/metadata/src/meta/ 2>/dev/null || echo "meta/ gone"
cd server/typescript && bun test 2>&1 | tail -4 && bun run --filter '*' typecheck 2>&1 | grep -c "Exited with code 0"
```

- [ ] **Step 4: Golden gate + commit.**

```
cd <repo-root>
git diff $(cat /tmp/colocation-base-sha.txt) -- server/typescript/packages/codegen-ts/test/golden server/typescript/packages/codegen-ts-tanstack/test/golden  # empty
git add -A && git commit -m "refactor(metadata): relocate node accessors + db provider into concern folders"
```

---

## Task 6: Final verification

- [ ] **Step 1: Structure assertions.**

```
cd <repo-root>
test -f server/typescript/packages/metadata/src/constants.ts && echo "FAIL: constants.ts exists" || echo "ok: constants.ts gone"
test -f server/typescript/packages/metadata/src/core-attr-schemas.ts && echo "FAIL: core-attr-schemas.ts exists" || echo "ok: core-attr-schemas.ts gone"
grep -rn "javaRuntime\|JAVA_RUNTIME" server/typescript/packages/metadata/src --include="*.ts" | grep -v "/dist/" || echo "ok: no javaRuntime"
ls server/typescript/packages/metadata/src/{shared,core,persistence,presentation}/ 2>/dev/null
```
Expected: both monoliths gone, no javaRuntime, the four layer dirs present.

- [ ] **Step 2: Clean install + full test + typecheck + build.**

```
cd <repo-root>/server/typescript
rm -rf node_modules && bun install
bun test 2>&1 | tail -4              # 2034 pass / 0 fail
bun run --filter '*' typecheck 2>&1 | grep -c "Exited with code 0"   # 13
bun run --filter '*' build 2>&1 | grep -c "Exited with code 0"      # 13
```

- [ ] **Step 3: Client/web tests (consumers of metadata).**

```
for p in <repo-root>/client/web/packages/{runtime-web,react,tanstack}; do echo "=== $p ==="; (cd "$p" && bun test 2>&1 | tail -3); done
```
Expected: 30 / 12 / 29, all 0 fail.

- [ ] **Step 4: Conformance / canonical-output gate (the load-bearing check).**

```
cd <repo-root>
git diff $(cat /tmp/colocation-base-sha.txt) -- server/typescript/packages/codegen-ts/test/golden server/typescript/packages/codegen-ts-tanstack/test/golden
```
Expected: **completely empty** across the whole refactor. The conformance fixtures (run inside `bun test`) plus zero golden diff together prove byte-identical canonical output.

- [ ] **Step 5: Consumer-import sanity — the 7 packages compiled with zero import changes?**

```
cd <repo-root>
git diff $(cat /tmp/colocation-base-sha.txt) --stat -- server/typescript/packages/codegen-ts/src server/typescript/packages/codegen-ts-tanstack/src server/typescript/packages/runtime-ts/src server/typescript/packages/cli/src server/typescript/packages/migrate-ts/src server/typescript/packages/sdk/src | tail -5
```
Expected: empty or near-empty (only the deleted `@javaRuntime` symbol if any consumer referenced it — verified none do). Consumer source should be untouched because the barrel preserves the bare-name surface.

- [ ] **Step 6: Push the branch.**

```
git push -u origin refactor/metadata-constants-colocation
```
Do NOT merge — hand back for review.

---

## Self-Review Notes

The conformance fixtures are the canonical-output contract; "45 fixtures pass" runs inside `bun test`, so the green test suite already proves wire-neutrality — the explicit golden-diff checks are belt-and-suspenders for the codegen emitted output specifically.

The riskiest mechanical step is Task 3 Step 4 (repointing internal `./constants.js` imports). If a constant is referenced internally but missed in the split, typecheck fails with "not exported" — fix by locating the constant in the pre-refactor `constants.ts` (via `git show <base-sha>:server/typescript/packages/metadata/src/constants.ts`) and placing it in the right concern module.

If Phase 4 (accessor relocation) proves larger than expected or risk surfaces, it can stop after Task 4 and ship Phases 1-3 as the god-file fix — the tree is green at every phase boundary. Tasks 1-4 deliver the user's actual ask (kill the constants god-file); Task 5 is physical-co-location polish.

`shared/base-types.ts` housing `meta-data.ts`/`meta-root.ts` (Task 5 Step 1) — confirm these base classes don't create a circular import with the concern modules; if they do, keep them in a dedicated `core/base/` instead. Resolve during implementation.
