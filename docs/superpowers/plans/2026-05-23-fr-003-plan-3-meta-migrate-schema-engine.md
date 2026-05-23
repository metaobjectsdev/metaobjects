# FR-003 Plan 3 — `meta migrate` diff-and-converge schema engine (standardized on `migrate-ts`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the boot-time, create-if-missing `MetaClassDBValidatorService` into a **decoupled, diff-and-converge schema engine** whose model and verbs are a faithful Java port of the shipped TS reference (`server/typescript/packages/migrate-ts/`) — introspect a live DB, deterministically diff it against metadata, and surface the result through `diff` / `verify` / `emit` / `apply`, **not** auto-applied as a side effect of persistence.

**Architecture:** A Java mirror of `migrate-ts`'s contract, reusing the proven OMDB derivation rather than re-deriving. The cross-language spine: a **canonical, dialect-neutral `SqlType`** (both sides produce it; the differ compares canonical-to-canonical; emit re-renders to dialect SQL); a **symmetric `SchemaSnapshot`** (same shape for *expected* — built from metadata — and *actual* — from introspection); a `Change` union where every change carries a **`ChangeStatus {allowed|blocked,reason}`** computed against **`AllowOptions`** (destructive opt-in; widening always allowed); `diff()` → `DiffResult {changes, blocked}`; `emit()` → `EmitResult` (throws `BlockedChangesError` if a blocked change would be written). The **expected snapshot reuses the `MappingHandler`'s `TableDef`/`ViewDef`** (the same derivation `MetaClassDBValidatorService` uses) and the **canonical type comes from `SimpleMappingHandlerDB`'s existing field→type mapping** — no re-derivation, no bespoke type ladders. Render primitives live on the **dialect driver** (Postgres + Derby in v1) so `emit` and `apply` share one DDL source. The engine is standalone (it never touches the boot-time validator), which is the decoupling FR-003 §4 mandates.

**Tech Stack:** Java 17 (sealed interfaces + records mirror the TS discriminated unions; record `equals` *is* structural `sqlTypeEquals`), Maven reactor under `server/java/` (modules `metadata`, `omdb`, `maven-plugin`), JUnit4, Apache Derby (in-memory; the existing `AbstractOMDBTest`/`JsonbFieldDBTest` harness), `maven-plugin-testing-harness`. Postgres is the primary production dialect; Derby is the fast in-memory test dialect.

**Plan series:** Plan 1 (port) ✅. Plan 2 (binding registry + jsonb + Spring-tx) ✅. **This is Plan 3.** Plan 4 = projection views (origin→view SQL) + codegen templates. Plan 5 = conformance fixtures.

**Decisions of record:**
- FR-003 §4 (decoupled `meta migrate`; deterministic diffs; baseline-adoption then schema-equivalence). Resolves FR-003 open questions **#1** (decoupled verbs, not boot-time auto-apply), **#2** (destructive policy via `AllowOptions` + `@previousName`), **#5** (v1 ALTER scope = create table/column + widen + index/fk/view).
- **Standardize on `migrate-ts`:** the model (`SqlType`, `SchemaSnapshot`, `Change`/`ChangeStatus`, `AllowOptions`, `DiffResult`, `EmitResult`, `BlockedChangesError`, `applyStatus`/`isWidening`) is a 1:1 Java port of `migrate-ts/src/{types,sql-type,diff/status,errors,diff/index}.ts`. Java names mirror TS names. This is the cross-language-standard choice (the conformance suite pins vocabulary; the runtime surface stays idiomatic).
- **Reuse, don't re-derive (per CLAUDE.md):** expected snapshot ← `MappingHandler` defs (shared `ExpectedSchemaBuilder`, also usable by the validator); canonical type ← `SimpleMappingHandlerDB.getSQLType`; DDL text ← dialect driver render primitives (extracted from the existing `createTable`).

**⚠ Two FR-vs-reference divergences (decided for v1; flagged for FR reconciliation):**
1. **Down migrations.** `migrate-ts` `EmitResult` ships `up` **and** `down` (`write-migration.ts` writes both). FR-003 says forward-only. **v1 decision:** Java emits **`up` only**, but `EmitResult` *declares* a `down` field (empty in v1) for shape parity. Update FR-003's "forward-only" line to note the TS reference emits down, and that Java-v1 down is deferred — not an undocumented divergence.
2. **Rename mechanism.** `migrate-ts` infers renames via a **heuristic** (`detectColumnRenames`/`detectTableRenames`) gated by an `onAmbiguous` callback; it does **not** read `@previousName`. FR-003 specs **`@previousName`** ("never inferred"). **v1 decision:** Java uses **`@previousName` only** (deterministic, CI-friendly for a build-time mojo; an interactive `onAmbiguous` callback doesn't fit a Maven goal). The `rename-table`/`rename-column` change kinds are modeled identically to TS, so a future heuristic is additive. Flag for FR: ideal end-state is both ports honoring `@previousName` (explicit-wins) + heuristic (fallback).

**Scope boundary:**
- **In:** the full canonical model (mirrored from TS), expected+actual snapshot builders, the differ + status, Postgres + Derby render primitives, the engine + four verbs, `@previousName` rename, and a `migrate` Maven mojo.
- **Out (later plans/FRs):** down-migration generation (decision 1); the rename *heuristic* + `onAmbiguous` (decision 2); MySQL/Oracle/MSSQL render primitives (inherit the engine for free once their primitives land); `change-column-nullable` / `change-column-default` *production* (the kinds are **declared** for shape parity but the v1 differ does **not** emit them — exactly as `migrate-ts` declares `create-view`/`drop-view`/`replace-view` but never produces them in v0.1); origin→view SQL *derivation* (Plan 4 — here `create-view` renders existing `ViewDef.getSQL()`); byte-identical cross-language SQL corpus (future, FR-003 §7); multi-schema table identity (Postgres null↔"public" normalization — v1 keys on name only; all fixtures/Derby use null schema); `@dbLength`-driven column length (`SimpleMappingHandlerDB.getSQLLength` returns a fixed 50 today — honoring `@dbLength` is a follow-up that also feeds the boot-time validator); `EmitResult.recreatedTables` (SQLite-only bookkeeping, N/A for Postgres/Derby in-place ALTER).
- **MVP stop point:** end of **Phase F** (engine + verbs, exercised against Derby) is independently useful and a valid place to pause before the Maven mojo (Phase G).

**Worktree:** execute in an isolated worktree off `main` (superpowers:using-git-worktrees). All paths repo-relative.

---

## Pre-flight: confirm the seams + the TS contract (read, don't guess)

- [ ] **Step 1: Read the TS reference model (the contract being ported)**

Read `server/typescript/packages/migrate-ts/src/types.ts` (`SchemaSnapshot`, `TableDescriptor`, `ColumnDescriptor`, `Change` union, `ChangeStatus`, `AllowOptions`, `DiffResult`, `EmitResult`), `sql-type.ts` (`SqlType` kinds, `sqlTypeEquals`, `isWidening`), `diff/status.ts` (`applyStatus` rules), `errors.ts` (`BlockedChangesError`), and `diff/index.ts` (the diff passes). The Java types in Phases B–E mirror these 1:1; the rules (widening always allowed, destructive blocked unless `allow.*`, nullable→notnull needs a flag) are ported verbatim.

- [ ] **Step 2: Confirm the desired-def derivation + the field→type seam**

Run: `cd server/java && grep -n "getCreateMapping\|getReadMapping\|getDBDef" omdb/src/main/java/com/metaobjects/manager/db/validator/MetaClassDBValidatorService.java && grep -n "getSQLType\|getSQLLength\|DB_TYPE_JSONB" omdb/src/main/java/com/metaobjects/manager/db/SimpleMappingHandlerDB.java`
Confirm `MetaClassDBValidatorService.init()` gathers defs via `loader.getMetaObjects()` → `mh.getCreateMapping(mc)`/`getReadMapping(mc)` → `((ObjectMappingDB) m).getDBDef()` → `TableDef`/`ViewDef` (the engine reuses this), and that `SimpleMappingHandlerDB.getSQLType(MetaField)` is the canonical field→`java.sql.Types` mapper (the expected-snapshot builder reuses it and converts the result to canonical `SqlType`).

- [ ] **Step 3: Confirm the attrs the snapshot reads + the driver DDL seam**

Run: `cd server/java && grep -n "DB_NULLABLE\|DB_COLUMN\|DB_TABLE\|DB_LENGTH" metadata/src/main/java/com/metaobjects/database/CoreDBMetaDataProvider.java && grep -n "ATTR_GENERATION\|getGeneration\|GENERATION_" metadata/src/main/java/com/metaobjects/identity/MetaIdentity.java && grep -n "public " omdb/src/main/java/com/metaobjects/manager/db/defs/ColumnDef.java`
Confirm: `@dbNullable` (`DB_NULLABLE`, boolean) is the nullability source on a field; `@generation` (`ATTR_GENERATION`, enum increment/uuid/assigned) on the primary identity is the `identity` source; `ColumnDef` exposes `getName/getSQLType/getLength/isPrimaryKey/isUnique`. Read `driver/PostgresDriver.java` `createTable` (the `Types`→SQL switch the render primitives extract) and `DerbyDriver.java`.

- [ ] **Step 4: Confirm the Derby + maven harnesses**

Read `omdb/src/test/java/com/metaobjects/manager/db/JsonbFieldDBTest.java` (Plan-2 Derby harness: `FileMetaDataLoader` + `LocalFileMetaDataSources` + `DerbyDriver` + `ObjectManagerDB` + `DataSource`) and `maven-plugin/src/test/java/com/metaobjects/mojo/MetaDataGeneratorMojoTest.java` (the `maven-plugin-testing-harness` setup). The E2E tasks (F1, G1) extend these.

---

## Phase A — Vocabulary: the `@previousName` rename hint

### Task A1: Register `@previousName` as an optional attribute on objects and fields

`@previousName` is Java v1's **only** rename mechanism (decision 2). It must be a registered, loadable attribute before the differ can read it.

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/database/CoreDBMetaDataProvider.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/database/PreviousNameAttrTest.java`
- Create (fixture): `server/java/metadata/src/test/resources/meta.rename.json`

- [ ] **Step 1: Write the failing test**

`meta.rename.json`:

```json
{ "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      { "object.pojo": {
          "name": "Program",
          "@dbTable": "program",
          "@previousName": "offering",
          "children": [
            { "field.string": { "name": "title", "@dbColumn": "title", "@previousName": "name" }}
          ]
      }}
    ]
}}
```

`PreviousNameAttrTest.java`:

```java
package com.metaobjects.database;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.file.FileMetaDataLoader;
import com.metaobjects.loader.file.FileLoaderOptions;
import com.metaobjects.loader.file.LocalFileMetaDataSources;
import com.metaobjects.object.MetaObject;
import com.metaobjects.field.MetaField;
import org.junit.Test;
import static org.junit.Assert.*;

public class PreviousNameAttrTest {

    private MetaDataLoader load() {
        FileMetaDataLoader xl = new FileMetaDataLoader(
            new FileLoaderOptions().setShouldRegister(true).setStrict(true).setVerbose(false),
            "previousName-test");
        xl.init(new LocalFileMetaDataSources("meta.rename.json"));
        return xl;
    }

    @Test
    public void object_and_field_load_previousName_without_constraint_violation() {
        MetaDataLoader loader = load();   // must not throw — attr is registered + allowed
        MetaObject program = loader.getMetaObjectByName("myapp::commerce::Program");
        assertTrue(program.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME));
        assertEquals("offering", program.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
        MetaField title = program.getMetaField("title");
        assertTrue(title.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME));
        assertEquals("name", title.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
    }
}
```

(Match the exact `FileMetaDataLoader`/`FileLoaderOptions` constructor an existing metadata loader test uses if it differs — read one first; the assertions are the contract.)

- [ ] **Step 2: Run, verify it fails**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=PreviousNameAttrTest`
Expected: failure — `PREVIOUS_NAME` undefined, or the loader rejects the unregistered attr.

- [ ] **Step 3: Register the attribute**

Add the constant beside the other DB attrs in `CoreDBMetaDataProvider.java`:

```java
    /** Rename hint: the prior name of this object/field, so migration emits RENAME (not drop+add). */
    public static final String PREVIOUS_NAME = "previousName";
```

In `registerDatabaseAttributes(...)`, add `.optionalAttribute(PREVIOUS_NAME, StringAttribute.SUBTYPE_STRING)` to the `MetaObject.SUBTYPE_BASE`, `PojoMetaObject.SUBTYPE_POJO`, and `MetaField.SUBTYPE_BASE` chains (it inherits to concrete subtypes).

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=PreviousNameAttrTest`
Expected: `Tests run: 1, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/database/CoreDBMetaDataProvider.java \
        server/java/metadata/src/test/java/com/metaobjects/database/PreviousNameAttrTest.java \
        server/java/metadata/src/test/resources/meta.rename.json
git commit -m "feat(metadata): register @previousName rename hint on objects + fields (FR-003 migration)"
```

---

## Phase B — Canonical migration model (1:1 port of `migrate-ts`)

All new types live in `server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/`.

### Task B1: `SqlType` — canonical dialect-neutral type + `isWidening`

Ports `migrate-ts/src/sql-type.ts`. Records give structural `equals` for free, so `equals` **is** `sqlTypeEquals`.

**Files:**
- Create: `.../migrate/SqlType.java`
- Test: `.../migrate/SqlTypeTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.manager.db.migrate;

import org.junit.Test;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SqlType.*;

public class SqlTypeTest {
    @Test public void record_equality_is_structural_sqlTypeEquals() {
        assertEquals(new Text(120), new Text(120));
        assertNotEquals(new Text(120), new Text(80));
        assertEquals(new Int(64), new Int(64));
        assertNotEquals(new Int(32), new Int(64));
    }
    @Test public void widening_varchar_longer_is_widening() {
        assertTrue(SqlType.isWidening(new Text(120), new Text(400)));
        assertTrue(SqlType.isWidening(new Text(120), new Text(null))); // bounded -> unbounded
        assertFalse(SqlType.isWidening(new Text(400), new Text(120))); // narrowing
        assertFalse(SqlType.isWidening(new Text(null), new Text(120))); // unbounded -> bounded lossy
    }
    @Test public void widening_int_more_bits_is_widening() {
        assertTrue(SqlType.isWidening(new Int(32), new Int(64)));
        assertFalse(SqlType.isWidening(new Int(64), new Int(32)));
    }
    @Test public void cross_kind_and_identical_are_not_widening() {
        assertFalse(SqlType.isWidening(new Int(32), new Text(120))); // cross-kind: lossy
        assertFalse(SqlType.isWidening(new Text(120), new Text(120))); // identical
    }
}
```

- [ ] **Step 2: Run, verify fails** (`SqlType` missing)

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SqlTypeTest`
Expected: compile failure.

- [ ] **Step 3: Implement `SqlType`** (mirror the TS kinds; `Int` not `Integer` to avoid shadowing `java.lang.Integer`)

```java
package com.metaobjects.manager.db.migrate;

/**
 * Canonical, dialect-neutral SQL type — the cross-language spine (port of migrate-ts SqlType).
 * Both the expected-snapshot builder (metadata→type) and the introspector (db→type) produce this;
 * the differ compares canonical-to-canonical (record equals == sqlTypeEquals); emit re-renders to dialect SQL.
 */
public sealed interface SqlType
        permits SqlType.Text, SqlType.Int, SqlType.Real, SqlType.Numeric, SqlType.Bool,
                SqlType.Timestamp, SqlType.Date, SqlType.Json, SqlType.Blob, SqlType.Uuid {

    /** maxLength == null means unbounded (TEXT). */
    record Text(Integer maxLength) implements SqlType {}
    record Int(int bits) implements SqlType {}              // 32 | 64
    record Real() implements SqlType {}
    record Numeric(Integer precision, Integer scale) implements SqlType {}
    record Bool() implements SqlType {}
    record Timestamp(boolean withTimezone) implements SqlType {}
    record Date() implements SqlType {}
    record Json() implements SqlType {}
    record Blob() implements SqlType {}
    record Uuid() implements SqlType {}

    /** Provably non-lossy type change (port of migrate-ts isWidening). Conservative on purpose. */
    static boolean isWidening(SqlType from, SqlType to) {
        if (from.equals(to)) return false;
        if (from.getClass() != to.getClass()) return false;        // cross-kind: lossy
        if (from instanceof Text f && to instanceof Text t) {
            if (f.maxLength() == null) return false;               // unbounded -> bounded: lossy
            if (t.maxLength() == null) return true;                // bounded -> unbounded: widening
            return t.maxLength() >= f.maxLength();
        }
        if (from instanceof Int f && to instanceof Int t) {
            return t.bits() >= f.bits();
        }
        if (from instanceof Numeric f && to instanceof Numeric t) {
            int fp = f.precision() == null ? 0 : f.precision();
            int fs = f.scale() == null ? 0 : f.scale();
            int tp = t.precision() == null ? 0 : t.precision();
            int ts = t.scale() == null ? 0 : t.scale();
            return tp >= fp && ts == fs && (tp - ts) >= (fp - fs);
        }
        return false; // real/bool/date/json/blob/uuid/timestamp: same-kind difference is not widening
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SqlTypeTest`
Expected: `Tests run: 4, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/SqlType.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/SqlTypeTest.java
git commit -m "feat(omdb): canonical dialect-neutral SqlType + isWidening (port of migrate-ts)"
```

### Task B2: Snapshot descriptors — symmetric `SchemaSnapshot`

Ports the `migrate-ts` descriptors. Plain immutable records; same shape for expected and actual.

**Files:**
- Create: `.../migrate/SchemaSnapshot.java` (holds the nested descriptor records)
- Test: `.../migrate/SchemaSnapshotTest.java`

- [ ] **Step 1: Write the failing test** (construction + case-insensitive table lookup helper)

```java
package com.metaobjects.manager.db.migrate;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class SchemaSnapshotTest {
    @Test public void holds_tables_and_resolves_by_identity() {
        ColumnDescriptor id = new ColumnDescriptor("id", new SqlType.Int(64), false, null);
        TableDescriptor program = new TableDescriptor("program", null, List.of(id),
            List.of(), List.of(), List.of("id"));
        SchemaSnapshot snap = new SchemaSnapshot(List.of(program), List.of());
        assertEquals(1, snap.tables().size());
        assertEquals("program", snap.tables().get(0).name());
        assertFalse(program.columns().isEmpty());
    }
}
```

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SchemaSnapshotTest`
Expected: compile failure.

- [ ] **Step 3: Implement the descriptors** (port of `migrate-ts/src/types.ts` snapshot half)

```java
package com.metaobjects.manager.db.migrate;

import java.util.List;

/** A snapshot of a schema — same shape for expected (metadata) and actual (introspection). */
public record SchemaSnapshot(List<TableDescriptor> tables, List<ViewDescriptor> views) {

    /** schema == null means the dialect default (Postgres "public"; SQLite/Derby have no schema concept). */
    public record TableDescriptor(
            String name, String schema,
            List<ColumnDescriptor> columns,
            List<IndexDescriptor> indexes,
            List<FkDescriptor> foreignKeys,
            List<String> primaryKey) {}

    /** identity: "increment" | "uuid" | null. default is informational in v1 (see Change kinds deferred). */
    public record ColumnDescriptor(String name, SqlType sqlType, boolean nullable, String identity) {}

    public record IndexDescriptor(String name, List<String> columns, boolean unique) {}

    public record FkDescriptor(String name, List<String> columns, String refTable,
                               List<String> refColumns, String onDelete, String onUpdate) {}

    public record ViewDescriptor(String name, String schema, String sql) {}
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SchemaSnapshotTest`
Expected: `Tests run: 1, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/SchemaSnapshot.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/SchemaSnapshotTest.java
git commit -m "feat(omdb): symmetric SchemaSnapshot descriptors (port of migrate-ts)"
```

### Task B3: `Change` union + `ChangeStatus` + `AllowOptions` + `applyStatus` + `BlockedChangesError`

Ports `migrate-ts/src/types.ts` (Change half), `diff/status.ts`, and `errors.ts`. Records are immutable, so `withStatus` returns a copy.

**Files:**
- Create: `.../migrate/Change.java` (sealed union + `ChangeStatus` + `ChangeKind` constants)
- Create: `.../migrate/AllowOptions.java`
- Create: `.../migrate/DiffResult.java`
- Create: `.../migrate/ChangeStatusRules.java` (`applyStatus`)
- Create: `.../migrate/BlockedChangesError.java`
- Test: `.../migrate/ChangeStatusRulesTest.java`

- [ ] **Step 1: Write the failing test** (the status rules — the conformance-relevant policy)

```java
package com.metaobjects.manager.db.migrate;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class ChangeStatusRulesTest {
    private ColumnDescriptor col(String n, SqlType t) { return new ColumnDescriptor(n, t, true, null); }

    @Test public void drop_column_blocked_unless_allowed() {
        List<Change> cs = new ArrayList<>(List.of(new Change.DropColumn("program", null, "legacy")));
        ChangeStatusRules.applyStatus(cs, new AllowOptions());
        assertEquals("blocked", cs.get(0).status().state());

        List<Change> cs2 = new ArrayList<>(List.of(new Change.DropColumn("program", null, "legacy")));
        ChangeStatusRules.applyStatus(cs2, AllowOptions.builder().dropColumn(true).build());
        assertEquals("allowed", cs2.get(0).status().state());
    }

    @Test public void widening_type_always_allowed_narrowing_blocked() {
        List<Change> widen = new ArrayList<>(List.of(
            new Change.ChangeColumnType("program", null, "title", new SqlType.Text(120), new SqlType.Text(400))));
        ChangeStatusRules.applyStatus(widen, new AllowOptions());
        assertEquals("allowed", widen.get(0).status().state());

        List<Change> narrow = new ArrayList<>(List.of(
            new Change.ChangeColumnType("program", null, "title", new SqlType.Text(400), new SqlType.Text(120))));
        ChangeStatusRules.applyStatus(narrow, new AllowOptions());
        assertEquals("blocked", narrow.get(0).status().state());
    }

    @Test public void additive_kinds_allowed() {
        List<Change> cs = new ArrayList<>(List.of(
            new Change.AddColumn("program", null, col("title", new SqlType.Text(120))),
            new Change.RenameColumn("program", null, "name", "title")));
        ChangeStatusRules.applyStatus(cs, new AllowOptions());
        assertTrue(cs.stream().allMatch(c -> "allowed".equals(c.status().state())));
    }
}
```

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=ChangeStatusRulesTest`
Expected: compile failure.

- [ ] **Step 3: Implement `ChangeStatus` + `Change`** (sealed; mirror the TS union; `withStatus` copies)

`Change.java`:

```java
package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

/**
 * One schema-converging operation (port of migrate-ts Change union). Every change carries a
 * ChangeStatus (set by ChangeStatusRules.applyStatus). v1 produces a subset; the rest are
 * declared for cross-language shape parity (see plan scope). schema == null => dialect default.
 */
public sealed interface Change {
    String kind();
    ChangeStatus status();
    Change withStatus(ChangeStatus s);

    /** Stable order key — renames first, then create/alter, then destructive (deterministic emit). */
    String sortKey();

    // --- produced in v1 ---
    record CreateTable(TableDescriptor table, ChangeStatus status) implements Change {
        public CreateTable(TableDescriptor t) { this(t, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.CREATE_TABLE; }
        public Change withStatus(ChangeStatus s) { return new CreateTable(table, s); }
        public String sortKey() { return "1:" + table.name() + ":"; }
    }
    record AddColumn(String table, String schema, ColumnDescriptor column, ChangeStatus status) implements Change {
        public AddColumn(String t, String sc, ColumnDescriptor c) { this(t, sc, c, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.ADD_COLUMN; }
        public Change withStatus(ChangeStatus s) { return new AddColumn(table, schema, column, s); }
        public String sortKey() { return "2:" + table + ":" + column.name(); }
    }
    record ChangeColumnType(String table, String schema, String column, SqlType from, SqlType to,
                            ChangeStatus status) implements Change {
        public ChangeColumnType(String t, String sc, String col, SqlType f, SqlType to) { this(t, sc, col, f, to, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.CHANGE_COLUMN_TYPE; }
        public Change withStatus(ChangeStatus s) { return new ChangeColumnType(table, schema, column, from, to, s); }
        public String sortKey() { return "3:" + table + ":" + column; }
    }
    record RenameTable(String from, String to, String schema, ChangeStatus status) implements Change {
        public RenameTable(String f, String t, String sc) { this(f, t, sc, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.RENAME_TABLE; }
        public Change withStatus(ChangeStatus s) { return new RenameTable(from, to, schema, s); }
        public String sortKey() { return "0:" + to + ":"; }
    }
    record RenameColumn(String table, String schema, String from, String to, ChangeStatus status) implements Change {
        public RenameColumn(String t, String sc, String f, String to) { this(t, sc, f, to, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.RENAME_COLUMN; }
        public Change withStatus(ChangeStatus s) { return new RenameColumn(table, schema, from, to, s); }
        public String sortKey() { return "0:" + table + ":" + to; }
    }
    record AddIndex(String table, String schema, IndexDescriptor index, ChangeStatus status) implements Change {
        public AddIndex(String t, String sc, IndexDescriptor i) { this(t, sc, i, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.ADD_INDEX; }
        public Change withStatus(ChangeStatus s) { return new AddIndex(table, schema, index, s); }
        public String sortKey() { return "4:" + table + ":" + index.name(); }
    }
    record DropIndex(String table, String schema, String index, ChangeStatus status) implements Change {
        public DropIndex(String t, String sc, String i) { this(t, sc, i, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.DROP_INDEX; }
        public Change withStatus(ChangeStatus s) { return new DropIndex(table, schema, index, s); }
        public String sortKey() { return "4:" + table + ":" + index; }
    }
    record AddFk(String table, String schema, FkDescriptor fk, ChangeStatus status) implements Change {
        public AddFk(String t, String sc, FkDescriptor f) { this(t, sc, f, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.ADD_FK; }
        public Change withStatus(ChangeStatus s) { return new AddFk(table, schema, fk, s); }
        public String sortKey() { return "5:" + table + ":" + fk.name(); }
    }
    record DropFk(String table, String schema, String fk, ChangeStatus status) implements Change {
        public DropFk(String t, String sc, String f) { this(t, sc, f, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.DROP_FK; }
        public Change withStatus(ChangeStatus s) { return new DropFk(table, schema, fk, s); }
        public String sortKey() { return "5:" + table + ":" + fk; }
    }
    record DropColumn(String table, String schema, String column, ChangeStatus status) implements Change {
        public DropColumn(String t, String sc, String col) { this(t, sc, col, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.DROP_COLUMN; }
        public Change withStatus(ChangeStatus s) { return new DropColumn(table, schema, column, s); }
        public String sortKey() { return "8:" + table + ":" + column; }
    }
    record DropTable(String table, String schema, ChangeStatus status) implements Change {
        public DropTable(String t, String sc) { this(t, sc, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.DROP_TABLE; }
        public Change withStatus(ChangeStatus s) { return new DropTable(table, schema, s); }
        public String sortKey() { return "9:" + table + ":"; }
    }
    record CreateView(ViewDescriptor view, ChangeStatus status) implements Change {
        public CreateView(ViewDescriptor v) { this(v, ChangeStatus.ALLOWED); }
        public String kind() { return ChangeKind.CREATE_VIEW; }
        public Change withStatus(ChangeStatus s) { return new CreateView(view, s); }
        public String sortKey() { return "6:" + view.name() + ":"; }
    }

    /** Named constants for change kinds (cross-language vocabulary; never inline these strings). */
    final class ChangeKind {
        private ChangeKind() {}
        public static final String CREATE_TABLE = "create-table";
        public static final String DROP_TABLE = "drop-table";
        public static final String RENAME_TABLE = "rename-table";
        public static final String ADD_COLUMN = "add-column";
        public static final String DROP_COLUMN = "drop-column";
        public static final String RENAME_COLUMN = "rename-column";
        public static final String CHANGE_COLUMN_TYPE = "change-column-type";
        public static final String ADD_INDEX = "add-index";
        public static final String DROP_INDEX = "drop-index";
        public static final String ADD_FK = "add-fk";
        public static final String DROP_FK = "drop-fk";
        public static final String CREATE_VIEW = "create-view";
        // declared for parity, not produced in v1: change-column-nullable, change-column-default,
        // drop-view, replace-view
    }

    /** allowed | blocked (+ reason). Port of migrate-ts ChangeStatus. */
    record ChangeStatus(String state, String blockedReason) {
        public static final ChangeStatus ALLOWED = new ChangeStatus("allowed", null);
        public static ChangeStatus blocked(String reason) { return new ChangeStatus("blocked", reason); }
    }
}
```

- [ ] **Step 4: Implement `AllowOptions`, `DiffResult`, `BlockedChangesError`, `ChangeStatusRules`**

`AllowOptions.java` (port of TS `AllowOptions`; builder for ergonomic test/mojo use):

```java
package com.metaobjects.manager.db.migrate;

/** Explicit destructive-change opt-in (port of migrate-ts AllowOptions). */
public record AllowOptions(boolean dropColumn, boolean dropTable, boolean typeChange,
                           boolean dropIndex, boolean dropFk, boolean nullableToNotNull) {
    public AllowOptions() { this(false, false, false, false, false, false); }
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private boolean dc, dt, tc, di, df, n2n;
        public Builder dropColumn(boolean v) { dc = v; return this; }
        public Builder dropTable(boolean v) { dt = v; return this; }
        public Builder typeChange(boolean v) { tc = v; return this; }
        public Builder dropIndex(boolean v) { di = v; return this; }
        public Builder dropFk(boolean v) { df = v; return this; }
        public Builder nullableToNotNull(boolean v) { n2n = v; return this; }
        public AllowOptions build() { return new AllowOptions(dc, dt, tc, di, df, n2n); }
    }
}
```

`DiffResult.java`:

```java
package com.metaobjects.manager.db.migrate;

import java.util.List;

/** Port of migrate-ts DiffResult. `blocked` is the subset of `changes` with blocked status. */
public record DiffResult(List<Change> changes, List<Change> blocked) {
    public boolean isEmpty() { return changes.isEmpty(); }
}
```

`BlockedChangesError.java` (port of `errors.ts`):

```java
package com.metaobjects.manager.db.migrate;

import java.util.List;
import java.util.Map;

/** Thrown by emit/apply when blocked (destructive) changes would be written. */
public class BlockedChangesError extends RuntimeException {
    private static final Map<String, String> ENABLE_FLAG = Map.of(
        Change.ChangeKind.DROP_COLUMN, "allow.dropColumn",
        Change.ChangeKind.DROP_TABLE, "allow.dropTable",
        Change.ChangeKind.CHANGE_COLUMN_TYPE, "allow.typeChange",
        Change.ChangeKind.DROP_INDEX, "allow.dropIndex",
        Change.ChangeKind.DROP_FK, "allow.dropFk");

    private final transient List<Change> blocked;

    public BlockedChangesError(List<Change> blocked) {
        super(buildMessage(blocked));
        this.blocked = blocked;
    }
    public List<Change> getBlocked() { return blocked; }

    private static String buildMessage(List<Change> blocked) {
        StringBuilder sb = new StringBuilder(blocked.size() + " blocked change(s):");
        for (Change c : blocked) {
            String key = c.sortKey();
            String locator = key.substring(key.indexOf(':') + 1);   // drop the phase prefix -> "table:detail"
            sb.append("\n  - ").append(c.kind()).append(" on ").append(locator)
              .append(": pass ").append(ENABLE_FLAG.getOrDefault(c.kind(), "(no flag enables this)"));
        }
        return sb.toString();
    }
}
```

`ChangeStatusRules.java` (port of `diff/status.ts`):

```java
package com.metaobjects.manager.db.migrate;

import java.util.List;

/** Computes each Change's status against AllowOptions (port of migrate-ts applyStatus). */
public final class ChangeStatusRules {
    private ChangeStatusRules() {}

    /** Replaces each change in-place with a status-stamped copy. */
    public static void applyStatus(List<Change> changes, AllowOptions allow) {
        for (int i = 0; i < changes.size(); i++) {
            Change c = changes.get(i);
            String reason = blockedReasonFor(c, allow);
            changes.set(i, c.withStatus(reason == null
                ? Change.ChangeStatus.ALLOWED : Change.ChangeStatus.blocked(reason)));
        }
    }

    private static String blockedReasonFor(Change c, AllowOptions allow) {
        if (c instanceof Change.DropColumn) {
            return allow.dropColumn() ? null : "destructive: drop-column not allowed (pass allow.dropColumn)";
        }
        if (c instanceof Change.DropTable) {
            return allow.dropTable() ? null : "destructive: drop-table not allowed (pass allow.dropTable)";
        }
        if (c instanceof Change.DropIndex) {
            return allow.dropIndex() ? null : "destructive: drop-index not allowed (pass allow.dropIndex)";
        }
        if (c instanceof Change.DropFk) {
            return allow.dropFk() ? null : "destructive: drop-fk not allowed (pass allow.dropFk)";
        }
        if (c instanceof Change.ChangeColumnType ct) {
            if (SqlType.isWidening(ct.from(), ct.to())) return null;       // widening always allowed
            return allow.typeChange() ? null : "lossy type change (pass allow.typeChange)";
        }
        return null; // create-table/add-column/rename-*/add-index/add-fk/create-view: always allowed
    }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=ChangeStatusRulesTest`
Expected: `Tests run: 3, Failures: 0, Errors: 0`.

- [ ] **Step 6: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/Change.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/AllowOptions.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/DiffResult.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/BlockedChangesError.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/ChangeStatusRules.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/ChangeStatusRulesTest.java
git commit -m "feat(omdb): Change union + ChangeStatus + AllowOptions + applyStatus + BlockedChangesError (port of migrate-ts)"
```

---

## Phase C — Snapshot builders (expected + actual, both → `SchemaSnapshot`)

### Task C1: `ExpectedSchemaBuilder` — metadata → `SchemaSnapshot` (the shared collector) + `RenameHints`

Reuses the `MappingHandler` defs (the validator's derivation, **not** re-derived) and `SimpleMappingHandlerDB.getSQLType` (the canonical field→type mapper), converting to the canonical `SqlType`. Also harvests `@previousName` into `RenameHints`. This `ExpectedSchemaBuilder` is the shared "collect desired schema" helper FR-003 §4 implies (the boot-time validator can adopt it in a later cleanup).

**Files:**
- Create: `.../migrate/RenameHints.java`
- Create: `.../migrate/JdbcSqlTypes.java` (`java.sql.Types` ↔ canonical `SqlType`)
- Create: `.../migrate/ExpectedSchemaBuilder.java`
- Test: `.../migrate/ExpectedSchemaBuilderTest.java` (+ reuse `meta.migrate.json` from F1, or a small fixture)

- [ ] **Step 1: Write the failing test** (Derby-loaded metadata → expected snapshot; follow the JsonbFieldDBTest loader setup)

```java
// ExpectedSchemaBuilderTest.java — load a metadata fixture (a Program entity mapped to table "program"
// with id:BIGINT pk + title:VARCHAR(120), and @previousName on a field). Build the ObjectManagerDB +
// MappingHandler exactly as JsonbFieldDBTest does (no DB needed beyond the loader/manager).
// Assert:
//   SchemaSnapshot snap = new ExpectedSchemaBuilder(manager, registry).build(hints);
//   TableDescriptor program = snap by name "program";
//   - program.columns() contains id (SqlType.Int(64), pk in primaryKey list) and title (SqlType.Text(50))
//   - hints.previousColumn("program","title") == "name"   (from @previousName)
//   NOTE: SimpleMappingHandlerDB.getSQLLength() currently returns a FIXED 50 for STRING and does NOT yet
//   read @dbLength (there is a literal TODO in that method). So the expected length is 50, regardless of
//   any declared @dbLength. This is internally consistent for the round-trip (apply creates VARCHAR(50),
//   introspect reads 50, clean re-diff) — assert Text(50). Honoring @dbLength in getSQLLength is a separate
//   follow-up (it also feeds the boot-time validator path); out of scope here.
```

Write the full test against the Plan-2 harness; the assertions above are the contract.

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=ExpectedSchemaBuilderTest`
Expected: compile failure.

- [ ] **Step 3: Implement `RenameHints`** (current name → previous name, keyed by table)

```java
package com.metaobjects.manager.db.migrate;

import java.util.*;

/** Rename hints harvested from @previousName (Java v1's rename mechanism). */
public final class RenameHints {
    private final Map<String, String> tableRenames = new HashMap<>();
    private final Map<String, Map<String, String>> columnRenames = new HashMap<>();
    public static RenameHints empty() { return new RenameHints(); }
    public void addTableRename(String currentTable, String prev) { tableRenames.put(currentTable.toLowerCase(), prev); }
    public void addColumnRename(String table, String currentCol, String prev) {
        columnRenames.computeIfAbsent(table.toLowerCase(), k -> new HashMap<>()).put(currentCol.toLowerCase(), prev);
    }
    public String previousTable(String currentTable) { return tableRenames.get(currentTable.toLowerCase()); }
    public String previousColumn(String table, String currentCol) {
        Map<String, String> m = columnRenames.get(table.toLowerCase());
        return m == null ? null : m.get(currentCol.toLowerCase());
    }
}
```

- [ ] **Step 4: Implement `JdbcSqlTypes`** (the one place `java.sql.Types` ↔ canonical `SqlType` live)

```java
package com.metaobjects.manager.db.migrate;

import java.sql.Types;

/** Single source of truth for java.sql.Types <-> canonical SqlType (used by both snapshot builders). */
public final class JdbcSqlTypes {
    private JdbcSqlTypes() {}

    /** java.sql.Types (+ length) -> canonical SqlType. */
    public static SqlType fromJdbc(int jdbcType, int length) {
        switch (jdbcType) {
            case Types.BOOLEAN: case Types.BIT: return new SqlType.Bool();
            case Types.TINYINT: case Types.SMALLINT: case Types.INTEGER: return new SqlType.Int(32);
            case Types.BIGINT: return new SqlType.Int(64);
            case Types.FLOAT: case Types.REAL: case Types.DOUBLE: return new SqlType.Real();
            case Types.NUMERIC: case Types.DECIMAL: return new SqlType.Numeric(null, null);
            case Types.TIMESTAMP: case Types.TIMESTAMP_WITH_TIMEZONE: return new SqlType.Timestamp(true);
            case Types.DATE: return new SqlType.Date();
            case Types.BLOB: case Types.VARBINARY: case Types.LONGVARBINARY: return new SqlType.Blob();
            case Types.VARCHAR: case Types.CHAR: case Types.LONGVARCHAR: case Types.CLOB:
                return new SqlType.Text(length > 0 ? length : null);
            default:
                return new SqlType.Text(length > 0 ? length : null); // conservative fallback
        }
    }
}
```

- [ ] **Step 5: Implement `ExpectedSchemaBuilder`** (reuse the validator derivation + `getSQLType`)

```java
package com.metaobjects.manager.db.migrate;

import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.*;
import com.metaobjects.manager.db.defs.*;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.*;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.util.MetaDataUtil;

import java.util.*;

/**
 * Builds the EXPECTED SchemaSnapshot from metadata, reusing the same MappingHandler-derived
 * TableDef/ViewDef the boot-time validator uses (no re-derivation) and the canonical field->type
 * mapping in SimpleMappingHandlerDB (converted to SqlType). Also harvests @previousName -> RenameHints.
 */
public final class ExpectedSchemaBuilder {
    private final ObjectManagerDB manager;
    private final MetaDataLoaderRegistry loaderRegistry;

    public ExpectedSchemaBuilder(ObjectManagerDB manager, MetaDataLoaderRegistry loaderRegistry) {
        this.manager = manager;
        this.loaderRegistry = loaderRegistry;
    }

    /** Build the snapshot; fills `hints` as a side effect (pass RenameHints.empty() if unused). */
    public SchemaSnapshot build(RenameHints hints) {
        MappingHandler mh = manager.getMappingHandler();
        Map<String, TableDescriptor> tables = new LinkedHashMap<>();
        Map<String, ViewDescriptor> views = new LinkedHashMap<>();

        for (MetaDataLoader loader : loaders()) {
            for (MetaObject mc : loader.getMetaObjects()) {
                BaseDef create = defOf(mh.getCreateMapping(mc));
                if (create instanceof TableDef t) {
                    tables.putIfAbsent(t.getNameDef().getFullname(), tableDescriptor(t, mc));
                }
                BaseDef read = defOf(mh.getReadMapping(mc));
                if (read instanceof ViewDef v) {
                    views.putIfAbsent(v.getNameDef().getFullname(),
                        new ViewDescriptor(v.getNameDef().getName(), v.getNameDef().getSchema(), v.getSQL()));
                }
                harvestRenameHints(mc, hints);
            }
        }
        return new SchemaSnapshot(new ArrayList<>(tables.values()), new ArrayList<>(views.values()));
    }

    private TableDescriptor tableDescriptor(TableDef t, MetaObject mc) {
        List<ColumnDescriptor> cols = new ArrayList<>();
        List<String> pk = new ArrayList<>();
        for (ColumnDef cd : t.getColumns()) {
            if (cd.getName() == null) continue;
            MetaField mf = fieldForColumn(mc, cd.getName());
            SqlType sqlType = JdbcSqlTypes.fromJdbc(cd.getSQLType(), cd.getLength());
            boolean nullable = mf == null || readNullable(mf);          // default nullable unless @dbNullable=false
            // identity sourced from primary @generation (v1: informational, always null here)
            cols.add(new ColumnDescriptor(cd.getName(), sqlType, nullable, null));
            if (cd.isPrimaryKey()) pk.add(cd.getName());
        }
        return new TableDescriptor(t.getNameDef().getName(), t.getNameDef().getSchema(),
            cols, List.of(), List.of(), pk);   // indexes/FKs descriptors: v1 sources them from TableDef in a follow-up; empty here keeps create-table additive
    }

    private boolean readNullable(MetaField mf) {
        if (!mf.hasMetaAttr(CoreDBMetaDataProvider.DB_NULLABLE)) return true;
        return !"false".equals(mf.getMetaAttr(CoreDBMetaDataProvider.DB_NULLABLE).getValueAsString());
    }

    private MetaField fieldForColumn(MetaObject mc, String column) {
        for (MetaField mf : mc.getMetaFields()) {
            String col = mf.hasMetaAttr(CoreDBMetaDataProvider.DB_COLUMN)
                ? mf.getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN).getValueAsString() : mf.getName();
            if (column.equalsIgnoreCase(col)) return mf;
        }
        return null;
    }

    private void harvestRenameHints(MetaObject mc, RenameHints hints) {
        String table = mc.hasMetaAttr(CoreDBMetaDataProvider.DB_TABLE)
            ? mc.getMetaAttr(CoreDBMetaDataProvider.DB_TABLE).getValueAsString() : null;
        if (table == null) return;
        if (mc.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME)) {
            hints.addTableRename(table, mc.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
        }
        for (MetaField mf : mc.getMetaFields()) {
            if (mf.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME)) {
                String col = mf.hasMetaAttr(CoreDBMetaDataProvider.DB_COLUMN)
                    ? mf.getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN).getValueAsString() : mf.getName();
                hints.addColumnRename(table, col, mf.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
            }
        }
    }

    private BaseDef defOf(ObjectMapping m) {
        return (m instanceof ObjectMappingDB db) ? db.getDBDef() : null;
    }
    private Collection<MetaDataLoader> loaders() {
        return loaderRegistry != null ? loaderRegistry.getDataLoaders() : MetaDataUtil.getAllMetaDataLoaders(this);
    }
}
```

(`ColumnDef.getSQLType()`/`getLength()` are public and already carry the mapped `java.sql.Types` + length — confirmed: `SimpleMappingHandlerDB.getSQLType`/`getSQLLength` are `protected` and **not** callable from this package, so the derived def is the right source and no cast is needed. Confirm `MetaObject.getMetaFields()` is the accessor name at the seam.)

- [ ] **Step 6: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=ExpectedSchemaBuilderTest`
Expected: assertions pass (program table with id/title canonical types; rename hint present).

- [ ] **Step 7: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/RenameHints.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/JdbcSqlTypes.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/ExpectedSchemaBuilder.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/ExpectedSchemaBuilderTest.java
git commit -m "feat(omdb): ExpectedSchemaBuilder (metadata->SchemaSnapshot, reuses MappingHandler defs + getSQLType) + RenameHints"
```

### Task C2: `SchemaIntrospector` — live DB → `SchemaSnapshot`

Reuses the `DatabaseMetaData` technique from `GenericSQLDriver.checkBaseTable()`, mapping JDBC types to canonical `SqlType` via `JdbcSqlTypes`.

**Files:**
- Create: `.../migrate/SchemaIntrospector.java`
- Test: `.../migrate/SchemaIntrospectorTest.java`

- [ ] **Step 1: Write the failing test (Derby in-memory)**

```java
package com.metaobjects.manager.db.migrate;

import org.junit.*;
import java.sql.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class SchemaIntrospectorTest {
    private static String dbFile;
    private static Connection conn() throws SQLException {
        return DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";create=true");
    }
    @BeforeClass public static void setup() throws Exception {
        Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
        dbFile = "introspect-" + System.currentTimeMillis();
        try (Connection c = conn(); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE PROGRAM (ID BIGINT NOT NULL PRIMARY KEY, TITLE VARCHAR(120))");
        }
    }
    @AfterClass public static void teardown() throws Exception {
        try { DriverManager.getConnection("jdbc:derby:memory:" + dbFile + ";drop=true"); } catch (SQLException ignored) {}
    }

    private TableDescriptor table(SchemaSnapshot s, String name) {
        return s.tables().stream().filter(t -> t.name().equalsIgnoreCase(name)).findFirst().orElse(null);
    }
    private ColumnDescriptor col(TableDescriptor t, String name) {
        return t.columns().stream().filter(c -> c.name().equalsIgnoreCase(name)).findFirst().orElse(null);
    }

    @Test public void reads_table_columns_as_canonical_types() throws Exception {
        try (Connection c = conn()) {
            SchemaSnapshot live = new SchemaIntrospector().introspect(c, null);
            TableDescriptor program = table(live, "PROGRAM");
            assertNotNull(program);
            assertEquals(new SqlType.Int(64), col(program, "ID").sqlType());
            assertEquals(new SqlType.Text(120), col(program, "TITLE").sqlType());
        }
    }
    @Test public void missing_table_absent() throws Exception {
        try (Connection c = conn()) { assertNull(table(new SchemaIntrospector().introspect(c, null), "NOPE")); }
    }
}
```

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SchemaIntrospectorTest`
Expected: compile failure.

- [ ] **Step 3: Implement `SchemaIntrospector`**

```java
package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.migrate.SchemaSnapshot.*;
import java.sql.*;
import java.util.*;

/** Reads the live schema via DatabaseMetaData into a SchemaSnapshot (actual side of the diff). */
public final class SchemaIntrospector {

    /** @param schema DB schema to scan (null = the connection's default). */
    public SchemaSnapshot introspect(Connection c, String schema) throws SQLException {
        DatabaseMetaData md = c.getMetaData();
        List<TableDescriptor> tables = new ArrayList<>();
        try (ResultSet ts = md.getTables(null, schema, "%", new String[]{"TABLE"})) {
            while (ts.next()) {
                String name = ts.getString("TABLE_NAME");
                List<ColumnDescriptor> cols = new ArrayList<>();
                try (ResultSet cs = md.getColumns(null, schema, name, "%")) {
                    while (cs.next()) {
                        SqlType type = JdbcSqlTypes.fromJdbc(cs.getInt("DATA_TYPE"), cs.getInt("COLUMN_SIZE"));
                        boolean nullable = "YES".equalsIgnoreCase(cs.getString("IS_NULLABLE"));
                        cols.add(new ColumnDescriptor(cs.getString("COLUMN_NAME"), type, nullable, null));
                    }
                }
                List<String> pk = new ArrayList<>();
                try (ResultSet ks = md.getPrimaryKeys(null, schema, name)) {
                    while (ks.next()) pk.add(ks.getString("COLUMN_NAME"));
                }
                tables.add(new TableDescriptor(name, schema, cols, List.of(), List.of(), pk));
            }
        }
        return new SchemaSnapshot(tables, List.of());
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SchemaIntrospectorTest`
Expected: `Tests run: 2, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/SchemaIntrospector.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/SchemaIntrospectorTest.java
git commit -m "feat(omdb): SchemaIntrospector reads live DB into a canonical SchemaSnapshot"
```

---

## Phase D — The differ

### Task D1: `SchemaDiffer.diff(expected, actual, allow, hints)` → `DiffResult`

Ports `migrate-ts/src/diff/index.ts` passes, plus the Java v1 rename mechanism: a `@previousName` hint converts a would-be drop+add into a `RenameTable`/`RenameColumn` (Java's deterministic stand-in for the TS heuristic). Determinism via `sortKey`.

**Files:**
- Create: `.../migrate/SchemaDiffer.java`
- Test: `.../migrate/SchemaDifferTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.manager.db.migrate;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class SchemaDifferTest {
    private final SchemaDiffer differ = new SchemaDiffer();

    private ColumnDescriptor c(String n, SqlType t) { return new ColumnDescriptor(n, t, true, null); }
    private TableDescriptor program(ColumnDescriptor... cols) {
        return new TableDescriptor("program", null, List.of(cols), List.of(), List.of(), List.of("id"));
    }
    private SchemaSnapshot snap(TableDescriptor... t) { return new SchemaSnapshot(List.of(t), List.of()); }

    @Test public void missing_table_create_table() {
        DiffResult r = differ.diff(snap(program(c("id", new SqlType.Int(64)))), snap(), new AllowOptions(), RenameHints.empty());
        assertEquals(1, r.changes().size());
        assertTrue(r.changes().get(0) instanceof Change.CreateTable);
    }
    @Test public void missing_column_add_column() {
        SchemaSnapshot exp = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(120))));
        SchemaSnapshot act = snap(program(c("id", new SqlType.Int(64))));
        DiffResult r = differ.diff(exp, act, new AllowOptions(), RenameHints.empty());
        assertEquals(1, r.changes().size());
        assertEquals("title", ((Change.AddColumn) r.changes().get(0)).column().name());
    }
    @Test public void longer_varchar_change_column_type_allowed() {
        SchemaSnapshot exp = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(400))));
        SchemaSnapshot act = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(120))));
        DiffResult r = differ.diff(exp, act, new AllowOptions(), RenameHints.empty());
        assertEquals(1, r.changes().size());
        assertTrue(r.changes().get(0) instanceof Change.ChangeColumnType);
        assertEquals("allowed", r.changes().get(0).status().state());   // widening
    }
    @Test public void extra_actual_column_drop_blocked_by_default() {
        SchemaSnapshot exp = snap(program(c("id", new SqlType.Int(64))));
        SchemaSnapshot act = snap(program(c("id", new SqlType.Int(64)), c("legacy", new SqlType.Text(50))));
        DiffResult r = differ.diff(exp, act, new AllowOptions(), RenameHints.empty());
        assertEquals(1, r.changes().size());
        assertTrue(r.changes().get(0) instanceof Change.DropColumn);
        assertEquals("blocked", r.changes().get(0).status().state());
        assertEquals(1, r.blocked().size());
    }
    @Test public void previousName_hint_rename_not_drop_plus_add() {
        SchemaSnapshot exp = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(120))));
        SchemaSnapshot act = snap(program(c("id", new SqlType.Int(64)), c("name", new SqlType.Text(120))));
        RenameHints h = new RenameHints(); h.addColumnRename("program", "title", "name");
        DiffResult r = differ.diff(exp, act, new AllowOptions(), h);
        assertEquals(1, r.changes().size());
        Change.RenameColumn rc = (Change.RenameColumn) r.changes().get(0);
        assertEquals("name", rc.from());
        assertEquals("title", rc.to());
    }
    @Test public void identical_empty_diff() {
        SchemaSnapshot s = snap(program(c("id", new SqlType.Int(64)), c("title", new SqlType.Text(120))));
        assertTrue(differ.diff(s, s, new AllowOptions(), RenameHints.empty()).isEmpty());
    }
    @Test public void deterministic_regardless_of_input_order() {
        TableDescriptor a = program(c("id", new SqlType.Int(64)));
        TableDescriptor b = new TableDescriptor("subscriber", null, List.of(c("id", new SqlType.Int(64))),
            List.of(), List.of(), List.of("id"));
        List<String> k1 = keys(differ.diff(new SchemaSnapshot(List.of(a, b), List.of()), snap(), new AllowOptions(), RenameHints.empty()));
        List<String> k2 = keys(differ.diff(new SchemaSnapshot(List.of(b, a), List.of()), snap(), new AllowOptions(), RenameHints.empty()));
        assertEquals(k1, k2);
    }
    private List<String> keys(DiffResult r) { return r.changes().stream().map(Change::sortKey).toList(); }
}
```

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SchemaDifferTest`
Expected: compile failure.

- [ ] **Step 3: Implement `SchemaDiffer`** (ports the TS passes; `@previousName` rename conversion; `applyStatus`)

```java
package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.migrate.SchemaSnapshot.*;
import java.util.*;

/**
 * Compares an EXPECTED snapshot (metadata) against an ACTUAL snapshot (introspection) and produces
 * the deterministic change list to bring actual -> expected (port of migrate-ts diff). The rename
 * mechanism is @previousName hints (Java v1) rather than the TS heuristic. Status is applied last.
 */
public final class SchemaDiffer {

    public DiffResult diff(SchemaSnapshot expected, SchemaSnapshot actual, AllowOptions allow, RenameHints hints) {
        List<Change> changes = new ArrayList<>();
        Map<String, TableDescriptor> exp = byName(expected.tables());
        Map<String, TableDescriptor> act = byName(actual.tables());

        for (TableDescriptor e : expected.tables()) {
            String key = e.name().toLowerCase();
            TableDescriptor a = act.get(key);
            if (a == null) {
                // table rename hint? (old table present, new absent)
                String prev = hints.previousTable(e.name());
                TableDescriptor prevTable = prev == null ? null : act.get(prev.toLowerCase());
                if (prevTable != null) {
                    changes.add(new Change.RenameTable(prevTable.name(), e.name(), e.schema()));
                    diffColumns(e, prevTable, hints, changes);   // then converge columns of the renamed table
                } else {
                    changes.add(new Change.CreateTable(e));      // new table: columns ride with CREATE TABLE
                }
            } else {
                diffColumns(e, a, hints, changes);
            }
        }
        // tables in actual but not expected -> drop-table (blocked by default via status)
        for (TableDescriptor a : actual.tables()) {
            if (!exp.containsKey(a.name().toLowerCase()) && !isRenameTarget(a, expected, hints)) {
                changes.add(new Change.DropTable(a.name(), a.schema()));
            }
        }
        // views: create when absent (origin->SQL derivation is Plan 4; here SQL is whatever the descriptor carries)
        // compared against table names too (a view occupies the namespace)
        Set<String> liveNames = new HashSet<>(act.keySet());
        for (ViewDescriptor v : expected.views()) {
            if (!liveNames.contains(v.name().toLowerCase())) changes.add(new Change.CreateView(v));
        }

        // NB: TS diff() relies on pass-generation order; Java adds an explicit, stable phase-sort
        // (Change.sortKey) for determinism — an intentional Java addition, not a divergence in output meaning.
        // Schema is NOT part of the table-identity key in v1 (all fixtures/Derby use null schema); Postgres
        // multi-schema identity (null<->"public" normalization) lands with the Postgres dialect work.
        changes.sort(Comparator.comparing(Change::sortKey));
        ChangeStatusRules.applyStatus(changes, allow);
        return new DiffResult(changes, changes.stream().filter(c -> "blocked".equals(c.status().state())).toList());
    }

    private void diffColumns(TableDescriptor e, TableDescriptor a, RenameHints hints, List<Change> changes) {
        Map<String, ColumnDescriptor> ecols = byColName(e.columns());
        Map<String, ColumnDescriptor> acols = byColName(a.columns());
        Set<String> consumed = new HashSet<>();

        for (ColumnDescriptor ec : e.columns()) {
            ColumnDescriptor ac = acols.get(ec.name().toLowerCase());
            if (ac == null) {
                String prevCol = hints.previousColumn(e.name(), ec.name());
                ColumnDescriptor prev = prevCol == null ? null : acols.get(prevCol.toLowerCase());
                if (prev != null) {
                    changes.add(new Change.RenameColumn(e.name(), e.schema(), prev.name(), ec.name()));
                    consumed.add(prev.name().toLowerCase());
                } else {
                    changes.add(new Change.AddColumn(e.name(), e.schema(), ec));
                }
                continue;
            }
            consumed.add(ac.name().toLowerCase());
            if (!ec.sqlType().equals(ac.sqlType())) {   // record equals == sqlTypeEquals
                changes.add(new Change.ChangeColumnType(e.name(), e.schema(), ec.name(), ac.sqlType(), ec.sqlType()));
            }
            // change-column-nullable / change-column-default: declared in the union but NOT produced in v1.
        }
        for (ColumnDescriptor ac : a.columns()) {
            if (!ecols.containsKey(ac.name().toLowerCase()) && !consumed.contains(ac.name().toLowerCase())) {
                changes.add(new Change.DropColumn(e.name(), e.schema(), ac.name()));
            }
        }
    }

    /** True if `a` is the old name of some expected table via a @previousName hint (so it's a rename, not a drop). */
    private boolean isRenameTarget(TableDescriptor a, SchemaSnapshot expected, RenameHints hints) {
        for (TableDescriptor e : expected.tables()) {
            String prev = hints.previousTable(e.name());
            if (prev != null && prev.equalsIgnoreCase(a.name())) return true;
        }
        return false;
    }

    private static Map<String, TableDescriptor> byName(List<TableDescriptor> ts) {
        Map<String, TableDescriptor> m = new LinkedHashMap<>();
        for (TableDescriptor t : ts) m.put(t.name().toLowerCase(), t);
        return m;
    }
    private static Map<String, ColumnDescriptor> byColName(List<ColumnDescriptor> cs) {
        Map<String, ColumnDescriptor> m = new LinkedHashMap<>();
        for (ColumnDescriptor c : cs) m.put(c.name().toLowerCase(), c);
        return m;
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SchemaDifferTest`
Expected: `Tests run: 7, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/SchemaDiffer.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/SchemaDifferTest.java
git commit -m "feat(omdb): deterministic SchemaDiffer (port of migrate-ts passes; @previousName rename; status)"
```

---

## Phase E — Render + emit

### Task E1: Dialect render primitives (Postgres + Derby) + `MigrationEmitter`

Render primitives turn a `Change` into dialect SQL (canonical `SqlType` → dialect string). They live on the driver so `apply` and `emit` share one source; `createTable` is routed through `renderCreateTable`. `MigrationEmitter.emit` assembles the `up` script and throws `BlockedChangesError` if any blocked change would be written.

**Files:**
- Create: `.../db/MigrationSqlRenderer.java` (interface)
- Create: `.../migrate/EmitResult.java`
- Create: `.../migrate/MigrationEmitter.java`
- Modify: `.../db/DatabaseDriver.java` (extends `MigrationSqlRenderer`)
- Modify: `.../driver/GenericSQLDriver.java` (default-throwing primitives)
- Modify: `.../driver/PostgresDriver.java`, `.../driver/DerbyDriver.java` (implement; route `createTable` through `renderCreateTable`)
- Test: `.../migrate/RenderAndEmitTest.java`

- [ ] **Step 1: Write the failing test** (rendered SQL + emit + blocked-throws)

```java
package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.db.driver.PostgresDriver;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;
import static com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

public class RenderAndEmitTest {
    private TableDescriptor program() {
        return new TableDescriptor("program", null,
            List.of(new ColumnDescriptor("id", new SqlType.Int(64), false, null),
                    new ColumnDescriptor("title", new SqlType.Text(120), true, null)),
            List.of(), List.of(), List.of("id"));
    }

    @Test public void postgres_renders_create_add_widen_rename() {
        PostgresDriver pg = new PostgresDriver();
        assertTrue(pg.render(new Change.CreateTable(program())).startsWith("CREATE TABLE"));
        assertEquals("ALTER TABLE program ADD COLUMN title VARCHAR(120)",
            pg.render(new Change.AddColumn("program", null, new ColumnDescriptor("title", new SqlType.Text(120), true, null))));
        assertEquals("ALTER TABLE program ALTER COLUMN title TYPE VARCHAR(400)",
            pg.render(new Change.ChangeColumnType("program", null, "title", new SqlType.Text(120), new SqlType.Text(400))));
        assertEquals("ALTER TABLE program RENAME COLUMN name TO title",
            pg.render(new Change.RenameColumn("program", null, "name", "title")));
    }
    @Test public void derby_rename_uses_derby_grammar() {
        assertEquals("RENAME COLUMN program.name TO title",
            new DerbyDriver().render(new Change.RenameColumn("program", null, "name", "title")));
    }
    @Test public void emit_assembles_up_script_for_allowed_changes() {
        DiffResult r = new DiffResult(
            List.of(new Change.CreateTable(program(), Change.ChangeStatus.ALLOWED)), List.of());
        EmitResult out = new MigrationEmitter(new PostgresDriver()).emit(r);
        assertTrue(out.up().contains("CREATE TABLE"));
        assertEquals("", out.down());        // forward-only v1 (declared for shape parity)
    }
    @Test(expected = BlockedChangesError.class)
    public void emit_throws_on_blocked_changes() {
        Change blocked = new Change.DropColumn("program", null, "legacy")
            .withStatus(Change.ChangeStatus.blocked("destructive"));
        new MigrationEmitter(new PostgresDriver()).emit(new DiffResult(List.of(blocked), List.of(blocked)));
    }
}
```

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=RenderAndEmitTest`
Expected: compile failure.

- [ ] **Step 3: Add `MigrationSqlRenderer` + extend `DatabaseDriver`**

`MigrationSqlRenderer.java`:

```java
package com.metaobjects.manager.db;

import com.metaobjects.manager.db.migrate.Change;

/** Dialect render of a single Change to forward-only SQL. Implemented by drivers (Postgres+Derby in v1). */
public interface MigrationSqlRenderer {
    /** @return the SQL statement (no trailing ';'); throws UnsupportedOperationException for unported kinds/dialects. */
    String render(Change change);
}
```

In `DatabaseDriver.java`: `public interface DatabaseDriver extends MigrationSqlRenderer {`.

- [ ] **Step 4: Default-throwing `render` in `GenericSQLDriver`; implement in Postgres + Derby**

In `GenericSQLDriver`, add a `render(Change)` that throws `UnsupportedOperationException("<driver> does not implement migration render for " + change.kind())`.

In `PostgresDriver`: implement `render(Change)` via `instanceof` dispatch, a `pgType(SqlType)` helper (extract the existing `createTable` type switch into this, mapping canonical `SqlType`→PG string: `Int(32)`→INTEGER, `Int(64)`→BIGINT, `Text(n)`→VARCHAR(n)/TEXT, `Bool`→BOOLEAN, `Timestamp`→TIMESTAMP WITH TIME ZONE, `Real`→DOUBLE PRECISION, `Numeric`→NUMERIC, `Json`→JSONB, `Date`→DATE, `Uuid`→UUID, `Blob`→BYTEA), and `renderCreateTable(TableDescriptor)`. Route the existing `createTable(Connection, TableDef)` to execute `renderCreateTable(toDescriptor(tableDef))` — OR keep `createTable` rendering from `TableDef` directly and have `renderCreateTable(TableDescriptor)` share `pgType`; the key is one `pgType` source. Map the Change kinds:
- `CreateTable` → `renderCreateTable(t.table())`
- `AddColumn` → `ALTER TABLE <t> ADD COLUMN <c> <pgType>`
- `ChangeColumnType` → `ALTER TABLE <t> ALTER COLUMN <c> TYPE <pgType(to)>`
- `RenameColumn` → `ALTER TABLE <t> RENAME COLUMN <from> TO <to>`
- `RenameTable` → `ALTER TABLE <from> RENAME TO <to>`
- `AddIndex` → `CREATE [UNIQUE] INDEX <n> ON <t>(<cols>)`
- `AddFk` → `ALTER TABLE <t> ADD CONSTRAINT <n> FOREIGN KEY (<cols>) REFERENCES <reft>(<refcols>)`
- `CreateView` → `CREATE OR REPLACE VIEW <n> AS <sql>`
- `DropColumn`/`DropTable`/`DropIndex`/`DropFk` → the destructive SQL (rendered only when the engine has marked them allowed; emit gates on status)

In `DerbyDriver`: same with Derby grammar — `RenameColumn` → `RENAME COLUMN <t>.<from> TO <to>`; `RenameTable` → `RENAME TABLE <from> TO <to>`; `CreateView` → `CREATE VIEW ... AS ...` (no `OR REPLACE`); `ChangeColumnType` widen → `ALTER TABLE <t> ALTER COLUMN <c> SET DATA TYPE <derbyType(to)>`; `derbyType(SqlType)` extracted from the existing Derby `createTable` switch (VARCHAR>32700 → CLOB).

(Read both `createTable` methods first; extract the type switch into `pgType`/`derbyType` taking canonical `SqlType`. The `toDescriptor(TableDef)` shim — or rendering directly from `TableDef` — is an implementation choice; keep one type-mapping source.)

- [ ] **Step 5: Implement `EmitResult` + `MigrationEmitter`**

`EmitResult.java`:

```java
package com.metaobjects.manager.db.migrate;

/**
 * Port of migrate-ts EmitResult. v1 fills `up` only; `down` is "" (declared for cross-language shape parity).
 * TS also carries `recreatedTables` (SQLite recreate-and-copy bookkeeping) — omitted here: the v1 Java
 * dialects (Postgres/Derby) use in-place ALTER, so there is no recreate set to track.
 */
public record EmitResult(String up, String down) {}
```

`MigrationEmitter.java`:

```java
package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.MigrationSqlRenderer;
import java.util.List;

/** Assembles the forward-only `up` script from allowed changes; refuses if any change is blocked. */
public final class MigrationEmitter {
    private final MigrationSqlRenderer renderer;
    public MigrationEmitter(MigrationSqlRenderer renderer) { this.renderer = renderer; }

    public EmitResult emit(DiffResult diff) {
        if (!diff.blocked().isEmpty()) throw new BlockedChangesError(diff.blocked());
        StringBuilder up = new StringBuilder();
        for (Change c : diff.changes()) up.append(renderer.render(c)).append(";\n");
        return new EmitResult(up.toString(), "");   // forward-only v1
    }
}
```

- [ ] **Step 6: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=RenderAndEmitTest`
Expected: `Tests run: 4, Failures: 0, Errors: 0`.

- [ ] **Step 7: Full omdb suite (no regression — `createTable` routing must keep `FruitDBTest` green)**

Run: `cd server/java && mvn -o -pl omdb -am test 2>&1 | grep -E "Tests run:|BUILD" | tail -3`
Expected: BUILD SUCCESS; `FruitDBTest` + `JsonbFieldDBTest` still green.

- [ ] **Step 8: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/MigrationSqlRenderer.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/DatabaseDriver.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/GenericSQLDriver.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/PostgresDriver.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/DerbyDriver.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/EmitResult.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/MigrationEmitter.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/RenderAndEmitTest.java
git commit -m "feat(omdb): Postgres+Derby Change render primitives + MigrationEmitter (up-only; blocked-throws)"
```

---

## Phase F — The engine and the four verbs

### Task F1: `SchemaMigrationEngine` — `diff` / `verify` / `emit` / `apply`

The decoupled surface (FR-003 §4). It builds the expected snapshot (via `ExpectedSchemaBuilder`), introspects, diffs, and projects into the four verbs. It never touches the boot-time validator. Connections come through the OMDB abstraction so `apply` joins a Plan-2 Spring-tx scope; DDL executes via `Statement.execute` (correct for DDL — *not* `ObjectManagerDB.execute`, which is for DML).

**Files:**
- Create: `.../migrate/SchemaMigrationEngine.java`
- Create (fixture): `server/java/omdb/src/test/resources/meta.migrate.json` (a `Program` entity → table `program`, `id` primary identity `@generation:"increment"`, `title` VARCHAR — model on `meta.jsonb.json`/fruit fixtures)
- Test: `.../migrate/SchemaMigrationEngineTest.java`

- [ ] **Step 1: Write the failing E2E test** (Derby; harness mirrors `JsonbFieldDBTest`)

```java
// SchemaMigrationEngineTest.java — Derby in-memory; wire ObjectManagerDB + DerbyDriver + DataSource +
// loader exactly as JsonbFieldDBTest.setup (do NOT run MetaClassDBValidatorService — the engine is the
// authority under test). engine = new SchemaMigrationEngine(omdb, registry);
//
// Test 1 (diff/verify/emit on empty DB):
//   DiffResult d = engine.diff(conn, new AllowOptions());
//   assertFalse(d.isEmpty()); assertTrue(engine.verify(conn, new AllowOptions()));   // drift exists
//   assertTrue(engine.emit(conn, new AllowOptions()).up().contains("CREATE TABLE"));
//
// Test 2 (apply converges -> round-trip clean):
//   engine.apply(conn, new AllowOptions());
//   assertFalse(engine.verify(conn, new AllowOptions()));               // no drift
//   assertTrue(engine.diff(conn, new AllowOptions()).isEmpty());        // empty re-diff
//   assertEquals("", engine.emit(conn, new AllowOptions()).up());       // nothing to emit
//
// Test 3 (destructive surfaced + gated): raw-SQL add column LEGACY to the live table; re-diff;
//   assertEquals(1, engine.diff(conn, new AllowOptions()).blocked().size());          // drop-column blocked
//   try { engine.apply(conn, new AllowOptions()); fail(); } catch (BlockedChangesError ok) {}
//   // LEGACY still present (apply refused). With allow.dropColumn(true), apply drops it and converges.
//   engine.apply(conn, AllowOptions.builder().dropColumn(true).build());
//   assertFalse(engine.verify(conn, new AllowOptions()));
```

Write the full JUnit4 test against the Plan-2 harness; assertions above are the contract.

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SchemaMigrationEngineTest`
Expected: compile failure.

- [ ] **Step 3: Implement `SchemaMigrationEngine`**

```java
package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.MigrationSqlRenderer;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.registry.MetaDataLoaderRegistry;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Decoupled diff-and-converge engine (FR-003 §4). Builds the expected snapshot from metadata,
 * introspects the live DB, diffs, and exposes diff/verify/emit/apply. Nothing applied on construction.
 */
public final class SchemaMigrationEngine {
    private final ObjectManagerDB manager;
    private final MetaDataLoaderRegistry loaderRegistry;
    private final SchemaIntrospector introspector = new SchemaIntrospector();
    private final SchemaDiffer differ = new SchemaDiffer();

    public SchemaMigrationEngine(ObjectManagerDB manager, MetaDataLoaderRegistry loaderRegistry) {
        this.manager = manager;
        this.loaderRegistry = loaderRegistry;
    }

    /** The (deterministic) change list to bring the live DB to match metadata. */
    public DiffResult diff(Connection c, AllowOptions allow) throws SQLException {
        RenameHints hints = new RenameHints();
        SchemaSnapshot expected = new ExpectedSchemaBuilder(manager, loaderRegistry).build(hints);
        SchemaSnapshot actual = introspector.introspect(c, null);
        return differ.diff(expected, actual, allow, hints);
    }

    /** Drift gate: true when the schema diverges (CI maps true -> non-zero exit). */
    public boolean verify(Connection c, AllowOptions allow) throws SQLException {
        return !diff(c, allow).isEmpty();
    }

    /** Forward-only `up` script (throws BlockedChangesError if any change is blocked). */
    public EmitResult emit(Connection c, AllowOptions allow) throws SQLException {
        return new MigrationEmitter(renderer()).emit(diff(c, allow));
    }

    /** Execute the changes (throws BlockedChangesError before running anything if any is blocked). */
    public void apply(Connection c, AllowOptions allow) throws SQLException {
        DiffResult d = diff(c, allow);
        if (!d.blocked().isEmpty()) throw new BlockedChangesError(d.blocked());
        MigrationSqlRenderer r = renderer();
        try (Statement s = c.createStatement()) {     // DDL: Statement.execute (not ObjectManagerDB.execute)
            for (Change ch : d.changes()) s.execute(r.render(ch));
        }
    }

    private MigrationSqlRenderer renderer() { return (MigrationSqlRenderer) manager.getDatabaseDriver(); }
}
```

(For Spring-tx participation, callers pass the tx-bound `Connection` from Plan 2's `SpringObjectConnections.current(ds)`; the engine takes a `Connection` so it composes with either a pooled or a tx-bound connection. Confirm `manager.getDatabaseDriver()` returns the `DatabaseDriver` — it does per Plan 1.)

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=SchemaMigrationEngineTest`
Expected: all three behavioral assertions pass.

- [ ] **Step 5: Full omdb suite (no regression)**

Run: `cd server/java && mvn -o -pl omdb -am test 2>&1 | grep -E "Tests run:|BUILD" | tail -3`
Expected: BUILD SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/SchemaMigrationEngine.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/SchemaMigrationEngineTest.java \
        server/java/omdb/src/test/resources/meta.migrate.json
git commit -m "feat(omdb): SchemaMigrationEngine — decoupled diff/verify/emit/apply (FR-003 §4)"
```

> **MVP stop point.** The engine + verbs are now usable from any consumer (build, test, or Spring `CommandLineRunner`). Phase G adds the Maven surface; it can be deferred.

---

## Phase G — `meta migrate` Maven surface

### Task G1: `MetaDataMigrateMojo` (verbs + allow flags + timestamped `writeMigration`)

The Java-idiomatic surface. `verb` ∈ `diff|verify|emit|apply`; `allow*` flags map to `AllowOptions`; `emit` writes `up.sql` into a timestamped dir (mirrors `migrate-ts` `write-migration.ts`, minus `down.sql` — decision 1). `verify` fails the build on drift (CI gate).

**Files:**
- Create: `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataMigrateMojo.java`
- Modify: `server/java/maven-plugin/pom.xml` (add `metaobjects-omdb` — a migration tool legitimately needs a JDBC connection at build time)
- Test: `server/java/maven-plugin/src/test/java/com/metaobjects/mojo/MetaDataMigrateMojoTest.java`

- [ ] **Step 1: Write the failing test** (emit verb, Derby; follows `MetaDataGeneratorMojoTest`)

```java
// MetaDataMigrateMojoTest.java — uses maven-plugin-testing-harness like MetaDataGeneratorMojoTest.
// Configure verb=emit, an in-memory Derby jdbcUrl + jdbcDriver, a metadata source (meta.migrate.json),
// databaseDriver=DerbyDriver, an outputDir under target. Execute; assert it does not throw and a
// "<ts>-<slug>/up.sql" file exists under outputDir containing "CREATE TABLE".
// Read MetaDataGeneratorMojoTest first for the exact harness/lookupMojo/project-stub setup.
```

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl maven-plugin -am test -Dtest=MetaDataMigrateMojoTest`
Expected: compile/lookup failure.

- [ ] **Step 3: Add `omdb` to `maven-plugin/pom.xml`**

```xml
        <dependency>
            <groupId>com.metaobjects</groupId>
            <artifactId>metaobjects-omdb</artifactId>
            <version>${project.version}</version>
        </dependency>
```

- [ ] **Step 4: Implement the mojo**

```java
package com.metaobjects.mojo;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.DatabaseDriver;          // NB: in ...db, NOT ...db.driver
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.migrate.*;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;     // imports as in AbstractOMDBTest
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;

import java.nio.file.*;
import java.sql.*;
import java.time.format.DateTimeFormatter;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;

/** Diff-and-converge schema migration (FR-003 §4): verb = diff | verify | emit | apply. */
@Mojo(name = "migrate")
public class MetaDataMigrateMojo extends AbstractMetaDataMojo {

    @Parameter(property = "verb", defaultValue = "diff") private String verb;
    @Parameter(property = "jdbcUrl", required = true) private String jdbcUrl;
    @Parameter(property = "jdbcUser") private String jdbcUser;
    @Parameter(property = "jdbcPassword") private String jdbcPassword;
    @Parameter(property = "jdbcDriver") private String jdbcDriver;
    @Parameter(property = "databaseDriver", defaultValue = "com.metaobjects.manager.db.driver.PostgresDriver")
    private String databaseDriver;
    @Parameter(property = "outputDir", defaultValue = "${project.build.directory}/migrations") private String outputDir;
    @Parameter(property = "slug", defaultValue = "migrate") private String slug;
    // allow flags
    @Parameter(property = "allowDropColumn", defaultValue = "false") private boolean allowDropColumn;
    @Parameter(property = "allowDropTable", defaultValue = "false") private boolean allowDropTable;
    @Parameter(property = "allowTypeChange", defaultValue = "false") private boolean allowTypeChange;

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        try {
            if (jdbcDriver != null) Class.forName(jdbcDriver);
            ObjectManagerDB manager = new ObjectManagerDB();
            manager.setDatabaseDriver(
                (DatabaseDriver) Class.forName(databaseDriver).getDeclaredConstructor().newInstance());

            AllowOptions allow = AllowOptions.builder()
                .dropColumn(allowDropColumn).dropTable(allowDropTable).typeChange(allowTypeChange).build();

            // AbstractMetaDataMojo exposes NO registry accessor — it provides createLoader(ClassLoader)
            // + createProjectClassLoader(). Load the loader the base builds, then wrap it in a registry
            // (mirrors AbstractOMDBTest's wiring). The engine needs the registry.
            MetaDataLoader loader = createLoader(createProjectClassLoader());
            MetaDataLoaderRegistry registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
            registry.registerLoader(loader);

            try (Connection c = DriverManager.getConnection(jdbcUrl, jdbcUser, jdbcPassword)) {
                SchemaMigrationEngine engine = new SchemaMigrationEngine(manager, registry);
                switch (verb) {
                    case "diff" -> engine.diff(c, allow).changes()
                        .forEach(ch -> getLog().info("  " + ch.kind() + "  " + ch.sortKey()
                            + ("blocked".equals(ch.status().state()) ? "  [BLOCKED: " + ch.status().blockedReason() + "]" : "")));
                    case "verify" -> {
                        if (engine.verify(c, allow)) throw new MojoFailureException(
                            "Schema drift detected. Run 'migrate -Dverb=diff' for details.");
                        getLog().info("Schema in sync — no drift.");
                    }
                    case "emit" -> {
                        String up = engine.emit(c, allow).up();
                        Path dir = Path.of(outputDir, timestamp() + "-" + sanitize(slug));
                        Files.createDirectories(dir);
                        Files.writeString(dir.resolve("up.sql"), up.endsWith("\n") ? up : up + "\n");
                        getLog().info("Wrote migration: " + dir.resolve("up.sql"));
                    }
                    case "apply" -> { engine.apply(c, allow); getLog().info("Applied migration."); }
                    default -> throw new MojoExecutionException("Unknown verb: " + verb + " (diff|verify|emit|apply)");
                }
            }
        } catch (MojoFailureException | MojoExecutionException e) {
            throw e;
        } catch (BlockedChangesError e) {
            throw new MojoFailureException(e.getMessage(), e);
        } catch (Exception e) {
            throw new MojoExecutionException("Migration verb '" + verb + "' failed: " + e.getMessage(), e);
        }
    }

    private static String timestamp() {
        return ZonedDateTime.now(ZoneOffset.UTC).format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss"));
    }
    private static String sanitize(String raw) {
        return raw.toLowerCase().replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
    }
}
```

(`AbstractMetaDataMojo` has **no** `MetaDataLoaderRegistry` accessor — verified. It exposes `createLoader(ClassLoader)` + `createProjectClassLoader()`; the mojo loads via those and wraps the result in `new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault())` + `registerLoader(...)`, exactly as `AbstractOMDBTest` does. Confirm the `createLoader`/`createProjectClassLoader` signatures + the `ServiceRegistryFactory` import by reading both files at the seam. **`DatabaseDriver` lives in `com.metaobjects.manager.db`, not `…db.driver`** — only the concrete drivers are in `…db.driver`.)

- [ ] **Step 5: Run, verify pass**

Run: `cd server/java && mvn -o -pl maven-plugin -am test -Dtest=MetaDataMigrateMojoTest`
Expected: emit test passes (`<ts>-migrate/up.sql` contains `CREATE TABLE`).

- [ ] **Step 6: Commit**

```bash
git add server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataMigrateMojo.java \
        server/java/maven-plugin/src/test/java/com/metaobjects/mojo/MetaDataMigrateMojoTest.java \
        server/java/maven-plugin/pom.xml
git commit -m "feat(maven-plugin): meta migrate mojo (diff/verify/emit/apply) dispatching to SchemaMigrationEngine"
```

---

## Task H1: Reactor green + no regressions

- [ ] **Step 1: Build + test the touched modules and their deps**

Run: `cd server/java && mvn -o -pl metadata,omdb,maven-plugin -am test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD|SUCCESS|FAIL" | grep -vE "Time elapsed" | tail -15`
Expected: BUILD SUCCESS. New tests green: `PreviousNameAttrTest` (1), `SqlTypeTest` (4), `SchemaSnapshotTest` (1), `ChangeStatusRulesTest` (3), `ExpectedSchemaBuilderTest`, `SchemaIntrospectorTest` (2), `SchemaDifferTest` (7), `RenderAndEmitTest` (4), `SchemaMigrationEngineTest`, `MetaDataMigrateMojoTest`. Plan 1/2 tests + `FruitDBTest`/`JsonbFieldDBTest` still green.

- [ ] **Step 2: Acknowledge the known pre-existing failure**

The `metadata` `CanonicalJsonParserTest` 2-error CWD-path fragility is pre-existing (Plan 1/2 notes) — not introduced here. If it surfaces in an `-am` aggregate run, confirm it's only those 2 and unrelated.

- [ ] **Step 3: Final commit (if any loose ends) + ready for review**

---

## Self-Review

- **Spec coverage (FR-003 §4):** create-if-missing → diff-and-converge → Phases C–F; additive set (create table/column, widen, index/fk/view) → `SchemaDiffer` + render primitives; emit/verify/diff/apply, decoupled (never touches `MetaClassDBValidatorService.init()`) → `SchemaMigrationEngine` + mojo; destructive requires opt-in/hint, never silent → `ChangeStatusRules` (blocked unless `AllowOptions`) + `@previousName` → rename; baseline-adoption then schema-equivalence → `verify` is no-drift exactly when metadata reproduces the live schema (engine round-trip test). Resolves open questions #1/#2/#5. ✓
- **Standardization (the question that prompted this revision):** the model is a 1:1 port of `migrate-ts/src/{types,sql-type,diff/status,errors,diff/index}.ts` — `SqlType`, `SchemaSnapshot`/descriptors, `Change`/`ChangeStatus`/`ChangeKind`, `AllowOptions`, `DiffResult`, `EmitResult`, `BlockedChangesError`, `applyStatus`/`isWidening`. Java names mirror TS. ✓
- **Reuse, not reinvent (per the research):** expected snapshot reuses `MappingHandler` defs via `ExpectedSchemaBuilder` (the shared collector — the validator can adopt it later); canonical type flows from `SimpleMappingHandlerDB`'s field→type mapping (via `ColumnDef.getSQLType()` + `JdbcSqlTypes`); DDL text is the dialect driver's render primitives (one `pgType`/`derbyType` source, `createTable` routed through it); `apply` uses the OMDB connection + `Statement.execute` (not `ObjectManagerDB.execute`, which is DML). Constants for verbs/kinds (`ChangeKind`), not literals. ✓
- **Two divergences handled honestly:** forward-only `up` (decision 1; `EmitResult.down` declared, empty); `@previousName`-only rename (decision 2; rename change-kinds modeled like TS so a heuristic is additive). Both flagged for FR-003 wording reconciliation (memory: `fr003-migrate-cross-lang-divergences`). `change-column-nullable`/`change-column-default` declared but not produced in v1 — mirrors TS deferring view kinds. ✓
- **Placeholder scan:** pure-logic tasks (SqlType, Change/status, differ, render/emit) carry full code + exact commands; the three DB/maven-harness E2E tasks (`ExpectedSchemaBuilderTest`, `SchemaMigrationEngineTest`, `MetaDataMigrateMojoTest`) are precise behavioral contracts + "read the existing harness first", per Plan 2's accepted convention. ✓
- **Type consistency:** `SqlType.{Text,Int,Real,Numeric,Bool,Timestamp,Date,Json,Blob,Uuid}` + `isWidening`; `SchemaSnapshot.{TableDescriptor,ColumnDescriptor,IndexDescriptor,FkDescriptor,ViewDescriptor}`; `Change.*` + `ChangeStatus`/`ChangeKind` + `withStatus`/`sortKey`; `AllowOptions`(+Builder); `DiffResult`/`EmitResult`; `ChangeStatusRules.applyStatus`; `RenameHints.{addColumnRename,previousColumn,addTableRename,previousTable}`; `JdbcSqlTypes.fromJdbc`; `ExpectedSchemaBuilder.build`; `SchemaIntrospector.introspect`; `SchemaDiffer.diff`; `MigrationSqlRenderer.render`; `MigrationEmitter.emit`; `SchemaMigrationEngine.{diff,verify,emit,apply}` — consistent across tasks. ✓
- **Hygiene:** repo-relative paths; generic `myapp::commerce`/`Program` examples; no home paths or private-project names — passes the pre-commit guard. ✓
- **Seams read, not guessed:** Pre-flight reads the TS contract, the validator derivation, `getSQLType`, `@dbNullable`/`@generation`, the driver DDL switch, and the Derby/maven harnesses before any task wires them. Casts/accessors flagged "verify at the seam" (`SimpleMappingHandlerDB` getSQLType visibility; `MetaObject.getMetaFields()`; `AbstractMetaDataMojo` registry accessor). ✓
