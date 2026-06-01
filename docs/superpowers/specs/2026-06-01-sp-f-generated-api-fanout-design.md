# SP-F — Generated-API Conformance Fan-out (Java / Kotlin / C# / Python over HTTP)

**Date:** 2026-06-01
**Status:** Designed (user-approved key decisions; spec-review gate waived — "do that too")
**Relates to:** the SP-B documented follow-on (SP-B piloted the generated-server-over-HTTP lane in TS only). Gates via `fixtures/api-contract-conformance/`.

## Problem

SP-B added a TS lane that boots the **generated** routes over HTTP against the api-contract corpus and found 4 real bugs golden snapshots never caught (generated Postgres routes that threw at runtime, wrong error codes, missing PUT, a timestamp-mode bug). The other four ports still only test a **hand-rolled `AuthorApiServer`** — each of which explicitly documents that it stands in for the generated controller because hosting the real one was "disproportionate" for a 10-route test:

- Java: "the generator's output is a Spring `@RestController` requiring a Spring Boot context".
- C#: "a full WebApplication host pulling EF Core + Kestrel".
- Python: "the generator emits a router that depends on a consumer-supplied" dependency.

So the **deployed API artifact** (the generated Spring controller, ASP.NET routes, FastAPI router) is unverified over HTTP in 4 of 5 ports. This fan-out closes that.

## Key architectural fact (shapes the design)

MetaObjects does NOT generate a complete server in every port. Two shapes:

- **Fully-generated stack (TS, C#):** the generated routes run over a generated persistence layer (TS Drizzle table + `mountCrudRoutes`; C# minimal-API routes over the generated `AppDbContext`). The whole server is generated → host it as-is.
- **Generated-controller + consumer-supplied persistence seam (Java, Kotlin, Python):** the generator emits the **controller/router** plus a repository **interface** (Java/Kotlin `<Entity>Repository`) or a DI **dependency** (Python) that MetaObjects *intentionally leaves the consumer to implement* (their choice of JPA / jOOQ / JDBC / SQLAlchemy). The controller is the generated artifact; the repo impl is the consumer's.

## Decisions (locked with user)

- **Seam ports (Java/Kotlin/Python):** fill the generated repo-interface / DI-dependency with a **minimal in-memory test repo impl** seeded with the corpus's 5 authors. This tests exactly what MetaObjects generates — the controller's HTTP-contract behavior (routing, qs→filter-predicate parsing, allowlist validation → 400, pagination, sort, status codes, error envelopes, serialization). Persistence is already gated separately by persistence-conformance; no Testcontainers needed for these 3 ports (the controller, not the DB, is the artifact). The in-memory repo applies the controller-supplied predicates/sort/paging to the seeded list (so the controller's filter→predicate translation is genuinely exercised end-to-end).
- **C#:** host the generated minimal-API routes + generated `AppDbContext` on an in-memory ASP.NET TestServer (**`WebApplicationFactory`**) against **Testcontainers Postgres** — the fully-generated C# stack, faithful like SP-B's full-stack TS lane.
- **Additive:** keep every port's hand-rolled `AuthorApiServer` reference lane (as SP-B kept TS's). Reuse each port's existing `ApiContractScenarioLoader` + `ApiContractAssertions` + `ApiContractScenarios` (server-agnostic) — only the server under test changes.
- **In-process HTTP host per framework** (matches SP-B's TS `fastify.inject`): Spring **MockMvc** (Java/Kotlin) exercises real controller routing + serialization without socket flakiness; **`WebApplicationFactory`** TestServer (C#); FastAPI **`TestClient`** (Python).

## Per-port shape

Each lane: compile/load the GENERATED controller for `Author` (the corpus entity), host it in the framework's in-process test host, drive the SAME 20 scenarios via the existing loader/assertions, assert the SAME `expect` bytes the hand-rolled + TS-generated lanes use. A failing scenario = a real generated-controller bug to fix at the generator (NOT relax the test, NOT hand-edit generated code).

- **Java (Spring, MockMvc):** generate `AuthorController` + `AuthorDto` + `AuthorFilterAllowlist` + the `AuthorRepository` interface (codegen-spring) → compile (the SP-C/SP-E generate→compile→load pattern: `ToolProvider` system compiler → URLClassLoader) → register the controller in a Spring `MockMvc` standalone/`@WebMvcTest`-style context with a test `AuthorRepository` impl (in-memory, seeded, applies `FilterPredicate`/`SortClause`/paging) → drive scenarios via MockMvc (`perform(get/post/...)`). No Testcontainers.
- **Kotlin (Spring, MockMvc):** same, generating via `KotlinSpringControllerGenerator` (+ the Kotlin DTO/filter-allowlist) → kotlin-compile-testing (the SP-C/SP-E Kotlin pattern) → MockMvc + in-memory repo. No Testcontainers.
- **C# (WebApplicationFactory + Testcontainers):** generate routes + `AppDbContext` + entities for `Author` → compile (Roslyn, the SP-C pattern) → host on `WebApplicationFactory` with `AppDbContext` pointed at Testcontainers Postgres → seed → drive scenarios via the factory's `HttpClient`.
- **Python (FastAPI TestClient):** `render_router(Author)` → exec the emitted module → mount its `APIRouter` on a `FastAPI` app with the generated router's DI dependency overridden to a minimal in-memory repo (seeded) → drive scenarios via `TestClient`. No Testcontainers.

## Implementation units

Each unit ends with the simplify + review gate; the sub-project merges forward once. Java is the Spring pilot (Kotlin mirrors it).

- **Unit 1 — Java Spring generated-controller lane** (the pilot). New `ApiContractGeneratedConformanceTest.java` (+ a generated-controller harness + the in-memory `AuthorRepository` impl) in `server/java/integration-tests`. Generate→compile→MockMvc→corpus. Keep `AuthorApiServer.java`. All 20 byte-exact; fix any generated-controller bug at `codegen-spring`.
- **Unit 2 — Kotlin Spring generated-controller lane.** Mirror Unit 1 with `KotlinSpringControllerGenerator` in `integration-tests-kotlin`. Keep the hand-rolled Kotlin server. All 20 byte-exact.
- **Unit 3 — C# generated-server lane.** `WebApplicationFactory` hosting the generated routes + `AppDbContext` against Testcontainers Postgres, in `MetaObjects.IntegrationTests`. Keep `AuthorApiServer.cs`. All 20 byte-exact; refresh any drift-gated `Generated/*.g.cs` if the routes/context change.
- **Unit 4 — Python FastAPI generated-router lane.** `render_router` → exec → `TestClient` with an in-memory repo dependency override, in `server/python/tests/integration`. Keep `api_contract_server.py`. All 20 byte-exact.
- **Unit 5 — Cross-port sweep + CI + finish.** Confirm all 4 generated lanes are picked up by `integration-tests.yml` (per-port jobs run the whole module/package — verify, no silent skip). Update `fixtures/api-contract-conformance/README.md` (the fan-out follow-on is now DONE — all 5 ports run a generated lane). Update CLAUDE.md if it states the api-contract coverage. Final review; merge forward.

## Edge cases / non-goals

- **The in-memory repo is test scaffolding, not the artifact under test.** It must faithfully apply the controller-passed predicates/sort/paging (so the controller's contract translation is exercised), but it is NOT a conformance subject — persistence-conformance owns real DB behavior. Document this clearly in each harness.
- **MockMvc / TestClient / WebApplicationFactory are in-process** (no real socket) — same fidelity choice as SP-B's `fastify.inject`. They exercise the real generated controller's routing, binding, validation, serialization, and status codes.
- **A failing scenario is a real generated-controller bug** — fix it in the generator (SpringControllerGenerator / KotlinSpringControllerGenerator / RoutesGenerator / router_generator) or the shared runtime helper, never by relaxing the assertion or editing emitted code. Expect to find some (SP-B found 4 in TS).
- **C# is the only fan-out port needing Testcontainers** (its stack is fully generated over a real DB); the 3 seam ports are DB-free (in-memory repo).
- **Not** changing the corpus, the contract, or the `expect` bytes. Not removing the hand-rolled reference lanes.

## Definition of done

- All four remaining ports (Java, Kotlin, C#, Python) boot their **generated** API artifact over HTTP (in-process host) against the 20 api-contract scenarios, byte-exact, in a CI-gated lane, alongside the retained hand-rolled reference lane.
- Any generated-controller bug surfaced is fixed at the generator (reported per port).
- The api-contract README records the fan-out as complete (all 5 ports run a generated lane); CLAUDE.md is accurate.
