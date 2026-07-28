# D1 FK-cascade auto-fix (#241) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace #226's *refuse* with a cascade that generates a correct, appliable D1 migration when a foreign-key-referenced table is rebuilt — and close #226's residual under-refuse gap. Refuse only multi-table FK cycles.

**Architecture:** New `emit/d1-cascade.ts` holds a reverse FK-graph (over the *union* of the actual and expected schemas), a topological sort with cycle detection, and a cascade emitter that reuses `emit/sqlite.ts` primitives. `renderD1` dispatches to the cascade for an acyclic referenced-rebuild and throws a cycle-refusal otherwise. `EmitOptions` gains `actualSchema`, threaded from both `meta migrate` emit call sites. Local SQLite + Postgres are untouched; the no-referenced-rebuild path stays byte-identical.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), `bun:test`, libSQL (raw `libsql.createClient`, one-transaction model = remote D1) for the gate.

**Design spec:** `docs/superpowers/specs/2026-07-28-d1-fk-cascade-design.md`

**The validated cascade recipe** (spike-proven 10/10; all statements inside D1's implicit transaction):
```sql
PRAGMA defer_foreign_keys = ON;
CREATE TABLE __f_<t> ( <final schema; FK cols → __f_<ref> if ref∈A else <ref> );   -- for each t in A
INSERT INTO __f_<t> ( <carry cols> ) SELECT <mapped cols> FROM <t>;                -- for each t in A
DROP TABLE <t>;                          -- REFERRERS-FIRST (reverse-topological)
ALTER TABLE __f_<t> RENAME TO <t>;       -- PARENTS-FIRST (topological)
```
Referrers-first DROP + parents-first RENAME are load-bearing. Forward-ref FKs in CREATE are fine (SQLite resolves FK targets lazily).

## Global Constraints

- All changes in `server/typescript/packages/migrate-ts` + a 2-line `server/typescript/packages/cli` change (+ docs/CHANGELOG). TS-only; no other-port impact.
- **Byte-identical** D1 output for any migration that does NOT rebuild a referenced table (the cascade path is entered only when `recreatedTables` intersects the FK-referenced set).
- No `any`; ESM `.js` import specifiers.
- The affected-set + ordering FK graph is the **union of the actual and expected** FK edges over `A`. When `actualSchema` is absent, fall back to expected-only AND **refuse** any referenced rebuild not provably safe (never emit an unproven cascade).
- Multi-table cycles (len ≥ 2) are refused; self-loops are handled by the temp-name trick (excluded from the cycle check).
- Run tests scoped: `cd server/typescript/packages/migrate-ts && bun test <file>`. Never bare repo-root `bun test`.
- Unrelated untracked `.serena/` — never stage it. Stage only each task's files; never `git add -A`. Commit to `main`.

---

### Task 1: Export the SQLite rebuild primitives (read-only extraction)

**Files:** Modify `src/emit/sqlite.ts`; Test `test/unit/sqlite-primitives-export.test.ts`

The cascade reuses SQLite's `renderCreateTable(t: TableDescriptor): string` (sqlite.ts:257), `renderCreateIndex(table: string, ix: IndexDescriptor): string` (sqlite.ts:367), and the column carry/remap logic currently inline in `renderRecreate` (sqlite.ts:132-192, lines 137-156: the renames map, addedNames set, `carryColumns`/`insertCols`/`selectCols`). This task exposes them WITHOUT changing SQLite behavior.

- [ ] **Step 1 (test):** Write `test/unit/sqlite-primitives-export.test.ts` importing `{ renderCreateTable, renderCreateIndex, computeCarryColumns }` from `../../src/emit/sqlite.js`; assert `renderCreateTable({name:"t",columns:[{name:"id",sqlType:{kind:"integer",bits:64},nullable:false}],indexes:[],foreignKeys:[],primaryKey:["id"],checks:[]})` contains `CREATE TABLE "t"`; assert `computeCarryColumns` (see Step 3 signature) maps a rename correctly.
- [ ] **Step 2:** Run — FAIL (not exported / `computeCarryColumns` undefined).
- [ ] **Step 3 (impl):** Add `export` to `renderCreateTable` and `renderCreateIndex`. Extract the carry/remap block from `renderRecreate` into an exported pure helper and call it from `renderRecreate` (so SQLite output is unchanged):
  ```ts
  export interface CarryColumns { insertCols: string[]; selectCols: string[]; }
  /** newTable columns not newly-added, mapped to their old-name SELECT source (for renames). */
  export function computeCarryColumns(tableChanges: Change[], newTable: TableDescriptor): CarryColumns {
    const renames = new Map<string, string>();
    for (const c of tableChanges) if (c.kind === "rename-column") renames.set(c.from, c.to);
    const addedNames = new Set<string>();
    for (const c of tableChanges) if (c.kind === "add-column") addedNames.add(c.column.name);
    const renamesReverse = new Map<string, string>();
    for (const [from, to] of renames) renamesReverse.set(to, from);
    const carry = newTable.columns.filter((c) => !addedNames.has(c.name));
    return { insertCols: carry.map((c) => c.name), selectCols: carry.map((c) => renamesReverse.get(c.name) ?? c.name) };
  }
  ```
  Replace the inline block in `renderRecreate` with a call to it.
- [ ] **Step 4:** Run the new test AND `test/` sqlite/recreate suites (`bun test test/unit/sqlite-primitives-export.test.ts` + any `*recreate*`/`*sqlite*` unit test) — all PASS, SQLite output unchanged.
- [ ] **Step 5:** Commit `refactor(#241): export SQLite rebuild primitives for D1 cascade reuse`.

---

### Task 2: FK-graph + topological sort + cycle detection

**Files:** Create `src/emit/fk-graph.ts`; Test `test/unit/fk-graph.test.ts`

Pure functions, no I/O. This is the graph core the cascade orders by.

**Interfaces (produce):**
- `buildFkEdges(schema: SchemaSnapshot): Map<string, Set<string>>` — child→parent edges (`table` → set of `refTable`), self-loops included.
- `unionEdges(a, b): Map<string,Set<string>>` — merge two edge maps.
- `affectedSet(recreated: ReadonlySet<string>, edges: Map<string,Set<string>>): Set<string>` — `recreated` plus all transitive *referrers* (walk edges backwards: any table with an edge into the set).
- `topoOrder(nodes: Set<string>, edges): { order: string[]; cycle: string[] | null }` — Kahn's algorithm over `nodes` (edges child→parent; ignore self-loops and edges leaving `nodes`). `order` = parents-first (a table appears after all tables it references within `nodes`). `cycle` = a multi-node cycle's members if the sort can't complete, else `null`.

- [ ] **Step 1 (test):** cover: `buildFkEdges` from a `{child→parent}` schema; a self-loop table maps to itself; `affectedSet` pulls a grandchild in via transitive referrer walk (`g→c→p`, recreated={p} → {p,c,g}); `topoOrder` returns parents-first for `g→c→p` (`[p,c,g]`) and self-loops don't block; `topoOrder` on `A↔B` returns `cycle=[A,B]`. Use the same `table()` fixture helper style as `test/unit/d1-fk-refuse.test.ts`.
- [ ] **Step 2:** Run — FAIL (module missing).
- [ ] **Step 3 (impl):** Implement the four functions. `affectedSet`: BFS/worklist adding any `x` where `edges.get(x)` intersects the current set (referrer walk), until fixpoint. `topoOrder`: Kahn over `nodes`, treating an edge `child→parent` as "parent must come before child"; drop self-loops (`x→x`) and edges whose target ∉ `nodes`; if nodes remain when the queue empties, return them as `cycle`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(#241): FK-graph, affected-set, and topological sort with cycle detection`.

---

### Task 3: Thread `actualSchema` through `emit` + the CLI call sites

**Files:** Modify `src/emit/index.ts`; Modify `server/typescript/packages/cli/src/commands/migrate.ts`; Test `test/unit/emit-actualschema-passthrough.test.ts`

**Interfaces:** `EmitOptions` gains `actualSchema?: SchemaSnapshot`; `emit` passes it to `renderD1` as a 4th arg `renderD1(changes, expectedSchema, actualMeta, actualSchema)`.

- [ ] **Step 1 (test):** Assert `emit(changes, { dialect:"d1", expectedSchema, actualSchema })` forwards `actualSchema` — simplest: a d1 referenced-rebuild that would refuse WITHOUT actualSchema but (after Task 4) cascades WITH it; for THIS task, assert the option is accepted and a plain non-referenced d1 emit is byte-identical whether or not `actualSchema` is passed.
- [ ] **Step 2:** Run — FAIL (type error: `actualSchema` not on `EmitOptions`) — or write the test to first fail on behavior.
- [ ] **Step 3 (impl):** Add `actualSchema?: SchemaSnapshot` to `EmitOptions` (doc-comment: used by the d1 cascade to build the actual∪expected FK graph). In `emit`, `case "d1": return renderD1(opts.changes... , opts.expectedSchema, opts.actualMeta, opts.actualSchema);` (extend `renderD1`'s signature to accept the optional 4th arg; unused until Task 4). In `cli/src/commands/migrate.ts`, at the live-introspection emit call (~440) add `actualSchema: actual`, and at the offline emit call (~833) add `actualSchema: snapshot`. Both `actual` and `snapshot` are `SchemaSnapshot` in scope there.
- [ ] **Step 4:** Run the new test + `test/unit/emit-d1.test.ts` + `emit-d1-refuse.test.ts` — PASS (still byte-identical; refuse still fires for a referenced rebuild since Task 4 isn't in yet).
- [ ] **Step 5:** Commit `feat(#241): thread actualSchema through emit() to the d1 emitter`.

---

### Task 4: The cascade emitter + `renderD1` dispatch (the meat)

**Files:** Create `src/emit/d1-cascade.ts`; Modify `src/emit/d1.ts`; Modify `src/emit/d1-fk-refuse.ts` (repurpose the error message for cycles); Test `test/unit/d1-cascade.test.ts`

**`d1-cascade.ts` — `emitD1Cascade(changes, expectedSchema, actualSchema | undefined, recreatedTables): { up: string; downWarning: string } | { refuseCycle: string[] }`:**
1. `edges = unionEdges(buildFkEdges(expectedSchema), actualSchema ? buildFkEdges(actualSchema) : emptyEdges)`.
2. `A = affectedSet(recreatedTables, edges)`.
3. `{ order, cycle } = topoOrder(A, edges)`. If `cycle` → return `{ refuseCycle: cycle }`.
4. Build statements in the validated order:
   - `PRAGMA defer_foreign_keys = ON;`
   - For each `t` in `A` (any order): a `CREATE TABLE __f_<t>` from `t`'s **expected** `TableDescriptor` (via `renderCreateTable`) BUT with the temp name `__f_<t>` and every FK whose `refTable ∈ A` rewritten to `__f_<refTable>`. (Build a modified `TableDescriptor` clone: `name:"__f_"+t`, `foreignKeys` mapped.) Indexes are recreated AFTER rename (step below), matching `renderRecreate`.
   - For each `t` in `A`: `INSERT INTO __f_<t> (insertCols) SELECT selectCols FROM <t>` using `computeCarryColumns(changesForTable(t), expectedTable(t))`. For a table in `A` but NOT in `recreatedTables` (pulled in as a referrer, no changes), `changesForTable` is `[]` → carry = all expected columns by name.
   - `DROP TABLE <t>` for each `t` in **reverse `order`** (referrers-first).
   - `ALTER TABLE __f_<t> RENAME TO <t>` for each `t` in **`order`** (parents-first).
   - After each rename, recreate that table's indexes (`renderCreateIndex(t, ix)` for `ix` in the expected descriptor's `indexes`).
5. `downWarning` = the same best-effort `-- WARNING` block `renderRecreate` emits.

Notes: reuse `renderCreateTable`/`renderCreateIndex`/`computeCarryColumns` from Task 1. `changesForTable(t)` = `changes.filter(c => changeTable(c) === t)` — you may need to export `changeTable` from sqlite.ts too (add to Task 1 if so).

**`d1.ts` (`renderD1`) dispatch:** when `sqliteResult.recreatedTables` intersects the FK-referenced set (existing `findReferencedRebuilds` on `expectedSchema` OR the actual graph):
- If `actualSchema` is undefined AND there is a referenced rebuild → refuse (as #226 does today) — never emit an unproven cascade.
- Else call `emitD1Cascade(...)`. On `{ refuseCycle }` → throw the (repurposed) error naming the cycle. On success → the cascade `up` REPLACES the recreate portion of the sqlite output. Simplest correct integration: when a cascade is needed, emit the cascade for the affected-set tables and let renderSqlite handle all OTHER (non-A) changes; splice by emitting cascade statements first, then the non-recreate, non-A changes via the existing native path. (Detail for the implementer: the cleanest approach is to compute the cascade statements for `A`, then append the sqlite-native emit of all changes whose table ∉ `A` — reuse `renderSqlite` filtered, or emit the cascade and the remaining `renderUpNative` changes. Verify against the gate that a mixed migration converges.)
- Run the result through `applyD1SafetyPass`; do NOT emit the `PRAGMA foreign_keys=OFF/ON` bracket on the cascade path.

**`d1-fk-refuse.ts`:** repurpose `D1ReferencedTableRebuildError` (or add `D1CyclicForeignKeyError`) so the thrown message now describes the **cycle** case (naming the cycle members + the hand-write workaround), since acyclic referenced rebuilds no longer throw.

- [ ] **Step 1 (test):** `test/unit/d1-cascade.test.ts` — build `changes` + expected/actual schemas via literal fixtures (mirror `emit-d1-refuse.test.ts`). Assert: (a) a referenced-parent rebuild with `actualSchema` produces cascade SQL containing `defer_foreign_keys`, `__f_parent`, referrers-first `DROP`, parents-first `RENAME`, and NO `foreign_keys = OFF`; (b) a multi-table cycle throws the cycle error; (c) a self-ref table produces a single `__f_t` referencing `__f_t`; (d) `actualSchema` absent → still refuses; (e) a non-referenced rebuild → byte-identical to the pre-#241 sqlite-through-safety-pass output.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3 (impl):** Implement `emitD1Cascade` + wire `renderD1` + the error repurpose.
- [ ] **Step 4:** Run `test/unit/d1-cascade.test.ts` + `emit-d1.test.ts` + `emit-d1-refuse.test.ts` (update the latter: acyclic referenced rebuilds now CASCADE, not throw — the throw tests move to the cycle case) — PASS.
- [ ] **Step 5:** Commit `feat(#241): D1 FK-cascade emitter — rebuild referenced tables; refuse only cycles`.

---

### Task 5: libSQL real-engine gate (per topology + gap + cycle)

**Files:** Modify/extend `test/integration/d1-referenced-rebuild.test.ts` (or a new `test/integration/d1-cascade.test.ts`)

Reuse the #226 harness: raw `libsql.createClient` (from `@libsql/kysely-libsql`), `foreign_keys=ON` at the connection, the whole emitted batch run inside ONE `client.transaction("write")` (models remote D1). For each scenario: seed schema+data, emit the D1 migration (`emit({dialect:"d1", expectedSchema, actualSchema, ...})`), apply in one transaction, then assert **applies cleanly, row data intact, FK re-enforced (a bad insert rejected), and a re-diff is EMPTY**.

- [ ] **Step 1 (tests):** scenarios — single parent + populated child; transitive `g→c→p`; multiple children; self-referential; **the #226 gap** (one migration that rebuilds a parent AND drops a child's FK to it — must apply cleanly, proving the actual-graph ordering); a multi-table cycle → `emit` throws (unit-level assertion, no apply); a no-referenced-rebuild migration → D1 `up` byte-identical to sqlite-through-safety-pass. Use the full pipeline (`buildExpectedSchema → introspectSqlite → diff → emit → apply → re-diff`) for the convergence assertions, mirroring `test/integration/sqlite-fk-convergence.test.ts` + the #226 gate.
- [ ] **Step 2:** Run — expect PASS once Task 4 is in (this task is the gate for Task 4). If a convergence assertion fails, the defect is in Task 2/4; fix there and re-run.
- [ ] **Step 3:** Run the full migrate-ts suite once: `bun test` (from the migrate-ts dir; libSQL is file-based, no Docker for these — but the suite also has Postgres Testcontainers tests, so this may be slow; scope to the d1/sqlite/emit tests if Docker is unavailable and note it).
- [ ] **Step 4:** Commit `test(#241): real-engine cascade gate — all topologies + #226 gap + cycle refuse`.

---

### Task 6: Docs + CHANGELOG + close #241

**Files:** Modify `docs/features/migrations-and-drift.md`; Modify `CHANGELOG.md`

- [ ] **Step 1:** In `migrations-and-drift.md`, update the D1 limitation subsection: the emitter now **auto-generates a cascade** to rebuild an FK-referenced table on D1; **remove the "Known limitation of the current refusal" paragraph** (the residual gap is closed); the only remaining hand-write case is a **multi-table FK cycle** (still refused, with guidance).
- [ ] **Step 2:** `CHANGELOG.md` under `## [Unreleased]` (create if absent): `### Added — D1 auto-cascade for rebuilding foreign-key-referenced tables (#241)` — npm-only (`migrate-ts`); describe the cascade, that it closes #226's residual gap, and that multi-table cycles are still refused.
- [ ] **Step 3:** Commit `docs(#241): document the D1 FK-cascade; remove the refusal known-limitation`.

---

## Self-Review

**Spec coverage:** cascade algorithm → Task 4; affected-set/topo/cycle → Task 2; actual∪expected graph + plumbing → Task 3 + Task 4; reuse sqlite primitives → Task 1; refuse cycles only → Task 4; gate per topology + gap + cycle + byte-identical → Task 5; docs/remove-known-limitation → Task 6. Closes #226 residual gap via the union graph (Task 4 uses `actualSchema`).

**Placeholder scan:** Task 4's integration paragraph gives a named approach ("cascade for A + native emit for non-A changes") with the convergence gate as the acceptance test — a concrete strategy with a verification, not a TODO. The emitter's exact statement assembly is specified as the validated recipe + the primitives to call; the implementer assembles it and the Task 5 gate proves it.

**Type consistency:** `buildFkEdges`/`unionEdges`/`affectedSet`/`topoOrder` (Task 2) are consumed by `emitD1Cascade` (Task 4) with matching signatures. `computeCarryColumns`/`renderCreateTable`/`renderCreateIndex` (Task 1) reused in Task 4. `EmitOptions.actualSchema?: SchemaSnapshot` (Task 3) consumed by `renderD1`→`emitD1Cascade` (Task 4). `SchemaSnapshot`/`TableDescriptor`/`FkDescriptor`/`Change` are the existing `types.ts` shapes.
