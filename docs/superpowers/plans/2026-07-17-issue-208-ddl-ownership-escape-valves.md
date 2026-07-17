# #208 DDL-ownership escape valves (`@sql` + `@unmanaged`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author register a hand-written DB-object body (`@sql`) or mark an object as externally-managed (`@unmanaged`) on `source.rdb`, so `meta migrate`/`verify --db` manage its *lifecycle* (fingerprint/drift or skip) without the tool ever synthesizing or parsing its body.

**Architecture:** Two attributes on `source.rdb` expressing one axis (DDL ownership: `derived` | `supplied`=`@sql` | `external`=`@unmanaged`), mutually exclusive. Attr **registration + loader validation are cross-port (5 ports)**; all **migrate/verify lowering is TS-only** (ADR-0015). `@sql` rides the *existing* view-fingerprint/adoption/drop pipeline; the load-bearing new logic is a **suppression rule** that classifies DDL-ownership *before* `viewIsDerived` so an escape-valve view stops getting a silently-wrong synthesized body.

**Tech Stack:** TypeScript (Bun) metadata + codegen-ts + migrate-ts; Java (Maven), Python (pytest), C# (dotnet), Kotlin (rides Java's JVM registry) for the registration + validation fan-out. Canonical spec `spec/metamodel/db.json` → per-port embedded/committed copies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-17-issue-208-ddl-ownership-escape-valves-design.md` (authoritative). Decisions locked: `@sql` / `@unmanaged` names; origins-under-`@unmanaged` = **WARN**, origins-under-`@sql` = **hard error**; v1 `@sql` migrate lowering = **plain `@kind: view` only**; `@filter`+`@sql` = **reject**; matviews stay implicitly hand-managed; `dependsOn` from `extends`-anchors only.
- **Registration is 5-port-atomic.** The `registry-conformance` byte-match against `fixtures/registry-conformance/expected-registry.json` reds any port whose emitted manifest disagrees. Register the two attrs in ALL five ports + update `expected-registry.json` in ONE unit (Task 1), or the laggards go red. Shared `fixtures/conformance/` error-fixtures likewise land only once all ports validate (Task 10).
- **Schema lowering is TS-only** (ADR-0015): all `migrate`/`verify --db` behavior lives in TS; the other four ports only register the attrs + run the cross-port loader validation rules.
- **Strict provenance** (ADR-0023): an unregistered attr is `ERR_UNKNOWN_ATTR`; the library boots strict — you cannot author `@sql`/`@unmanaged` in a real fixture until Task 1 lands.
- **Named constants** for metamodel strings — new `SOURCE_ATTR_SQL = "sql"` / `SOURCE_ATTR_UNMANAGED = "unmanaged"` per port; never inline the literals. No `any` in TS (use `unknown` + narrow).
- **Error codes** (new): `ERR_SQL_BODY_WITH_UNMANAGED`, `ERR_SQL_BODY_ON_WRITABLE_KIND`, `ERR_ORIGIN_UNDER_SQL_BODY`. `@sql` empty/non-string reuses `ERR_BAD_ATTR_VALUE`; `@filter`+`@sql` reuses `ERR_ORIGIN_UNDER_SQL_BODY`.
- **Process:** commit directly to `main` (forward-only; `git fetch` + verify HEAD==origin/main before each commit); author `Doug Mealing <doug@dougmealing.com>`; trailers `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` + `Claude-Session:`. PUBLIC repo — after `git add`, run the CLAUDE.md leak-scan (home paths + the private-name denylist) over the staged diff before committing; the `.githooks/pre-commit` guard enforces it. Heavy `mvn`/`dotnet`/`pytest` builds SEQUENTIAL. Per-unit review gate (`/code-review` high/xhigh) before each merge; cross-port divergence review before declaring done.
- **Verify commands:** TS `cd server/typescript/packages/<pkg> && bun test` (never bare `bun test` at repo root) + `bun run typecheck`; real-PG `cd server/typescript/packages/integration-tests && bun test test/view-lifecycle-pg.test.ts`; registry parity `fixtures/registry-conformance/`; Java `cd server/java && mvn -q -pl metadata test`; Python `cd server/python && .venv/bin/python -m pytest tests -q`; C# `cd server/csharp && dotnet test MetaObjects.Codegen.Tests/...` (or the metadata test project). Known pre-existing red (NOT yours): Python `tests/codegen/test_cli_staleness_nudge.py`.

---

## Phase 1 — Coordinated 5-port registration

### Task 1: Register `@sql` + `@unmanaged` on `source.rdb` across all five ports

**Files:**
- Modify: `spec/metamodel/db.json` (the `source.rdb` subType attrs array, after the `@schema` entry ~line 45)
- Modify: `server/typescript/packages/metadata/src/persistence/db/db-definition.embedded.ts` (regenerated from db.json) + `server/typescript/packages/metadata/src/constants.ts` (add `SOURCE_ATTR_SQL`, `SOURCE_ATTR_UNMANAGED` to the source-attr constants block)
- Modify: the committed spec copies — `server/csharp/**/SpecMetamodel/db.json` and `server/python/**/spec_metamodel/db.json` (grep for the committed copy path in each; Java auto-refreshes the repo-root spec at `generate-resources`, so no committed Java copy)
- Modify: `fixtures/registry-conformance/expected-registry.json` (add the two attrs under the `source.rdb` subtype's attr manifest, in the canonical sort position)
- Create: `fixtures/registry-conformance/` — no new file needed if the manifest is a single expected file; if there is a per-fixture input dir, add `source-sql-escape/` with a minimal metadata fixture exercising both attrs (check the fixture layout first)

**Interfaces:**
- Produces: the two registered attrs (`source.rdb` accepts `@sql: string` and `@unmanaged: boolean` without `ERR_UNKNOWN_ATTR`); `SOURCE_ATTR_SQL`/`SOURCE_ATTR_UNMANAGED` constants consumed by Tasks 2–10.

- [ ] **Step 1: Add the two attr entries to `spec/metamodel/db.json`.** In the `source.rdb` subType attrs array (after `@schema`), add:

```json
{ "type": "attr", "subType": "string", "name": "sql", "min": 0, "max": 1, "description": "FR-024/#208 escape valve — a hand-written SQL body the tool REGISTERS + fingerprints + drift-checks but never authors or parses. The body goes INSIDE `CREATE <kind> <physicalName> AS …` (never the CREATE wrapper, never the object name). Legal only on a read-only kind (not @kind: table); migrate lowers it on @kind: view (matview/proc/tableFunction: registered but not yet migrate-managed). Mutually exclusive with @unmanaged; forbids origin.* children (two sources of truth)." },
{ "type": "attr", "subType": "boolean", "name": "unmanaged", "min": 0, "max": 1, "description": "FR-024/#208 escape valve — this DB object is managed elsewhere (Flyway / a hand-migration owns its DDL). meta migrate does NOT create, drop, or drift-check it; verify --db reports it as external (declared). Legal on any @kind including table (the externally-managed-entity case). Mutually exclusive with @sql." }
```

- [ ] **Step 2: Regenerate the TS embedded definition + committed copies, and add the constants.** Run the repo's spec-embed regeneration (grep `db-definition.embedded` generation script / `package.json` scripts for the codegen that produces `*.embedded.ts` from `spec/metamodel/*.json`; run it). Then sync the committed C#/Python `SpecMetamodel/db.json` copies byte-for-byte. In `constants.ts`, add to the source-attr block:

```ts
export const SOURCE_ATTR_SQL = "sql";
export const SOURCE_ATTR_UNMANAGED = "unmanaged";
```

- [ ] **Step 3: Write the failing registry-conformance expectation.** Add the two attrs to `fixtures/registry-conformance/expected-registry.json` under `source.rdb` (match the exact JSON shape + sort order the other source attrs use — inspect the file first).

- [ ] **Step 4: Register the attrs in the other three ports' providers.** Java (`server/java/metadata/.../db` provider — grep where `@schema`/`@table` are registered on the rdb source; add `sql`/`unmanaged` mirroring), Python (its db provider + the committed `spec_metamodel/db.json`), C# (its db provider + committed `SpecMetamodel/db.json`). Kotlin rides Java's JVM registry — no separate registration. Add each port's `SOURCE_ATTR_SQL`/`SOURCE_ATTR_UNMANAGED` constant equivalents.

- [ ] **Step 5: Run registry-conformance on every port; all green.**

Run (sequential): `cd server/typescript/packages/metadata && bun test` (registry-conformance) ; `cd server/java && mvn -q -pl metadata test` ; `cd server/python && .venv/bin/python -m pytest tests -q -k registry` ; `cd server/csharp && dotnet test <metadata test project>`.
Expected: all PASS — each port emits the two new attrs and byte-matches `expected-registry.json`. (A single laggard = that port's provider or committed copy wasn't synced.)

- [ ] **Step 6: Commit** (5-port coordinated).

```bash
git add spec/metamodel/db.json server/typescript/packages/metadata fixtures/registry-conformance server/java/metadata server/python server/csharp
# leak-scan the staged diff per CLAUDE.md (home paths + private-name denylist) before committing
git commit -m "feat(#208): register @sql + @unmanaged on source.rdb (5-port coordinated)"
```

---

## Phase 2 — TS reference (loader validation + suppression + migrate + verify)

### Task 2: TS `MetaSource` resolving accessors

**Files:**
- Modify: `server/typescript/packages/metadata/src/persistence/source/meta-source.ts` (add `sqlBody` + `isUnmanaged` accessors next to `effectiveKind`/`role`)
- Test: `server/typescript/packages/metadata/test/` (a meta-source unit test; mirror an existing `effectiveKind` test)

**Interfaces:**
- Produces: `MetaSource.sqlBody: string | undefined` (resolving — `attr(SOURCE_ATTR_SQL)` narrowed to a non-empty string, else undefined) and `MetaSource.isUnmanaged: boolean` (resolving — `attr(SOURCE_ATTR_UNMANAGED) === true`). RESOLVING (not own-only) — sources are inheritable, matching `@role`/`effectiveKind`.

- [ ] **Step 1: Write the failing test.**

```ts
test("MetaSource exposes @sql body and @unmanaged flag (resolving)", async () => {
  const root = await loadString(`{"metadata.root":{"package":"t","children":[
    {"object.projection":{"name":"R","children":[
      {"source.rdb":{"@kind":"view","@view":"v_r","@sql":"SELECT 1"}},
      {"field.int":{"name":"x"}}]}}]}}`);
  const src = root.findObject("R")!.ownChildren().find(c => c instanceof MetaSource)! as MetaSource;
  expect(src.sqlBody).toBe("SELECT 1");
  expect(src.isUnmanaged).toBe(false);
});
```

- [ ] **Step 2: Run — FAIL** (`sqlBody` undefined property). `cd server/typescript/packages/metadata && bun test test/meta-source*.test.ts`
- [ ] **Step 3: Implement the two accessors** using `SOURCE_ATTR_SQL`/`SOURCE_ATTR_UNMANAGED`, narrowing `unknown`→string/boolean (no `any`).
- [ ] **Step 4: Run — PASS**, then `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(#208): TS MetaSource @sql/@unmanaged accessors`.

### Task 3: TS loader validation rules (§5.1–§5.6)

**Files:**
- Create: `server/typescript/packages/metadata/src/persistence/source/validate-source-escapes.ts` (sibling of `validate-source-roles.ts` — read that file first for the pass shape: it takes the loaded root, walks sources, pushes `LoaderError`/`LoaderWarning`)
- Modify: the loader's validation-pass registration (grep where `validateSourceRoles` is wired into the load pipeline; add `validateSourceEscapes`) + the error-code enum (`errors.ts` — add the three new codes)
- Test: `server/typescript/packages/metadata/test/validate-source-escapes.test.ts`

**Interfaces:**
- Consumes: `MetaSource.sqlBody`/`isUnmanaged` (Task 2); `MetaField.isDerived()` (existing, `meta-field.ts`) to detect `origin.*` children under a host; `SOURCE_KIND_TABLE`.
- Produces: `validateSourceEscapes(root): { errors, warnings }` wired into the load pipeline.

- [ ] **Step 1: Write the failing tests — one per rule.**

```ts
test.each([
  // [fixture, expectedCode]
  ["@sql AND @unmanaged on one source", "ERR_SQL_BODY_WITH_UNMANAGED",
    `{"source.rdb":{"@kind":"view","@view":"v","@sql":"SELECT 1","@unmanaged":true}}`],
  ["@sql on @kind:table", "ERR_SQL_BODY_ON_WRITABLE_KIND",
    `{"source.rdb":{"@table":"t","@sql":"SELECT 1"}}`],
  ["@sql empty string", "ERR_BAD_ATTR_VALUE",
    `{"source.rdb":{"@kind":"view","@view":"v","@sql":""}}`],
])("%s → %s", async (_name, code, sourceJson) => {
  const { errors } = await loadStringCollectingErrors(hostWith(sourceJson));
  expect(errors.map(e => e.code)).toContain(code);
});

test("origin.* under an @sql host → ERR_ORIGIN_UNDER_SQL_BODY", async () => {
  // a projection whose read source carries @sql AND a field with an origin.passthrough child
  const { errors } = await loadStringCollectingErrors(/* … */);
  expect(errors.map(e => e.code)).toContain("ERR_ORIGIN_UNDER_SQL_BODY");
});

test("origin.* under an @unmanaged host → WARN (not error)", async () => {
  const { errors, warnings } = await loadStringCollectingErrors(/* @unmanaged host + origin field */);
  expect(errors).toEqual([]);
  expect(warnings.map(w => w.code)).toContain("WARN_ORIGIN_UNDER_UNMANAGED");
});

test("@filter (#207) + @sql on a projection → ERR_ORIGIN_UNDER_SQL_BODY", async () => { /* … */ });
```

- [ ] **Step 2: Run — FAIL** (`validateSourceEscapes` not defined). `cd server/typescript/packages/metadata && bun test test/validate-source-escapes.test.ts`
- [ ] **Step 3: Implement `validate-source-escapes.ts`.** For each object, for each own `source.rdb`: (1) both `sqlBody` and `isUnmanaged` set → `ERR_SQL_BODY_WITH_UNMANAGED`; (2) `sqlBody` set AND `effectiveKind` is writable (`=== SOURCE_KIND_TABLE`, or `!isReadOnly()`) → `ERR_SQL_BODY_ON_WRITABLE_KIND`; (3) `@sql` present but empty/whitespace → `ERR_BAD_ATTR_VALUE`. For the host object with an `@sql` read source: any field with `isDerived()` → `ERR_ORIGIN_UNDER_SQL_BODY`; a projection `@filter` attr present → `ERR_ORIGIN_UNDER_SQL_BODY`. For an `@unmanaged` host with a derived field → push a WARN (`WARN_ORIGIN_UNDER_UNMANAGED`) not an error. Add the three `ERR_*` codes (+ the WARN code) to `errors.ts`.
- [ ] **Step 4: Run — PASS**; `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(#208): TS loader validation for @sql/@unmanaged (fail-closed rules)`.

### Task 4: The suppression rule (classify DDL-ownership before `viewIsDerived`)

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/projection/build-projection-views.ts` (the projection classification loop ~117–122 and the write-through host loop ~134–140 — read them first)
- Test: `server/typescript/packages/codegen-ts/test/projection/` (extend the projection-views test)

**Interfaces:**
- Consumes: `MetaSource.sqlBody`/`isUnmanaged` (Task 2).
- Produces: the classification loop routes an `@sql`/`@unmanaged` read source into the new branches (Tasks 5/6) BEFORE calling `viewIsDerived`/`extractViewSpec`, so an escape-valve host with `extends`-bound fields + a borrowed `identity.primary` is NEVER mis-synthesized.

- [ ] **Step 1: Write the failing test — an escape-valve projection with borrowed identity is NOT synthesized.**

```ts
test("an @sql projection with extends-bound identity does NOT get a synthesized body", () => {
  // projection R: source.rdb @kind:view @view:v_r @sql:"WITH RECURSIVE …",
  // field x extends Base.x, identity.primary extends Base.pk
  const views = buildProjectionViews(root, "postgres", "snake_case");
  const v = views.find(vv => vv.name === "v_r")!;
  expect(v.sql).toContain("WITH RECURSIVE");   // verbatim body, not a synthesized SELECT
  expect(v.columns).toBeUndefined();           // opaque — columns unknown
});
```

- [ ] **Step 2: Run — FAIL** (today `viewIsDerived` flips true → wrong synthesized SELECT, or the view is skipped). 
- [ ] **Step 3: Implement the suppression branch.** At the top of each read-only-source classification block, before `viewIsDerived`: if `readOnlySource.isUnmanaged` → `continue` (Task 6 handles skip/silencing; it produces no `ExpectedView`); else if `readOnlySource.sqlBody` → push the verbatim `ExpectedView` (Task 5's builder) and `continue`. Only if neither → the existing `viewIsDerived`/`extractViewSpec` path.
- [ ] **Step 4: Run — PASS**; `cd server/typescript/packages/codegen-ts && bun test && bun run typecheck`.
- [ ] **Step 5: Commit** `feat(#208): suppress derivation-classification for @sql/@unmanaged sources`.

### Task 5: `@sql` migrate branch — emit verbatim + fingerprint + adopt-view ceremony

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/projection/build-projection-views.ts` (the `@sql`→`ExpectedView` builder from Task 4: `name`=physicalName (FR-016), `schema`=`resolveTableSchema`, `sql`=verbatim body, `dependsOn`=tables of the host's `extends`-bound anchors, `columns` OMITTED); the matview/proc/tableFunction hard-error (D4)
- Test: `server/typescript/packages/codegen-ts/test/projection/` (golden-DDL: the `CREATE VIEW` = verbatim body) + `server/typescript/packages/integration-tests/test/view-lifecycle-pg.test.ts` (real-PG round-trip)

**Interfaces:**
- Consumes: the suppression branch (Task 4); `ExpectedView` type (`view-spec.ts`); the existing fingerprint (`buildExpectedSchema` Pass 4) + adoption gate (`diff/index.ts` `replace-view` + `allow.adoptView`).
- Produces: an `@sql` view flows through the unchanged emit/fingerprint/diff pipeline.

- [ ] **Step 1: Write the failing golden test.** Assert `emitViewDdl`/the migrate emit for the `@sql` view produces `CREATE VIEW "v_r" AS <verbatim body>` + the metaobjects COMMENT fingerprint stamp, and a SECOND migrate over the same model is a NO-OP.
- [ ] **Step 2: Write the failing PG round-trip** in `view-lifecycle-pg.test.ts`: (a) migrate an `@sql` view → emitted + stamped; (b) second migrate = empty diff; (c) pre-create an UNSTAMPED view at that name, migrate → `replace-view` blocked pending `--allow adopt-view`; with the allow flag → stamped + converges.
- [ ] **Step 3: Run — FAIL.**
- [ ] **Step 4: Implement.** The `@sql`→`ExpectedView` push (Task 4) with `columns` omitted (→ diff fails safe to gated drop+create, existing behavior). Add the D4 hard-error: if `sqlBody` is set on `effectiveKind !== "view"` (matview/proc/tableFunction), throw an actionable error ("@sql not yet migrate-managed on <kind>; mark @unmanaged or track a follow-up"). No new fingerprint/adoption code — it rides the pipeline.
- [ ] **Step 5: Run — PASS** (unit) then the PG test: `cd server/typescript/packages/integration-tests && bun test test/view-lifecycle-pg.test.ts`. **Keep the box idle during the PG testcontainer run.**
- [ ] **Step 6: Commit** `feat(#208): @sql view — emit verbatim body + fingerprint + adopt-view ceremony`.

### Task 6: `@unmanaged` migrate branch — skip create/drop/drift + act-side silencing

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/projection/build-projection-views.ts` (skip `@unmanaged` views — Task 4 `continue`) + `server/typescript/packages/migrate-ts/src/expected-schema.ts` (skip an `@unmanaged` table in Pass 1, but KEEP it in `entityToTable` so an inbound FK still resolves the physical name) + the diff (`diff/index.ts`) to accept a set of declared-unmanaged qualified names and skip `drop-view`/`drop-table` for them + the CLI (`cli/commands/migrate.ts`, `verify.ts`) to collect + thread that set
- Test: `view-lifecycle-pg.test.ts` (an `@unmanaged` object: migrate is silent; a pre-existing DB object at that name is NOT dropped; `verify --db` reports "external (declared)")

**Interfaces:**
- Consumes: `MetaSource.isUnmanaged`; the introspection + diff pipeline.
- Produces: a `collectUnmanagedNames(root): Set<string>` (qualified physical names) threaded into diff; `@unmanaged` objects excluded from both expected and act-side drop proposals.

- [ ] **Step 1: Write the failing PG test:** an `@unmanaged` view/table + a pre-existing DB object of that name → migrate diff is EMPTY (no create, no drop); `verify --db` classifies it "external (declared)".
- [ ] **Step 2: Run — FAIL** (today it either isn't skipped or surfaces as a `drop-*` proposal).
- [ ] **Step 3: Implement.** `collectUnmanagedNames` (walk sources for `isUnmanaged`, resolve `physicalName` + schema). Skip `@unmanaged` views in `build-projection-views`; skip `@unmanaged` tables in `expected-schema` Pass 1 while keeping the entity in `entityToTable` (FK target resolution). Thread the name-set into the diff so `drop-view`/`drop-table` for those names are suppressed. In `verify`, annotate the name-set entries "external (declared)".
- [ ] **Step 4: Run — PASS** (PG test), typecheck.
- [ ] **Step 5: Commit** `feat(#208): @unmanaged — skip create/drop/drift + introspection-side silencing`.

> **CHECKPOINT (Phase 1+2 = TS reference complete).** Run `/code-review high` on the cumulative TS diff; fix findings. Full TS suites green (`metadata`, `codegen-ts`, `migrate-ts`, `integration-tests`) + typecheck. This is the end-to-end TS reference; the 4-port fan-out follows.

---

## Phase 3 — 4-port validation fan-out + shared conformance

### Task 7: Java — `MetaSource` accessors + `validate-source-escapes` mirror

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/source/MetaSource.java` (add `getSqlBody()` / `isUnmanaged()` resolving accessors mirroring `getEffectiveKind()`/`getRole()`; constants `ATTR_SQL`/`ATTR_UNMANAGED`)
- Create: the Java validation mirror (find where `validateSourceRoles` runs in the Java loader `ValidationPhase`; add the same rules, same error codes)
- Test: `server/java/metadata/src/test/java/...` (a source-escapes validation test)

**Interfaces:** Consumes the Task 1 registration; produces the same 6 rules + codes as Task 3, Java-side.

- [ ] **Step 1: Write the failing test** (the 5 error cases + the WARN, mirroring Task 3's table) using the Java loader test harness (`SharedRegistryTestBase` + inline JSON).
- [ ] **Step 2: Run — FAIL.** `cd server/java && mvn -q -pl metadata test -Dtest=<name>`
- [ ] **Step 3: Implement** the accessors + the validation rules in `ValidationPhase` (mirror `validateDerivedFieldProvidability`'s structure; reuse `MetaField.isDerived()`).
- [ ] **Step 4: Run — PASS** (`-pl metadata`; delete stray `hs_err_pid*`).
- [ ] **Step 5: Commit** `feat(#208): Java @sql/@unmanaged accessors + loader validation`.

### Task 8: Python — accessors + validation mirror

**Files:**
- Modify: `server/python/src/metaobjects/meta/persistence/source/meta_source.py` (`sql_body`/`is_unmanaged`; constants) + the Python validation pass (`loader/validation_passes.py` — mirror `validate_derived_field_providability`)
- Test: `server/python/tests/` (a source-escapes validation test)

**Interfaces:** same 6 rules/codes as Task 3, Python-side.

- [ ] **Step 1: Write the failing test** (error cases + WARN) with `load_string`.
- [ ] **Step 2: Run — FAIL.** `cd server/python && .venv/bin/python -m pytest tests -q -k source_escape`
- [ ] **Step 3: Implement** the accessors + rules (reuse `MetaField.is_derived()`).
- [ ] **Step 4: Run — PASS** (scoped; the full suite in the final gate).
- [ ] **Step 5: Commit** `feat(#208): Python @sql/@unmanaged accessors + loader validation`.

### Task 9: C# — accessors + validation mirror

**Files:**
- Modify: `server/csharp/MetaObjects/Meta/MetaSource.cs` (`SqlBody`/`IsUnmanaged`; constants) + the C# validation pass (mirror the existing source-role validation)
- Test: `server/csharp/MetaObjects.Tests/...` (a source-escapes validation test)

**Interfaces:** same 6 rules/codes as Task 3, C#-side.

- [ ] **Step 1: Write the failing test** (error cases + WARN).
- [ ] **Step 2: Run — FAIL.** `cd server/csharp && dotnet test <metadata test project>`
- [ ] **Step 3: Implement** the accessors + rules (reuse `MetaField.IsDerived()`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(#208): C# @sql/@unmanaged accessors + loader validation`.

### Task 10: Shared conformance error-fixtures + Kotlin verification + cross-port divergence review

**Files:**
- Create: `fixtures/conformance/error-sql-body-with-unmanaged/`, `error-sql-body-on-writable-kind/`, `error-origin-under-sql-body/`, and a positive `source-sql-escape/` (input + expected error-code / expected canonical) — the shape other `error-*` conformance fixtures use (inspect one first)
- Verify only (no code): Kotlin rides Java's JVM registry + validation — run `codegen-kotlin`/`integration-tests-kotlin` to confirm green

**Interfaces:** these shared fixtures run in all 5 ports — land them ONLY now that Tasks 1/3/7/8/9 make every port validate (else the laggards red).

- [ ] **Step 1: Add the conformance fixtures** (each: an input metadata + the expected error code set, using the legacy code-set form like #207's `error-projection-filter-*`).
- [ ] **Step 2: Run all five conformance corpora green** (sequential): TS `metadata`, Java `-pl metadata`, Python `pytest tests/conformance`, C# metadata tests, Kotlin (`mvn -q -pl codegen-kotlin test` + `-pl integration-tests-kotlin` if it runs conformance).
- [ ] **Step 3: Cross-port divergence review.** Dispatch a report-only auditor (general-purpose) comparing each port's `validate-source-escapes` against the TS reference (Task 3): do all 5 emit the same code for each rule; is the WARN vs error split (origins under `@unmanaged` vs `@sql`) identical; any port using own-only vs resolving accessors wrongly. Fix any divergence.
- [ ] **Step 4: Commit** `test(#208): shared conformance error-fixtures + cross-port validation parity`.

---

## Phase 4 — ADR + docs

### Task 11: ADR-0043 + docs rewrites

**Files:**
- Create: `spec/decisions/ADR-0043-ddl-ownership-escape-valves.md` (Nygard format: context = the RDB-specific escape from the backend-agnostic origin mandate; decision = one axis / two attrs / ADR-0037 attribute rationale / suppression rule / TS-only lowering; consequences = adopt-view ceremony, matview deferral)
- Modify: `agent-context/skills/metaobjects-verify/references/migration.md` (rewrite the "There is no attribute that injects hand-written SQL … (by design)" statement to document `@sql`/`@unmanaged` + the `--allow adopt-view` flow) + `docs/features/downstream-metadata-decisions.md` (the hand-write exception) + `CHANGELOG.md` `[Unreleased]`
- Modify: `spec/roadmap.md` (mark #208 done; file the two deferred follow-ups — matview managed path, opaque-body column-name verification)

- [ ] **Step 1: Write ADR-0043** (context/decision/consequences per the spec §3/§6/§7).
- [ ] **Step 2: Rewrite the migration + downstream docs** to describe both attrs + the adoption ceremony; add the CHANGELOG entry.
- [ ] **Step 3: Leak-scan + commit** `docs(#208): ADR-0043 + migration/verify docs for @sql/@unmanaged`.

---

## Self-review notes

- **Spec coverage:** §3 vocab → Task 1/2/7/8/9; §5 validation (6 rules) → Task 3 (TS) + 7/8/9 (ports) + Task 10 (shared fixtures); §6 suppression → Task 4; §7 migrate (`@sql` + `@unmanaged`) → Task 5/6; §8 verify → Task 5/6 (fingerprint drift + external annotation); §4 cross-port scope → Task 1 (registration) + 7/8/9 (validation); §9 ADR/docs → Task 11; §10 build order → Phases 1→4; §11 YAGNI cuts → the D4 hard-error (Task 5) keeps matview/proc out of the lowering.
- **Registration-coupling guard:** Task 1 lands the attr in all 5 ports + `expected-registry.json` atomically; Task 10 lands the shared `fixtures/conformance/` error-fixtures only after all ports validate — the two places a partial change would red a laggard.
- **Type consistency:** `sqlBody`/`isUnmanaged` (TS), `getSqlBody`/`isUnmanaged` (Java), `sql_body`/`is_unmanaged` (Python), `SqlBody`/`IsUnmanaged` (C#) — per-port idiomatic names for the same two accessors; `ERR_SQL_BODY_WITH_UNMANAGED` / `ERR_SQL_BODY_ON_WRITABLE_KIND` / `ERR_ORIGIN_UNDER_SQL_BODY` used identically in Tasks 3/7/8/9/10.
