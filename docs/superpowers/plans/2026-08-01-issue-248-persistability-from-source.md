# Persistability from source presence (#248) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Derive every "database thing" decision from declared/inherited `source.*` presence instead of object-subtype name compares: `buildExpectedSchema` Pass 1 stops emitting phantom `CREATE TABLE`/FK targets for sourceless objects (#248), and the codegen queries/routes/API-doc tier stops emitting broken DB-bound artifacts for them.

**Architecture:** Two npm packages. (A) `migrate-ts`: Pass 1 collapses the `subType === "value"` compare + read-only-only skip into one rule — *table iff a writable source is declared/inherited* (`if (!hasWritableSource) continue;`); FK maps, drift, and `meta verify --db/--d1` are fixed transitively. (B) `codegen-ts`: new `hasAnyRdbSource` helper (sibling of `hasWritableRdbSource` in `source-detect.ts`); the queries/routes/hono/api-model filters gain it as a conjunct, replacing (queries/api-model) or supplementing (routes/hono, which had NO persistence gate) the subtype compare; the ADR-0034 reference templates get the same swap. Value objects are subsumed exactly: the loader's value-purity pass bans sources on the RESOLVING view (`metadata/src/subtype-rules.ts:99-137`), so no loadable value has an effective source.

**Tech Stack:** TypeScript (bun test), `@metaobjectsdev/metadata` loader + `composeRegistry` test providers, Testcontainers PG/Docker for the integration gates.

**Design spec:** `docs/superpowers/specs/2026-08-01-issue-248-persistability-from-source-design.md`

## Global Constraints

- **Byte-identity guardrail:** for a model where every table-owning object declares/inherits a source (the norm), `meta migrate`/`meta verify` output is byte-identical and NO emitted `meta gen` file's CONTENT changes — the only permitted delta is that files importing non-existent exports (never typechecked) stop being emitted. Any other output change is a task failure.
- **Versioning:** npm-only PATCH. Changed product packages: `migrate-ts`, `codegen-ts` ONLY. No `metadata` package change, no CLI flag changes, no cross-port files.
- **Named constants:** the fix DELETES the inline `"value"` literal in `expected-schema.ts:142`; do not introduce new inline metamodel strings anywhere.
- **ADR-0039:** the persistability predicates read RESOLVING `children()` (an entity may inherit `source.rdb` via `extends`); keep the existing own-source read for the `@unmanaged` branch and its comment. Any own/resolving choice carries its sanctioned-case comment.
- **Tests:** never a bare `bun test` at repo root. Scope: `cd server/typescript && bun test packages/<pkg>` (picks up `server/typescript/bunfig.toml` preload).
- **Git:** stage explicit paths only, NEVER `git add -A`. Commit to branch `fix/248-persistability-from-source`.
- **Public-repo hygiene:** fixtures/tests use `acme::*` packages and generic names (`Order`, `Ghost`, `WireNote`); no private/other-project names, no absolute home paths in committed files or commit messages.

---

### Task 1: migrate-ts — Pass 1 persistability from writable-source presence

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts` (Pass 1, `:125-168`: the skip-list comment block, line `:142`, lines `:147-154`)
- Create: `server/typescript/packages/migrate-ts/test/expected-schema-persistability.test.ts`

**Interfaces:**
- Consumes: `MetaSource.isWritable()` (already imported at `expected-schema.ts:13`); `MetaDataLoader` + `InMemoryStringSource` (test pattern: `test/expected-schema-schema-aware.test.ts:5-10`); `composeRegistry`/`coreProviders`/`TypeRegistry`/`TypeId`/`MetaObject` from `@metaobjectsdev/metadata` (custom-provider pattern: `metadata/test/child-placement-enforcement.test.ts:142`; `TypeDefinition`/`ChildRule` shapes: `metadata/src/registry.ts:24-120`).
- Produces: `buildExpectedSchema` that skips any object without a declared/inherited writable source — consumed transitively by `meta migrate`, `computeDrift[FromActual]` (`src/drift/drift.ts`), and Task 4's gates. No signature changes.

- [ ] **Step 1: Write the failing tests.** In `expected-schema-persistability.test.ts`, load models via the `loadJson` helper pattern (default registry unless noted), all in package `acme::probe`:
  1. **Sourceless entity co-load:** `Order` (`field.long id`, `field.string ref`, `source.rdb @table:"orders"`, `identity.primary`) + `Ghost` (`field.long id`, `field.string note`, `identity.primary`, NO source). Assert `snapshot.tables.map(t => t.name)` is exactly `["orders"]`.
  2. **No fabricated FK target:** same model + on `Order` a `field.long ghostId` and `identity.reference` `@fields:["ghostId"] @references:"Ghost"`. Assert the `orders` table has `foreignKeys` length 0 (no FK against a fabricated `ghosts` name) and `buildExpectedSchema` does not throw.
  3. **Custom subtype (the reported scenario):** build a loader with `composeRegistry([...coreProviders, wireProvider])` where `wireProvider` (`id: "test-wire-messages"`, `dependencies: ["metaobjects-core-types"]`) registers `typeId: new TypeId(TYPE_OBJECT, "message")`, `factory: (t, n) => new MetaObject(t, n)`, `childRules: [{ childType: TYPE_FIELD, childSubType: "*", childName: "*" }]`, `attributes: []`. Load `Order` (as above) + `object.message` `WireNote` (two fields, no source). Assert tables are exactly `["orders"]`. (If the FR-033 child-side placement pass rejects `field.*` under `object.message` despite the parent-side childRule, extend the provider per the pattern in `metadata/test/child-placement-enforcement.test.ts` — the fixture's point is only "custom subtype, no source, no table".)
  4. **Inherited writable source still persists:** abstract `object.entity` `Base` carrying `source.rdb @table:"things"` + `identity.primary` + `field.long id`; concrete `Thing extends Base` with one own field. Assert exactly `["things"]` (resolving-children read; also pins that the ABSTRACT skip still precedes the source rule).
- [ ] **Step 2: Run to verify RED.** Run: `cd server/typescript && bun test packages/migrate-ts/test/expected-schema-persistability.test.ts`. Expected failures: test 1 receives `["orders", "ghosts"]`; test 2 finds an FK with `refTable: "ghosts"`; test 3 receives `["orders", "wire_notes"]`. Test 4 should already pass (pin).
- [ ] **Step 3: Implement.** In `expected-schema.ts` Pass 1:
  - Delete line `:142` (`if (child.subType === "value") continue;`).
  - Replace `:147-154` (the `hasReadOnlySource`/`hasWritableSource` pair + projection skip) with the single rule — keep the existing `hasWritableSource` computation, delete the now-dead `hasReadOnlySource`:
    ```ts
    // #248 — persistability derives from source presence, never subtype (loader
    // contract: zero sources ⇒ not persisted — metadata validate-source-roles).
    // Table iff a WRITABLE source is declared or inherited (ADR-0039 resolving).
    // Subsumes the old `subType === "value"` skip (value purity bans sources on
    // the resolving view) and the read-only-only projection skip (view pipeline
    // owns those); closes the fail-open where a sourceless object (custom
    // subtype or plain entity) got a phantom CREATE TABLE + fabricated FK name.
    const hasWritableSource = child.children().some(
      (c) => c instanceof MetaSource && c.isWritable(),
    );
    if (!hasWritableSource) continue;
    ```
  - Update the Pass 1 skip-list comment block (`:125-130`) to name the new rule.
  - Leave untouched: `:140` (TYPE_OBJECT), `:141` (isAbstract), `:145` (isTphSubtype), `:155` (`resolveTableName`), `:161-167` (`@unmanaged` own-source branch).
- [ ] **Step 4: Run the new test — expect GREEN.** Same command as Step 2.
- [ ] **Step 5: Full migrate-ts unit/emit suite for byte-identity.** Run: `cd server/typescript && bun test packages/migrate-ts` (excludes nothing; Docker-dependent integration files skip if the engine is absent — they run in Task 4). Expected: all green — in particular the existing value-skip (`test/unit/expected-schema.test.ts:447`), TPH (`test/expected-schema-tph.test.ts`), `@unmanaged`/#208, and view/diff suites unchanged.
- [ ] **Step 6: Commit.**
```bash
git add server/typescript/packages/migrate-ts/src/expected-schema.ts \
        server/typescript/packages/migrate-ts/test/expected-schema-persistability.test.ts
git commit -m "fix(#248): migrate-ts derives table persistability from writable-source presence, not subtype"
```

---

### Task 2: codegen-ts — `hasAnyRdbSource` + queries/routes/hono/api-model filter rederivation

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/source-detect.ts` (add `hasAnyRdbSource`)
- Modify: `server/typescript/packages/codegen-ts/src/index.ts` (`:97` — export it beside `hasWritableRdbSource`)
- Modify: `server/typescript/packages/codegen-ts/src/generators/queries-file.ts` (`:15-22` `skipNonQueryable`)
- Modify: `server/typescript/packages/codegen-ts/src/generators/routes-file.ts` (`:26-28` filter)
- Modify: `server/typescript/packages/codegen-ts/src/generators/routes-file-hono.ts` (`:34` filter)
- Modify: `server/typescript/packages/codegen-ts/src/generators/api-model.ts` (`:337-349` `isQueryable`)
- Create: `server/typescript/packages/codegen-ts/test/sourceless-objects.test.ts`

**Interfaces:**
- Consumes: `MetaSource`/`TYPE_SOURCE`/`SOURCE_SUBTYPE_RDB` (as `hasWritableRdbSource` does, `source-detect.ts:9-11`); `runGen` (probe pattern: config `{ outDir, dialect: "postgres", dbImport: "./db", generators: [...] }`, `write: false` is unsupported for content capture — write to a bun `tmpdir` and read files back, or assert on the returned `files[].path` set plus on-disk content).
- Produces: exported `hasAnyRdbSource(entity: MetaObject): boolean` — TRUE iff resolving `children()` contains ≥1 `source.rdb` `MetaSource` of ANY kind. Consumed by Task 3's reference templates.

- [ ] **Step 1: Write the failing test.** In `sourceless-objects.test.ts`, load (default registry, package `acme::probe`): `Order` (sourced entity, as Task 1), `Money` (`object.value`, two fields), `Ghost` (entity, `identity.primary`, NO source). Run `runGen` with `[entityFile(), queriesFile(), routesFile(), routesFileHono()]` into a temp dir. Assert:
  - Emitted path set INCLUDES `Order.ts`, `Order.queries.ts`, `Order.routes.ts`, the Order hono file, `Money.ts`, `Ghost.ts`.
  - Emitted path set EXCLUDES `Ghost.queries.ts`, `Ghost.routes.ts`, `Money.queries.ts`, `Money.routes.ts`, and both hono files for `Money`/`Ghost`.
  - **Content no-churn pin:** run `runGen` a second time on a model containing ONLY `Order`; assert `Order.ts` / `Order.queries.ts` / `Order.routes.ts` contents are byte-identical between the two runs.
  - **Projection still queryable pin:** a read-only-source projection (model on an existing projection test fixture in `codegen-ts/test`) still gets its queries/routes files.
- [ ] **Step 2: Run to verify RED.** Run: `cd server/typescript && bun test packages/codegen-ts/test/sourceless-objects.test.ts`. Expected: EXCLUDES assertions fail — today `Ghost.queries.ts`, `Ghost.routes.ts`, `Money.routes.ts` and hono files ARE emitted (empirically confirmed during design).
- [ ] **Step 3: Implement.**
  - `source-detect.ts`: add beside `hasWritableRdbSource` (same iteration, drop the `isWritable()` gate):
    ```ts
    /** True when the object declares (or inherits via extends — ADR-0039 resolving)
     *  at least one source.rdb child of ANY kind. Zero sources ⇒ not backed by any
     *  store (loader contract, validate-source-roles): no DB-bound artifacts. */
    export function hasAnyRdbSource(entity: MetaObject): boolean { ... }
    ```
  - `index.ts:97`: export it.
  - `queries-file.ts`: `skipNonQueryable = (e) => hasAnyRdbSource(e) && !isTphSubtype(e);` (drop the `OBJECT_SUBTYPE_VALUE` import if now unused); update the comment: values are subsumed (no source, loader-enforced), sourceless objects newly skipped.
  - `routes-file.ts:26-28`: filter becomes `e.attr(CODEGEN_ATTR_EMIT_ROUTES) !== false && hasAnyRdbSource(e) && !isTphSubtype(e) && userFilter(e)`.
  - `routes-file-hono.ts:34`: add the `hasAnyRdbSource(e)` conjunct (do NOT add TPH logic — pre-existing, out of scope).
  - `api-model.ts` `isQueryable`: `hasAnyRdbSource(obj) && !isTphSubtype(obj)`; update its mirror comment (it documents itself as the queries-filter mirror).
- [ ] **Step 4: Run the new test — expect GREEN.** Same command as Step 2.
- [ ] **Step 5: Package suite + golden gate (byte-identity).** Run: `cd server/typescript && bun test packages/codegen-ts` AND explicitly `cd server/typescript/packages/codegen-ts && bun test test/golden/` (the golden gate lives outside default attention; the corpus has no sourceless objects/top-level values with routes, so expected result is green-UNCHANGED — any snapshot diff is a stop-and-review signal, not an auto-regen).
- [ ] **Step 6: Commit.**
```bash
git add server/typescript/packages/codegen-ts/src/source-detect.ts \
        server/typescript/packages/codegen-ts/src/index.ts \
        server/typescript/packages/codegen-ts/src/generators/queries-file.ts \
        server/typescript/packages/codegen-ts/src/generators/routes-file.ts \
        server/typescript/packages/codegen-ts/src/generators/routes-file-hono.ts \
        server/typescript/packages/codegen-ts/src/generators/api-model.ts \
        server/typescript/packages/codegen-ts/test/sourceless-objects.test.ts
git commit -m "fix(#248): codegen-ts gates queries/routes/api-model on source presence, not subtype"
```

---

### Task 3: reference (scaffold-and-own) templates get the same derived filter

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/reference/queries.ts` (`:108-111` `skipNonQueryable`)
- Modify: `server/typescript/packages/codegen-ts/src/reference/routes.ts` (`:40-44` filter)
- Modify: `server/typescript/packages/codegen-ts/test/sourceless-objects.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's exported `hasAnyRdbSource` — the reference templates import ONLY `@metaobjectsdev/codegen-ts` (ADR-0034: a copied file must work verbatim in a consumer repo), so both must import it from the package root, NOT a relative path.
- Produces: fixed scaffolds for future `meta init` runs (`cli/src/commands/init.ts:281-293` copies `src/reference/*.ts` verbatim via `readReferenceTemplate`). Existing consumers own their copies — no propagation, per the design spec §7.

- [ ] **Step 1: Extend the failing test.** In `sourceless-objects.test.ts`, add a second `runGen` pass over the same Order/Money/Ghost model using the REFERENCE generators (`import { queriesFile as refQueries } from "../src/reference/queries.js"`, same for routes — they are importable TS in-repo even though excluded from the tsc build). Assert the same INCLUDES/EXCLUDES sets as Task 2 Step 1.
- [ ] **Step 2: Run to verify RED.** `cd server/typescript && bun test packages/codegen-ts/test/sourceless-objects.test.ts` — the reference-generator EXCLUDES assertions fail.
- [ ] **Step 3: Implement.** Swap both reference filters to `hasAnyRdbSource(e) && !isTphSubtype(e)` (queries) / add the `hasAnyRdbSource(e)` conjunct (routes), importing `hasAnyRdbSource` from `@metaobjectsdev/codegen-ts`; update the header comments (these files are consumer-facing documentation).
- [ ] **Step 4: Run — expect GREEN**, then the cli suite (init scaffolds + config wiring consume these assets): `cd server/typescript && bun test packages/cli`.
- [ ] **Step 5: Commit.**
```bash
git add server/typescript/packages/codegen-ts/src/reference/queries.ts \
        server/typescript/packages/codegen-ts/src/reference/routes.ts \
        server/typescript/packages/codegen-ts/test/sourceless-objects.test.ts
git commit -m "fix(#248): reference scaffold generators derive queryability from source presence"
```

---

### Task 4: guardrail gates — integration suites, typecheck, workspace build

**Files:** none modified (verification-only; any failure loops back into Tasks 1-3).

**Interfaces:** consumes Docker (Testcontainers PG) locally; the slow-lane suites CI won't run on this PR.

- [ ] **Step 1: migrate-ts real-engine round-trips** (emit → apply → introspect → re-diff EMPTY must hold unchanged): `cd server/typescript && bun test packages/migrate-ts/test/integration` (Docker running). Expected: green, byte-identical behavior for sourced models.
- [ ] **Step 2: the SEPARATE integration-tests package** (the known trap — only slow CI runs it): `cd server/typescript && bun test packages/integration-tests/test/view-lifecycle-pg.test.ts packages/integration-tests/test/view-lifecycle-sqlite.test.ts`. Then the package's remaining suite: `cd server/typescript && bun test packages/integration-tests`.
- [ ] **Step 3: remaining server packages that consume the changed ones:** `cd server/typescript && bun test packages/cli packages/runtime-ts packages/codegen-ts-react packages/codegen-ts-tanstack`.
- [ ] **Step 4: workspace typecheck + build** (bun test does NOT typecheck; the pre-push hook gates on this): from repo root, `bun run --filter '*' build && bun run --filter '*' typecheck`. Expected: green.
- [ ] **Step 5: no commit** (nothing changed); record pass/fail evidence in the task report.

---

### Task 5: CHANGELOG + follow-up ledger

**Files:**
- Modify: `CHANGELOG.md` (new `[Unreleased]` npm-only section, or fold into the current one if release scoping demands — coordinate with whatever is unreleased at execution time)

**Interfaces:** none downstream; the design spec §9 holds the follow-up issue list (loader validation for enforced refs → non-persisted targets; cross-port codegen audit; client hook parity; migrate/verify scope filter) for the maintainer to file — do NOT file issues from this plan.

- [ ] **Step 1: Write the CHANGELOG entry.** npm-only PATCH, `### Fixed` — cover: (a) phantom `CREATE TABLE`/FK-target for sourceless objects in `meta migrate`/`meta verify --db|--d1` (the 155-object custom-subtype scenario, genericized); (b) codegen no longer emits queries/routes (Fastify + Hono) or api-docs CRUD for a sourceless object — including the pre-existing value-object routes fail-open; (c) the byte-identity statement (well-formed models unchanged; only never-compilable files stop being emitted); (d) the migration note: a DB/snapshot already holding phantom tables will now correctly propose `DROP TABLE`, gated behind `--allow drop-table`; stale broken generated files are not auto-pruned. Reference the loader contract (zero sources ⇒ not persisted) as the pre-existing invariant this aligns to.
- [ ] **Step 2: Hygiene scan.** Re-read the staged diff for private names/absolute paths (`scripts/ci-local.sh --quick` covers the leak scan).
- [ ] **Step 3: Commit.**
```bash
git add CHANGELOG.md
git commit -m "docs(#248): changelog — persistability derives from source presence (npm-only patch)"
```
