# SP-F Generated-API Fan-out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`.

**Goal:** Boot each remaining port's GENERATED API artifact over HTTP (in-process host) against the 20 api-contract scenarios, byte-exact, alongside the retained hand-rolled reference lane — the SP-B fan-out to Java/Kotlin/C#/Python.

**Architecture:** Two shapes. Seam ports (Java/Kotlin/Python): generated controller/router + a minimal in-memory test repo impl behind the generated repo-interface/DI-dependency (no Testcontainers — the controller is the artifact). C#: generated routes + generated AppDbContext on WebApplicationFactory + Testcontainers Postgres (fully-generated stack). Each reuses the port's existing ApiContractScenarioLoader/Assertions; only the server-under-test changes.

**Tech stack:** Java/Kotlin Spring MockMvc, C# WebApplicationFactory + Testcontainers, Python FastAPI TestClient. Generate→compile→load reuses the SP-C/SP-E per-port patterns. Design: `docs/superpowers/specs/2026-06-01-sp-f-generated-api-fanout-design.md`.

**Worktree:** `<repo-root>/.claude/worktrees/sp-f-generated-api-fanout` (branch `sp-f-generated-api-fanout`, off origin/main).

---

### Unit 1: Java Spring generated-controller lane (pilot)

**Files (in `server/java/integration-tests`):**
- Create: `src/test/java/com/metaobjects/integration/api/generated/GeneratedAuthorControllerHarness.java` (generate→compile→Spring MockMvc + in-memory repo)
- Create: `src/test/java/com/metaobjects/integration/api/ApiContractGeneratedConformanceTest.java` (the new lane)
- Reference (no change): `ApiContractScenarioLoader.java`, `ApiContractScenarios.java`, `ApiContractAssertions.java`, `AuthorApiServer.java` (hand-rolled — keep)
- Reference: `codegen-spring` `SpringControllerGenerator`/`SpringDtoGenerator`/`SpringRepositoryGenerator`/`SpringFilterAllowlistGenerator`; the SP-E `GeneratedExtractorCompileRunTest`/`ValidationConformanceTest` for the generate→`ToolProvider`-compile→URLClassLoader pattern.

- [ ] **Step 1 — Study.** Read `AuthorApiServer.java` (how it drives the corpus: routes, filter/sort/pagination, error envelopes, status codes the corpus expects) + `ApiContractScenarioLoader`/`Assertions` (the server-agnostic harness: how a scenario's request→expect is asserted). Read `SpringControllerGenerator` + `SpringRepositoryGenerator` (the controller delegates to the `<Entity>Repository` interface; note its method signatures — list(filters, sort, limit, offset), get(id), create, update, delete — and the `FilterPredicate`/`SortClause` types). Read the corpus `fixtures/api-contract-conformance/{meta.json,seed.json,scenarios/*.yaml}`.
- [ ] **Step 2 — Harness.** `GeneratedAuthorControllerHarness`: run the codegen generators (controller+dto+repo-interface+filter-allowlist) for the corpus `Author` into a temp dir; compile them (system `ToolProvider` compiler → URLClassLoader, mirroring SP-E); write a small in-memory `AuthorRepository` impl satisfying the generated interface (seeded from `seed.json`; applies the controller-passed `FilterPredicate`/`SortClause`/limit/offset to the seeded list — implement the 10 operators + sort + paging faithfully); build a Spring `MockMvc` (standalone `MockMvcBuilders.standaloneSetup(controllerInstance)` with the repo injected, or a minimal `@WebMvcTest`-style context) exposing the generated controller. Expose a small adapter so `ApiContractAssertions` can drive it (MockMvc `perform` → status + body).
- [ ] **Step 3 — Test.** `ApiContractGeneratedConformanceTest`: for each scenario from the loader, issue the request through MockMvc + assert via the existing assertions. Mirror the hand-rolled test's structure (seed/truncate per scenario).
- [ ] **Step 4 — Run + fix real bugs.** `cd server/java && mvn -q -pl integration-tests -am install -DskipTests && mvn -q -f integration-tests/pom.xml test -Dtest=ApiContractGeneratedConformanceTest 2>&1 | tail -30`. All 20 byte-exact. A failure = a real generated-controller bug → fix in `codegen-spring` (NOT the test, NOT emitted code). Report any bug found.
- [ ] **Step 5 — Confirm hand-rolled lane intact** (`AuthorApiServer.java`/`ApiContractConformanceTest.java` unchanged): `git diff --stat`.
- [ ] **Step 6 — Commit.** `feat(conformance): SP-F Unit 1 — run GENERATED Java Spring controller over HTTP vs api-contract corpus`

### Unit 2: Kotlin Spring generated-controller lane

**Files (in `server/java/integration-tests-kotlin`):** mirror Unit 1.
- Create: `.../kotlin/api/generated/GeneratedAuthorControllerHarness.kt` + `ApiContractGeneratedConformanceTest.kt`
- Reference: `KotlinSpringControllerGenerator` (+ Kotlin DTO/filter-allowlist generators); the SP-C/SP-E kotlin-compile-testing pattern (`KotlinCompilation`, `inheritClassPath=true`); the hand-rolled `AuthorApiServer.kt` (keep).

- [ ] **Step 1 — Study** the Kotlin hand-rolled server + `KotlinSpringControllerGenerator` output (its repo-interface seam) + the existing kotlin-compile-testing harness (SP-C `ValidationConformanceTest.kt`).
- [ ] **Step 2 — Harness.** Generate the Kotlin Author controller (+ DTO/filter-allowlist/repo-interface) → `KotlinCompilation` compile → in-memory repo impl (seeded, applies predicates/sort/paging) → Spring MockMvc standalone with the generated controller → adapter for the assertions.
- [ ] **Step 3 — Test.** `ApiContractGeneratedConformanceTest.kt` driving the 20 scenarios via MockMvc + the existing Kotlin assertions.
- [ ] **Step 4 — Run + fix.** `cd server/java && mvn -q -pl codegen-kotlin,integration-tests-kotlin -am install -DskipTests && mvn -q -f integration-tests-kotlin/pom.xml test -Dtest=ApiContractGeneratedConformanceTest 2>&1 | tail -30`. 20 byte-exact; fix any generated-controller bug at `codegen-kotlin`.
- [ ] **Step 5 — Confirm hand-rolled lane intact.**
- [ ] **Step 6 — Commit.** `feat(conformance): SP-F Unit 2 — run GENERATED Kotlin Spring controller over HTTP vs api-contract corpus`

### Unit 3: C# generated-server lane (WebApplicationFactory + Testcontainers)

**Files (in `server/csharp/MetaObjects.IntegrationTests`):**
- Create: `Api/GeneratedAuthorServerFactory.cs` (WebApplicationFactory hosting generated routes + AppDbContext) + `Api/ApiContractGeneratedConformanceTest.cs`
- Reference: `RoutesGenerator` (generated minimal-API routes over AppDbContext), the persistence runner's AppDbContext provisioning, `AuthorApiServer.cs` (keep), the SP-C `ValidationConformanceTests` Roslyn-compile pattern.

- [ ] **Step 1 — Study** `RoutesGenerator` output (routes over `AppDbContext`), how the persistence runner builds/migrates `AppDbContext` against Testcontainers Postgres, and `AuthorApiServer.cs` (the corpus behavior).
- [ ] **Step 2 — Generate + host.** Generate the Author routes + `AppDbContext` + entities for the corpus; compile (Roslyn → in-memory assembly) OR add them to a tiny test web project; host on `WebApplicationFactory<T>` with `AppDbContext` pointed at Testcontainers Postgres (provision schema via the canonical DDL / EF EnsureCreated as the persistence runner does); seed the 5 authors. Expose the factory's `HttpClient`.
- [ ] **Step 3 — Test.** `ApiContractGeneratedConformanceTest.cs`: drive the 20 scenarios through the factory `HttpClient` + the existing `ApiContractAssertions`. Per-scenario seed/truncate.
- [ ] **Step 4 — Run + fix.** `cd server/csharp && dotnet test MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj --filter ApiContractGenerated 2>&1 | tail -30` (Testcontainers). 20 byte-exact; fix any bug at `RoutesGenerator`. If committed `Generated/*.g.cs` change, refresh via the SP-0 drift harness + confirm `IntegrationFixtureDriftTests`.
- [ ] **Step 5 — Confirm hand-rolled lane intact.**
- [ ] **Step 6 — Commit.** `feat(conformance): SP-F Unit 3 — run GENERATED C# ASP.NET routes over HTTP vs api-contract corpus`

### Unit 4: Python FastAPI generated-router lane

**Files (in `server/python/tests/integration`):**
- Create: `generated_router_app.py` (exec render_router + mount on FastAPI + in-memory repo dep) + `test_api_contract_generated.py`
- Reference: `router_generator.render_router`, `api_contract_server.py` (hand-rolled — keep), `api_contract_assertions.py`, `test_api_contract.py`.

- [ ] **Step 1 — Study** `render_router` output (the `APIRouter` + its DI dependency seam — what the router imports/depends on) + `api_contract_server.py` (hand-rolled FastAPI app behavior) + `api_contract_assertions.py`.
- [ ] **Step 2 — Harness.** `render_router(Author)` → write the emitted module to a temp file → import it → build a `FastAPI` app, `include_router` the generated router, override its DI dependency with a minimal in-memory repo (seeded from `seed.json`; applies the router-passed filters/sort/paging) → `TestClient(app)`.
- [ ] **Step 3 — Test.** `test_api_contract_generated.py`: drive the 20 scenarios through `TestClient` + the existing assertions.
- [ ] **Step 4 — Run + fix.** `cd server/python && uv run --extra dev --extra integration pytest tests/integration/test_api_contract_generated.py -q 2>&1 | tail -20` (no Docker needed — in-memory repo). 20 byte-exact; fix any bug at `router_generator`.
- [ ] **Step 5 — Confirm hand-rolled lane intact.**
- [ ] **Step 6 — Commit.** `feat(conformance): SP-F Unit 4 — run GENERATED Python FastAPI router over HTTP vs api-contract corpus`

### Unit 5: Cross-port sweep + CI + finish

- [ ] **Step 1 — CI pickup.** Confirm each new generated lane runs under `integration-tests.yml`'s per-port job (`scripts/integration-test.sh <port>` runs the whole module/package — verify the new test is discovered; Python's in-memory lane needs no Docker but lives in tests/integration — confirm it runs in that job or move it where it runs). No silent skip.
- [ ] **Step 2 — Docs.** Update `fixtures/api-contract-conformance/README.md`: the fan-out follow-on is DONE — all 5 ports run BOTH a hand-rolled reference lane AND a generated-artifact lane (note C# uses Testcontainers; Java/Kotlin/Python use an in-memory repo behind the generated controller's consumer seam). Update CLAUDE.md if it characterizes api-contract coverage.
- [ ] **Step 3 — Final review.** Simplifier + reviewer over the whole SP-F diff (focus: each lane genuinely boots the GENERATED controller/routes [not a hand-rolled stand-in]; the in-memory repo is faithful test scaffolding behind the real generated controller; hand-rolled lanes untouched; any generator bug fixed at the generator).
- [ ] **Step 4 — Finish.** Merge forward (integrate-before-merge — main is very active). Update memory + close the SP-B follow-on.

## Self-review notes
- Each lane MUST host the EMITTED controller/routes unmodified (compile/exec the generated source) — not re-call a mount helper or hand-write the controller. The in-memory repo (seam ports) is the ONLY hand-written piece, and it's behind the generated interface, not the artifact under test.
- If a port passes all 20 with no generator fix, that's a valid good outcome — report it; don't manufacture a fix.
- The in-memory repo must apply the controller-supplied predicates/sort/paging faithfully (so filter/sort/pagination scenarios genuinely exercise the controller's qs→predicate translation + the 400-on-bad-filter/sort validation).
- Keep every hand-rolled `AuthorApiServer` lane intact (additive, like SP-B).
- C# is the only port needing Testcontainers here.
