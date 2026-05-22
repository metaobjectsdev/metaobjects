# FR-003 Plan 1 — Port dynamic/om/omdb onto 7.0.0 core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the persistence modules `dynamic` (`ValueObject`/`DataObject`), `om` (ObjectManager), and `omdb` (ObjectManagerDB) from the separate `metaobjects-dynamic` project (`6.2.6-SNAPSHOT`) into this monorepo, compiling and passing their existing test suites against the current core, with all modules unified at `7.0.0-SNAPSHOT`.

**Architecture:** Same `com.metaobjects.*` namespace on both sides, so this is an API-alignment port, not a rename. Most loader/`MetaObject`/`MetaField` APIs are unchanged; the breaking gaps are concentrated in (a) `MetaField` value accessors and (b) primary-key/sequence/index metadata that moved from field-level attributes to `MetaIdentity`. The existing JUnit4 + Derby test suites in each module are the correctness gate — "done" means they compile and pass against the current core.

**Tech Stack:** Java 17, Maven (multi-module reactor under `server/java/`), JUnit4, Apache Derby (in-memory, omdb tests), git-filter-repo not involved.

**This is Plan 1 of a 5-plan series for FR-003** (each later plan is detailed only after the prior lands, because each builds on the 7.0.0 API this plan establishes):
1. **Port dynamic/om/omdb → 7.0.0** ← *this plan*
2. Spring-transaction-aware `ObjectConnection` adapter + jsonb value-object fields
3. Metadata-driven schema migration (`meta migrate` emit/verify/diff/apply)
4. Dynamic projection views (origin→view SQL) + codegen templates (entity base, SQL-name constants, projection VOs, repo base)
5. Conformance fixtures for the new vocabulary

**Source location placeholder:** `<dynamic-src>` = the checkout of the `metaobjects-dynamic` project on your machine (the `dynamic/`, `om/`, `omdb/` module directories). All in-repo paths below are relative to this repo's root.

---

## API Gap Mapping (reference — tasks point here)

Apply these when a compile error in the listed category appears. Verified against the current core unless marked **(verify at compile)**.

| # | Symptom (old API) | Replacement (current core) | Where it bites |
|---|---|---|---|
| G1 | `loader` used as a `MetaData` node / `loader.getChildren(...)` | Tree access is via `loader.getRoot()` → `MetaRoot`; e.g. `loader.getRoot().getChildren(MetaObject.class, true)`. `loader.getMetaObjects()`, `getMetaObjectByName(String)`, `getMetaObjectFor(Object)` are **unchanged**. | om, omdb loader-walking |
| G2 | `MetaDataUtil.findMetaObjectByName(name, ctx)` / `getAllMetaDataLoaders(ctx)` | Still present in core's `MetaDataUtil`; if a signature differs, use `MetaDataLoaderRegistry.findMetaObjectByName(String)` / `.getDataLoaders()`. **(verify at compile)** | om, omdb |
| G3 | `field.getObject(o)` / `field.setString(o,v)` / `setInt(...)` | **(verify at compile)** Confirm these still exist on `MetaField`/typed subclasses. If removed in favor of generic `MetaField<T>.getValue(o)`/`setValue(o,v)`, route through the typed subclass (`StringField`, `IntegerField`, …) which you already `instanceof`-check. Keep the existing `instanceof StringField` dispatch. | omdb `GenericSQLDriver.parseField`, statement-setting |
| G4 | field-level primary-key flag (`isPrimaryKey()` / `@isPrimaryKey`) | `MetaObject.getPrimaryIdentity()` → `PrimaryIdentity`; membership via `field.isPartOfPrimaryIdentity()` or `primaryIdentity.getFields().contains(field.getName())`. `isSecondaryKey()` → `field.isPartOfSecondaryIdentity()`. | omdb `SimpleMappingHandlerDB`, key/where builders |
| G5 | field-level `dbSequence` / `dbIndex` attr reads | Identity-level attrs in `CoreDBMetaDataProvider`: `DB_SEQUENCE_NAME`, `DB_INDEX_NAME`, `DB_TABLESPACE` on `PrimaryIdentity`/`SecondaryIdentity`. Read from the identity, not the field. | omdb `SimpleMappingHandlerDB`, `defs/SequenceDef`,`IndexDef` |
| G6 | `META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` listing old provider IDs | Interface unchanged (`getProviderId/getDependencies/registerTypes/getDescription`). Ensure each ported provider declares correct `getDependencies()` (e.g. `"field-types","object-types","identity-types"`) so it loads after core providers. | dynamic, om, omdb providers |
| G7 | DB attrs assumed registered by the module | Core now registers `@dbTable/@dbColumn/@dbNullable/@dbForeignKey/@dbIndex/@dbUnique/@dbLength/@dbPrecision/@dbScale/@dbAutoIncrement` via `CoreDBMetaDataProvider`. Remove any duplicate registration in the ported modules to avoid conflicts. | omdb provider |

When a compile error doesn't map to G1–G7, read the error, find the current core's equivalent (search `server/java/metadata/src/main/java/com/metaobjects/`), and prefer the non-deprecated method. Do not reintroduce field-level key flags.

---

## Task 0.1: Land the three modules in the monorepo

**Files:**
- Create: `server/java/dynamic/` (copied from `<dynamic-src>/dynamic/`)
- Create: `server/java/om/` (copied from `<dynamic-src>/om/`)
- Create: `server/java/omdb/` (copied from `<dynamic-src>/omdb/`)
- Modify: `server/java/pom.xml` (reactor `<modules>`)

- [ ] **Step 1: Copy the module trees in (excluding build output)**

```bash
cd server/java
for m in dynamic om omdb; do
  rsync -a --exclude target --exclude '.git' "<dynamic-src>/$m/" "./$m/"
done
git add dynamic om omdb
```

- [ ] **Step 2: Register the modules in the reactor**

In `server/java/pom.xml`, add to the `<modules>` block (after the existing modules, before any aggregator like `examples`):

```xml
    <module>dynamic</module>
    <module>om</module>
    <module>omdb</module>
```

- [ ] **Step 3: Confirm the reactor sees them**

Run: `cd server/java && mvn -N validate`
Expected: BUILD SUCCESS; no "child module ... does not exist" errors.

- [ ] **Step 4: Commit**

```bash
git add server/java/pom.xml server/java/dynamic server/java/om server/java/omdb
git commit -m "chore(java): vendor dynamic/om/omdb modules into the monorepo reactor"
```

---

## Task 0.2: Point the three module POMs at this repo's parent + version

**Files:**
- Modify: `server/java/dynamic/pom.xml`
- Modify: `server/java/om/pom.xml`
- Modify: `server/java/omdb/pom.xml`

- [ ] **Step 1: Repoint each module's `<parent>` to this repo's parent**

In each of the three poms, set the parent to the reactor parent (match the exact coordinates already used by `server/java/metadata/pom.xml`'s `<parent>` — read that file first to copy the groupId/artifactId/version/relativePath verbatim). The parent artifactId is `metaobjects`.

- [ ] **Step 2: Remove hardcoded `6.2.6-SNAPSHOT` dependency versions**

In each module pom, delete explicit `<version>6.2.6-SNAPSHOT</version>` on `metaobjects-metadata`, `metaobjects-core`, `metaobjects-codegen-base`, `metaobjects-codegen-mustache` dependencies so they inherit the reactor version via `dependencyManagement` (mirror how `server/java/core/pom.xml` declares its `metaobjects-*` deps — read it and match).

- [ ] **Step 3: Confirm dependency resolution + build order**

Run: `cd server/java && mvn -pl dynamic,om,omdb -am -o dependency:tree 2>&1 | grep -E "metaobjects-(metadata|core|dynamic-core|om):"`
Expected: every `metaobjects-*` dep resolves at the reactor version (not `6.2.6`). Reactor build order prints `dynamic` → `om` → `omdb`.

- [ ] **Step 4: Commit**

```bash
git add server/java/dynamic/pom.xml server/java/om/pom.xml server/java/omdb/pom.xml
git commit -m "chore(java): repoint dynamic/om/omdb poms to the reactor parent + inherited versions"
```

---

## Task 0.3: Unify all module versions at 7.0.0-SNAPSHOT

**Files:**
- Modify: `server/java/pom.xml` and every child module `pom.xml` carrying a version (via the Maven versions plugin).

- [ ] **Step 1: Set the whole reactor to 7.0.0-SNAPSHOT**

Run: `cd server/java && mvn -o versions:set -DnewVersion=7.0.0-SNAPSHOT -DprocessAllModules=true -DgenerateBackupPoms=false`
Expected: "Processing change of ... 6.3.1-SNAPSHOT -> 7.0.0-SNAPSHOT" for the parent + all modules.

- [ ] **Step 2: Verify no `6.3.1`/`6.2.6` version strings remain in poms**

Run: `cd server/java && grep -rEn "6\.(2\.6|3\.1)-SNAPSHOT" --include=pom.xml .`
Expected: no output (empty).

- [ ] **Step 3: Reactor still resolves end to end**

Run: `cd server/java && mvn -N validate && mvn -o -pl dynamic,om,omdb -am dependency:resolve 2>&1 | tail -5`
Expected: BUILD SUCCESS.

- [ ] **Step 4: Commit**

```bash
git add server/java
git commit -m "chore(java): unify all modules at 7.0.0-SNAPSHOT (re-unify version line)"
```

---

## Task 1.1: Compile `dynamic` against current core; catalog gaps

**Files:**
- Test: existing `server/java/dynamic/src/test/java/**` (e.g. `com/metaobjects/object/data/DataObjectTest.java`)

- [ ] **Step 1: Attempt the compile (the failing "test")**

Run: `cd server/java && mvn -o -pl dynamic -am compile 2>&1 | tee /tmp/dynamic-compile.log | tail -40`
Expected: either BUILD SUCCESS (jump to Task 1.3) or compile errors. Errors are the work list.

- [ ] **Step 2: Categorize each error against the Gap Mapping**

Run: `grep -E "ERROR.*\.java" /tmp/dynamic-compile.log`
For each error, tag it G1–G7 (see the mapping table). `dynamic` mainly touches `ValueObject`/`DataObject` field access — expect G3 (field accessors) and possibly G1 (loader/root) and the `isArray` modifier.

---

## Task 1.2: Resolve `dynamic` compile gaps

**Files:**
- Modify: the `server/java/dynamic/src/main/java/com/metaobjects/object/{value,data}/*.java` files flagged in Task 1.1.

- [ ] **Step 1: Apply the mapped fix per error, one file at a time**

For each flagged file, apply the replacement from its gap row. The most likely:
- **G3** — if `field.getObject(o)`/`setX(o,v)` no longer resolve, route through the typed field subclass already in scope, or the generic `MetaField` value method the compiler points to. Keep existing `instanceof <Type>Field` dispatch.
- **isArray** — if array detection used a removed helper, read the field's `isArray` modifier via the core constant `MetaField.ATTR_IS_ARRAY` (`field.hasMetaAttr(MetaField.ATTR_IS_ARRAY)` / the boolean accessor the compiler indicates).

Make the minimal change that resolves the specific error; do not refactor unrelated code.

- [ ] **Step 2: Recompile until clean**

Run: `cd server/java && mvn -o -pl dynamic -am compile 2>&1 | tail -20`
Expected: BUILD SUCCESS. Repeat Step 1 for any remaining errors.

- [ ] **Step 3: Commit**

```bash
git add server/java/dynamic/src/main/java
git commit -m "feat(java): port dynamic module to 7.0.0 core API"
```

---

## Task 1.3: Run the `dynamic` test suite green

**Files:**
- Test: `server/java/dynamic/src/test/java/**`

- [ ] **Step 1: Run dynamic's existing tests**

Run: `cd server/java && mvn -o -pl dynamic -am test 2>&1 | tee /tmp/dynamic-test.log | tail -30`
Expected: ideally BUILD SUCCESS. If failures, they are real behavioral gaps.

- [ ] **Step 2: For each failing test, fix the source (not the test) unless the test asserts removed behavior**

If a test asserts a removed field-level key flag or old loader-as-node behavior, update the test to the current-core equivalent (G1/G4) — and note it in the commit message. Otherwise fix the main source.

- [ ] **Step 3: Re-run until green**

Run: `cd server/java && mvn -o -pl dynamic test 2>&1 | grep -E "Tests run|BUILD"`
Expected: `BUILD SUCCESS`, 0 failures, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/java/dynamic
git commit -m "test(java): dynamic module test suite green on 7.0.0 core"
```

---

## Task 2.1: Compile `om` against current core; catalog gaps

**Files:**
- Test: existing `server/java/om/src/test/java/**`

- [ ] **Step 1: Attempt the compile**

Run: `cd server/java && mvn -o -pl om -am compile 2>&1 | tee /tmp/om-compile.log | tail -40`
Expected: BUILD SUCCESS or errors. `om` calls `MetaDataUtil.findMetaObjectByName`, `MetaDataLoaderRegistry`, `MetaField` accessors → expect G1, G2, G3.

- [ ] **Step 2: Categorize errors against G1–G7**

Run: `grep -E "ERROR.*\.java" /tmp/om-compile.log`

---

## Task 2.2: Resolve `om` compile gaps + tests green

**Files:**
- Modify: flagged files under `server/java/om/src/main/java/com/metaobjects/manager/**`
- Test: `server/java/om/src/test/java/**`

- [ ] **Step 1: Apply mapped fixes (G1/G2/G3)**

- **G1** — replace any `loader`-as-node tree walking with `loader.getRoot()....`; keep `getMetaObjects()`/`getMetaObjectByName()`/`getMetaObjectFor()` as-is.
- **G2** — if `MetaDataUtil.findMetaObjectByName(name, ctx)` signature differs, switch to `MetaDataLoaderRegistry.findMetaObjectByName(name)` / `.getDataLoaders()`.
- **G3** — typed field accessor routing as in Task 1.2.

- [ ] **Step 2: Recompile until clean**

Run: `cd server/java && mvn -o -pl om -am compile 2>&1 | tail -20`
Expected: BUILD SUCCESS.

- [ ] **Step 3: Run om's tests green**

Run: `cd server/java && mvn -o -pl om -am test 2>&1 | grep -E "Tests run|BUILD"`
Expected: BUILD SUCCESS, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add server/java/om
git commit -m "feat(java): port om (ObjectManager) module to 7.0.0 core + tests green"
```

---

## Task 3.1: Compile `omdb` against current core; catalog gaps

**Files:**
- Test: existing `server/java/omdb/src/test/java/**` (Derby in-memory)

- [ ] **Step 1: Attempt the compile**

Run: `cd server/java && mvn -o -pl omdb -am compile 2>&1 | tee /tmp/omdb-compile.log | tail -60`
Expected: errors concentrated in `SimpleMappingHandlerDB`, `GenericSQLDriver`, `defs/*`. Expect G3 (field accessors), G4 (primary-key→identity), G5 (sequence/index→identity), G7 (duplicate DB-attr registration).

- [ ] **Step 2: Categorize errors against G1–G7**

Run: `grep -E "ERROR.*\.java" /tmp/omdb-compile.log | sort -u`

---

## Task 3.2: Resolve `omdb` field-accessor + identity-migration gaps

**Files:**
- Modify: `server/java/omdb/src/main/java/com/metaobjects/manager/db/SimpleMappingHandlerDB.java`
- Modify: `server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/GenericSQLDriver.java`
- Modify: `server/java/omdb/src/main/java/com/metaobjects/manager/db/defs/*.java` (SequenceDef, IndexDef, ForeignKeyDef as flagged)
- Modify: `server/java/omdb/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` (if it re-registers DB attrs)

- [ ] **Step 1: Primary key — switch from field flags to identity (G4)**

Wherever omdb decides "is this field a primary key", replace field-level checks with:

```java
// was: some field-level isPrimaryKey check
MetaObject mo = (MetaObject) field.getParent();
PrimaryIdentity pk = mo.getPrimaryIdentity();
boolean isPk = pk != null && pk.getFields().contains(field.getName());
// or, equivalently for a field in scope:
boolean isPk = field.isPartOfPrimaryIdentity();
```

Use `field.isPartOfSecondaryIdentity()` for secondary keys.

- [ ] **Step 2: Sequence/index — read from identity, not field (G5)**

Where omdb read a field-level `dbSequence`/`dbIndex`, read the identity-level attrs from the `PrimaryIdentity`/`SecondaryIdentity` using the core constants `CoreDBMetaDataProvider.DB_SEQUENCE_NAME` / `DB_INDEX_NAME` / `DB_TABLESPACE`. Build `SequenceDef`/`IndexDef` from the identity.

- [ ] **Step 3: Field value get/set — typed routing (G3)**

In `GenericSQLDriver.parseField(...)` and the prepared-statement value setters, keep the `instanceof StringField/IntegerField/...` dispatch; for each branch use the value method the compiler accepts on that typed field (the typed `getValue/setValue` or the existing `getObject/setX` if still present — confirm at compile).

- [ ] **Step 4: Remove duplicate DB-attr registration (G7)**

If omdb's provider re-registers `dbTable`/`dbColumn`/etc. that `CoreDBMetaDataProvider` now owns, delete those registrations (keep only omdb-specific ones, if any). Ensure `getDependencies()` returns `{"field-types","object-types","identity-types"}`.

- [ ] **Step 5: Recompile until clean**

Run: `cd server/java && mvn -o -pl omdb -am compile 2>&1 | tail -30`
Expected: BUILD SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add server/java/omdb/src/main
git commit -m "feat(java): port omdb to 7.0.0 core (identity-based keys/sequences, typed field access)"
```

---

## Task 3.3: Run the `omdb` Derby test suite green

**Files:**
- Test: `server/java/omdb/src/test/java/**`

- [ ] **Step 1: Run omdb's tests (Derby in-memory)**

Run: `cd server/java && mvn -o -pl omdb -am test 2>&1 | tee /tmp/omdb-test.log | tail -40`
Expected: ideally BUILD SUCCESS. Failures are typically: (a) test metadata still declares field-level keys → update the test fixture metadata to use `identity.primary`; (b) DDL/SQL assertions that changed.

- [ ] **Step 2: Fix failures — prefer fixing test metadata to the new identity vocabulary**

For a test whose metadata marks a primary key on a field, move it to an `identity.primary` child of the object (mirror the canonical form in `fixtures/conformance/source-db-table-explicit/` and the identity provider). Fix main-source bugs otherwise.

- [ ] **Step 3: Re-run until green**

Run: `cd server/java && mvn -o -pl omdb test 2>&1 | grep -E "Tests run|BUILD"`
Expected: BUILD SUCCESS, 0 failures, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/java/omdb
git commit -m "test(java): omdb Derby test suite green on 7.0.0 core"
```

---

## Task 4.1: Full reactor build + version-unification verification

**Files:** none (verification + final commit)

- [ ] **Step 1: Build the three modules + everything they depend on, with tests**

Run: `cd server/java && mvn -o -pl dynamic,om,omdb -am test 2>&1 | tail -30`
Expected: BUILD SUCCESS across `metadata`, `core`, `codegen-*`, `dynamic`, `om`, `omdb`.

- [ ] **Step 2: Confirm no stale 6.x version or 6.2.6 dependency leaked in**

Run: `cd server/java && grep -rEn "6\.(2\.6|3\.1)-SNAPSHOT" --include=pom.xml . ; echo "exit:$?"`
Expected: no matches.

- [ ] **Step 3: Confirm the three modules publish at 7.0.0-SNAPSHOT**

Run: `cd server/java && mvn -o -pl dynamic,om,omdb help:evaluate -Dexpression=project.version -q -DforceStdout 2>/dev/null | sort -u`
Expected: `7.0.0-SNAPSHOT` only.

- [ ] **Step 4: Final commit**

```bash
git add -A server/java
git commit -m "chore(java): dynamic/om/omdb compiling + green at 7.0.0-SNAPSHOT in the monorepo"
```

---

## Self-Review

- **Spec coverage (Plan-1 slice of FR-003 §1):** port `dynamic`+`om`+`omdb` (Tasks 1–3), consolidate into monorepo (Task 0.1–0.2), re-unify versions at 7.0.0 (Task 0.3, 4.1). ✓ The deferred modules (`omnosql`/`web`/`web-spring`/`demo`) are explicitly out of scope per the spec. The remaining FR-003 subsystems (Spring-tx, jsonb, migration, projections, codegen, conformance) are Plans 2–5. ✓
- **Placeholder scan:** the gap fixes are discovery-driven by design (a cross-version port can't pre-write fixes for compile errors that don't exist yet); each is bounded by the G1–G7 mapping with the exact replacement API + the discovery command, which is complete guidance, not a TODO. No "TBD/handle edge cases" steps.
- **Type consistency:** uses the verified current-core APIs — `loader.getRoot()`, `getMetaObjectByName`, `getMetaObjects`, `getMetaObjectFor`, `MetaObject.getPrimaryIdentity()`, `field.isPartOfPrimaryIdentity()`, `CoreDBMetaDataProvider.DB_SEQUENCE_NAME/DB_INDEX_NAME`. Items the gap analysis flagged "verify at compile" (exact `MetaField` get/set signatures, `MetaDataUtil` signatures) are called out as such in G2/G3 rather than asserted.
- **Public-repo hygiene:** no absolute home paths, no private-project names (uses `<dynamic-src>` + repo-relative paths) so it passes the pre-commit guard.
