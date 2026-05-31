# SP-B — Generated-API Conformance (run the deployed artifact over HTTP)

**Date:** 2026-05-31
**Status:** Designed (user-approved key decisions; user waived spec-review gate — "keep going")
**Relates to:** enterprise-readiness program (DO-NOW #2). Gating via `fixtures/api-contract-conformance/`.

## Problem

The api-contract conformance corpus verifies the cross-port REST contract (URL grammar + wire format) by spinning up an HTTP server per scenario and asserting each response. But every port drives a **hand-rolled `AuthorApiServer`**, not the **generated** routes/controllers a user actually deploys. The generated route *code* is golden-snapshot tested (structure), but it is **never executed over HTTP against the contract**.

This is an asymmetry with the *persistence* conformance, which runs each port's **real** runtime (ObjectManager) against hand-authored expects. The api-contract corpus is the one place a hand-rolled stand-in substitutes for the real artifact. For an enterprise adopter, the generated controller **is** the deployed artifact — if it silently diverges from the contract (e.g. misses `withCount`, returns the wrong status on an invalid sort), the conformance suite's "guarantee" doesn't cover what they ship.

Secondary finding: TS ships **two** Fastify mount helpers. The **generated** routes import `mountCrudRoutes` from `@metaobjectsdev/runtime-ts/drizzle-fastify`, which **is** contract-complete (`withCount` + sort/filter-allowlist `400` + `invalid_id`). The separately-shipped plain `@metaobjectsdev/runtime-ts/fastify` (ObjectManager-based) mount **lacks** `withCount` and the `invalid_sort` 400 — a non-Drizzle consumer using that public helper gets a non-conformant API.

## Decisions (locked with user)

- **Run the generated server over HTTP against the corpus, AND keep the hand-rolled reference** (additive two-lane). The hand-rolled lane remains an independent contract reference; the new lane proves the *deployed artifact* matches the same hand-authored expects. (Retiring the hand-rolled lane as redundant is a future option, not now.)
- **Pilot TypeScript now; fan out to Java/Kotlin/C#/Python as a tracked follow-on.** The Spring / ASP.NET / FastAPI in-harness servers are a heavier lift than TS Fastify; prove the pattern on the reference port first (which is also where the shipped-helper gap lives).

## Architecture

The corpus YAML (`fixtures/api-contract-conformance/scenarios/*.yaml`) is the language-agnostic spec — hand-authored request→expect pairs. The existing runner (`api-contract-scenario.ts`: `loadScenarios` / `assertResponse`) is server-agnostic: it drives any HTTP server and asserts responses. The new lane reuses that runner verbatim; only the *server under test* changes.

**Generated-server lane (the deployed artifact):**
1. Run the real codegen (`runGen` from `@metaobjectsdev/codegen-ts`, the same entry the golden test uses) against the corpus `meta.json` (the `Author` entity) into a temp dir, dialect `postgres`, generators `[entityFile(), routesFile()]` (+ whatever `routesFile` needs), with `dbImport` pointed at a harness-provided db module.
2. Dynamically `import()` the emitted `Author.ts` (Drizzle table + Zod insert/update schemas + filter/sort allowlists) and `Author.routes.ts` (which calls `drizzle-fastify` `mountCrudRoutes`).
3. Mount `authorRoutes(fastify)` on a Fastify instance backed by a Drizzle(`pg`) connection to the per-scenario Postgres testcontainer; provision the table via the corpus DDL / generated schema; expose a `ServerHandle`-shaped object (`fastify`, `applySeed`, `truncate`, `close`) so the existing `executeRequests` drives it.
4. Walk the SAME `scenarios/*.yaml` and assert against the SAME `expect:` the hand-rolled lane uses → byte-identical contract behavior from the generated artifact.

**Import-resolution note:** the generated route file imports `db` from the configured `dbImport` and the entity from `./Author`. The harness sets `dbImport` to a real module path (absolute, or a fixture module exporting the Drizzle instance bound to the testcontainer) so the dynamic import resolves under Bun; the relative `./Author` import resolves within the temp dir. This is the crux of "test what we generate" — the emitted file is imported and run unmodified.

## Implementation units

Each unit ends with the simplify + review gate; the sub-project merges forward once.

- **Unit 1 — Generated-server conformance lane (the headline).** New harness `packages/integration-tests/src/api-contract-generated-server.ts` (runGen → temp dir → dynamic import → mount on Fastify+Drizzle+pg) + new test `packages/integration-tests/test/api-contract-generated.test.ts` reusing `loadScenarios`/`assertResponse`/`executeRequests`. Keep the existing hand-rolled `api-contract.test.ts` untouched. All 20 scenarios pass byte-exact against the generated server. If any scenario fails, that is a real generated-artifact bug to fix (in `routesFile`/`drizzle-fastify`), not a test to relax.
- **Unit 2 — Close the plain `runtime-ts/fastify` mount gaps.** Add `withCount` (return `{ rows, total }` envelope when `?withCount=1`) and the `invalid_sort` 400 (validate `?sort=` against the sort allowlist) to `server/typescript/packages/runtime-ts/src/fastify/` so the ObjectManager-based shipped helper matches the Drizzle one + the contract. Port the semantics from `drizzle-fastify/mount-read-only.ts` (framework-neutral over ObjectManager — no Drizzle dep). Unit-test both behaviors. (This does not change the generated artifact, which uses drizzle-fastify; it makes the *other* shipped public helper contract-complete.)
- **Unit 3 — Gate + fan-out doc.** Wire the new generated-server lane into `.github/workflows/integration-tests.yml` (it must run on PRs + pushes-to-main alongside the hand-rolled lane). Add a short fan-out follow-on note (in `fixtures/api-contract-conformance/README.md` and/or the roadmap) describing the per-port generated-server harness for Java/Kotlin Spring (Spring Boot test context + generated `@RestController`), C# ASP.NET (`WebApplicationFactory` + generated minimal-API routes), and Python FastAPI (`TestClient` + generated router) — so the remaining four ports' deployed artifacts get the same verification.

## Edge cases / non-goals

- **No corpus changes expected.** The 20 scenarios already exercise pagination, `withCount`, sort, `invalid_sort`, filters, CRUD verbs, 404/204. If the generated server passes all 20, the contract is proven; if not, fix the generator/runtime.
- **Drizzle dependency in the test harness** is acceptable (the generated TS artifact legitimately uses Drizzle; the harness must mirror a real deployment). The plain-fastify gap (Unit 2) is closed *without* Drizzle (ObjectManager path).
- **Fan-out (other 4 ports) is explicitly deferred** to a tracked follow-on, not built here. Documented so it isn't silently dropped.
- **Not** changing the contract, the wire format, or the corpus expectations.

## Definition of done

- The **generated** TS Author routes are booted over HTTP and pass all 20 api-contract scenarios byte-exact, in a CI-gated lane, alongside the retained hand-rolled reference lane.
- Both shipped TS mount helpers (`drizzle-fastify` and plain `fastify`) implement `withCount` + `invalid_sort` 400 (the plain one newly so), each tested.
- The fan-out to Java/Kotlin/C#/Python is documented as a tracked follow-on.
