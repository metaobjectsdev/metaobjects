# SP-B Generated-API Conformance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`.

**Goal:** Prove the **generated** TS REST routes (the deployed artifact) implement the api-contract over HTTP, in a CI-gated lane alongside the retained hand-rolled reference; and make the plain `runtime-ts/fastify` mount helper contract-complete.

**Architecture:** Reuse the server-agnostic api-contract runner (`loadScenarios`/`assertResponse`/`executeRequests`). New lane: `runGen` the Author routes into a temp dir → dynamically import + mount the generated routes on Fastify+Drizzle+pg testcontainer → drive the SAME corpus. TS pilot; fan-out to other 4 ports documented as a follow-on.

**Tech stack:** TS (bun, codegen-ts `runGen`, runtime-ts drizzle-fastify + fastify, Drizzle, Fastify, pg testcontainer). Design: `docs/superpowers/specs/2026-05-31-sp-b-generated-api-conformance-design.md`.

**Worktree:** `<repo-root>/.claude/worktrees/sp-b-generated-api` (branch `sp-b-generated-api`, off origin/main).

---

### Unit 1: Generated-server conformance lane (headline)

**Files:**
- Create: `server/typescript/packages/integration-tests/src/api-contract-generated-server.ts` — boots the GENERATED routes.
- Create: `server/typescript/packages/integration-tests/test/api-contract-generated.test.ts` — the new lane.
- Reuse (no change): `src/api-contract-scenario.ts` (`loadScenarios`/`assertResponse`), `src/postgres-container.ts`, `src/postgres-sql.ts`, `fixtures/api-contract-conformance/`.
- Reference (do not modify): `src/api-contract-server.ts` (hand-rolled), `test/api-contract.test.ts`, `codegen-ts/test/golden/golden-output.test.ts` (the `runGen`-into-temp pattern).

- [ ] **Step 1 — Study the runGen pattern + the generated route shape.** Read `codegen-ts/test/golden/golden-output.test.ts` (how it calls `runGen({ config: defineConfig({ outDir, dbImport, dialect, generators: [entityFile(), routesFile(), ...] }) })` into a temp dir) and a generated `*.routes.ts` golden snapshot (it exports `<entity>Routes(fastify)` calling `mountCrudRoutes` from `@metaobjectsdev/runtime-ts/drizzle-fastify`, importing `db` from `dbImport` and the entity artifacts from `./<Entity>`). Read `api-contract-server.ts` to see the `ServerHandle` shape (`fastify`, `applySeed(rows)`, `truncate()`, `close()`, `baseUrl`) the runner expects, and `api-contract.test.ts` for how `executeRequests` is driven.
- [ ] **Step 2 — Write the harness `api-contract-generated-server.ts`.** Export `startGeneratedServer(connectionUri, root): Promise<ServerHandle>` that:
  - Runs `runGen` against the corpus `Author` metadata into a `mkdtempSync` temp dir, dialect `postgres`, generators `[entityFile(), routesFile()]`, `dbImport` set to a module the harness controls (see Step 3).
  - Creates a Drizzle(`pg`) instance bound to `connectionUri` (the testcontainer), exposed via the `dbImport` module so the generated route's `import { db }` resolves to it.
  - Provisions the `authors` table (use the corpus `meta.json`→DDL path already used by the hand-rolled server, or the generated Drizzle schema + a CREATE; match the table/columns the hand-rolled server uses so seeds line up).
  - Dynamically `import()`s the emitted `Author.routes.ts`, creates a Fastify instance, `await fastify.register(authorRoutes)` (or calls the exported mount fn), `await fastify.ready()`.
  - Returns `{ fastify, applySeed, truncate, close }` mirroring the hand-rolled `ServerHandle` (reuse the seed/truncate SQL helpers from `api-contract-server.ts` or `postgres-sql.ts` — DRY, don't duplicate the SQL).
- [ ] **Step 3 — Resolve the `dbImport`.** The generated route imports `db` from the configured `dbImport`. Set `dbImport` to an absolute path of a tiny harness module the test writes/owns (e.g. write a `db.ts` into the temp dir next to `Author.routes.ts` that re-exports a Drizzle instance the harness injects, OR configure `dbImport` to a fixture module path). Choose the approach that lets Bun dynamic-import the emitted route file unmodified. Document the choice in a comment.
- [ ] **Step 4 — Write the test `api-contract-generated.test.ts`.** Mirror `api-contract.test.ts` structure (one test per scenario, fresh pg testcontainer per scenario, seed/truncate, `executeRequests`) but call `startGeneratedServer` instead of `startServer`. `describe("api contract conformance — TS GENERATED routes runner")`.
- [ ] **Step 5 — Run + fix real bugs.** `cd server/typescript && bun test packages/integration-tests/test/api-contract-generated.test.ts 2>&1 | tail -30`. All 20 scenarios must pass byte-exact. If a scenario fails, it is a real divergence between the generated artifact and the contract — fix it in `codegen-ts/routesFile` or `runtime-ts/drizzle-fastify` (NOT by relaxing the test or editing the generated file by hand). Report any such bug found + fixed.
- [ ] **Step 6 — Commit.** `feat(conformance): SP-B Unit 1 — run GENERATED TS routes over HTTP against the api-contract corpus`

### Unit 2: Close the plain `runtime-ts/fastify` mount gaps

**Files:**
- Modify: `server/typescript/packages/runtime-ts/src/fastify/index.ts` (or the per-verb files it delegates to) — add `withCount` + `invalid_sort` 400.
- Reference: `server/typescript/packages/runtime-ts/src/drizzle-fastify/mount-read-only.ts` (the semantics to mirror: `withCount` → `{ rows, total }` envelope; sort validated against allowlist → 400 `invalid_sort`).
- Test: `server/typescript/packages/runtime-ts/test/` (find the fastify-mount tests; add cases).

- [ ] **Step 1 — Failing test.** Add unit tests to the runtime-ts fastify-mount test file asserting: (a) `GET {path}?withCount=1` returns `{ rows, total }`; (b) `GET {path}?sort=<not-in-allowlist>` returns 400 with `invalid_sort`. Run; confirm they FAIL (plain mount lacks both).
- [ ] **Step 2 — Add `withCount`.** In the plain fastify list handler, when `?withCount=1` (truthy-flag parse — mirror `isTruthyFlag` from drizzle-fastify), return `{ rows, total }` where `total` is the unpaginated count via the ObjectManager (add a count path if needed). Default (no flag) returns the bare rows array, unchanged.
- [ ] **Step 3 — Add `invalid_sort` 400.** The plain mount needs a `sortAllowlist` option (mirror `CrudRoutesOptions` → add `sortAllowlist?`). Validate `?sort=field:dir` against it; unknown field → `reply.code(400).send({ error: "invalid_sort", ... })`. Match the error shape the corpus `invalid-sort-400.yaml` expects (check the scenario's `expect.body`).
- [ ] **Step 4 — Verify.** The new unit tests pass; `cd server/typescript && bun test packages/runtime-ts` green (no regression). Confirm the plain mount's `withCount`/`invalid_sort` semantics match drizzle-fastify byte-for-byte where the contract overlaps.
- [ ] **Step 5 — Commit.** `feat(runtime-ts): plain fastify mount — withCount + invalid_sort 400 (contract parity with drizzle-fastify)`

### Unit 3: CI gate + fan-out documentation

**Files:**
- Modify: `.github/workflows/integration-tests.yml` (ensure the new generated-server lane runs — likely automatic if it runs under the same `bun test packages/integration-tests` invocation; verify the workflow picks up the new test file).
- Modify: `fixtures/api-contract-conformance/README.md` (document the two lanes + the fan-out follow-on).

- [ ] **Step 1 — Verify CI coverage.** Inspect `integration-tests.yml`: confirm the TS integration step runs the whole `packages/integration-tests` suite (so `api-contract-generated.test.ts` is included) on PRs + pushes-to-main. If it targets specific files, add the new test. Confirm no separate opt-in is needed.
- [ ] **Step 2 — Document the two lanes + fan-out.** In `fixtures/api-contract-conformance/README.md`, add a short section: (a) the corpus is now driven by BOTH the hand-rolled reference lane AND the generated-routes lane (TS); (b) a "Fan-out follow-on" listing the per-port generated-server harness for Java/Kotlin Spring (Spring Boot test context + generated `@RestController`), C# ASP.NET (`WebApplicationFactory` + generated minimal-API), Python FastAPI (`TestClient` + generated router) — so the remaining ports' deployed artifacts get the same over-HTTP verification. State plainly that those 4 are not yet covered by the generated lane (no silent gap).
- [ ] **Step 3 — Commit.** `docs(conformance): SP-B Unit 3 — gate the generated-routes lane + document the per-port fan-out`

### Unit 4: Cross-cutting review + finish

- [ ] **Step 1 — Final review.** Dispatch the simplifier + a final code-reviewer over the whole SP-B diff (focus: does the generated lane genuinely import + run the EMITTED route file unmodified — i.e. is it testing the real artifact, not a re-implementation? is the hand-rolled lane untouched? are the plain-fastify gaps closed with byte-matching semantics?).
- [ ] **Step 2 — Finish.** Merge forward to origin/main (FF). Update memory.

## Self-review notes
- The lane MUST import the emitted route file unmodified (not re-call `mountCrudRoutes` itself) — otherwise it tests a re-implementation, not the generated artifact. The `dbImport` resolution is the enabling trick.
- If the generated server passes all 20 with NO routesFile/runtime fix needed, that's a valid outcome (it proves the artifact is already correct) — report it as such; don't manufacture a fix.
- Unit 2 is independent of Unit 1 (different package) — but keep both in this sub-project since both are "TS generated/shipped API completeness."
- Do not let the temp-dir codegen leak (clean up with `rmSync` in `finally`, like the golden test).
