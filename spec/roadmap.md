# MetaObjects Roadmap

_Last refreshed 2026-05-30._

## Shipped

### Foundation

- **H1 — Polyglot monorepo migration** (2026-05-14)
  TS code consolidated under `server/typescript/`; package names normalized to `@metaobjectsdev/*`; CLI binary renamed to `meta`; config file `metaobjects.config.ts`; tool-state dir `.metaobjects/`.
- **H2 — Shared conformance fixtures** (2026-05-15)
  Fixtures extracted into `fixtures/conformance/`; per-port conformance runners; canonical serializer (fused-key form); format documented in `spec/conformance-tests.md`.
- **H7 — npm publish: first public release** (2026-05-23)
  All publish-candidate `@metaobjectsdev/*` packages published to npm at `0.5.0` then `0.6.0` (`latest`). The JS/TS workspace root was hoisted to the repo root so `workspace:*` resolves uniformly across the server + client package trees at publish time.
- **H8 — First TS consumer on published packages** (2026-05-23)
  A real TS consumer migrated off `link:` filesystem deps onto the published packages and builds clean end-to-end — validating the published dist, `.d.ts` types, and runtime imports through a real pnpm install.

### Per-port ports + codegen layers

- **TypeScript** — `@metaobjectsdev/metadata` + `codegen-ts` (Vite-style plugins) + `runtime-ts` + `migrate-ts` + the universal web client packages (`runtime-web`, `react`, `tanstack`). The reference port for everything cross-language.
- **C# full-stack target** — `MetaObjects` (loader + canonical serializer + conformance) + `MetaObjects.Render` (Mustache + payload-VO codegen + `verify`) + `MetaObjects.Codegen` (EF Core entities + `AppDbContext`/owned-types via `OwnsOne` + CRUD minimal-API routes + Postgres DDL with full-CREATE + incremental introspect/diff/migrate via `meta migrate --from-db`).
- **Java port** — `metadata` + `omdb` + `om` + `dynamic` + `core-spring` + `metadata-ktx` (Kotlin facade) + `codegen-spring` (Spring REST controllers + DTOs + repos + filter allowlists) + `codegen-mustache` + `codegen-plantuml` + `codegen-base` + `render` + `maven-plugin` (with `meta:gen` / `meta:migrate` / `meta:verify`).
- **Kotlin** — `codegen-kotlin` (KotlinPoet on JVM): entity + Exposed table + Spring controller + Spring config + payload + relations + filter allowlist + validator + stored-proc + output-parser generators; `integration-tests-kotlin` runs the persistence-conformance corpus through Exposed against Testcontainers Postgres.
- **Python port** — `metaobjects` (metadata loader + canonical serializer + conformance) + `migrate` + `ObjectManager` runtime + render (Mustache) + output-parser codegen.

### Cross-port conformance corpora (every port runs the shared corpus)

- **Metamodel conformance** — `fixtures/conformance/` (~90 fixtures + CAPABILITIES manifest). TS / C# / Java / Python all green.
- **Render conformance** — `fixtures/render-conformance/`. TS / C# / Java / Kotlin / Python byte-identical.
- **Persistence conformance** — `fixtures/persistence-conformance/`. TS / C# / Java / Kotlin / Python all 12/12 against Testcontainers Postgres / Derby (per port).
- **API-contract conformance** — `fixtures/api-contract-conformance/`. TS / C# / Java / Kotlin / Python all 20/20.
- **Recover conformance** — `fixtures/recover-conformance/` (10 dirty-input cases). TS / C# / Java / Python all 10/10; Kotlin reuses the shared JVM engine.
- **YAML / verify** corpora — green across the ports that ship those layers.

### Key cross-language features

- **Source v2 paradigm** — `source.rdb` + `@kind: table|view|materializedView|storedProc|tableFunction`; multi-source via `@role`. ADR-0007.
- **FR-003 — Java RDB persistence, schema migration & projections** (Plans 1/2/3/4a + Plan 4): port of `dynamic`/`om`/`omdb` onto current core; build-time FQN-keyed binding registry + typed jsonb value-objects + Spring-tx connection; decoupled `meta migrate` engine (diff-and-converge) with `SchemaMigrationEngine` + introspector + emitter; `source.*`+`origin.*` metamodel registered in Java; OMDB engine-debt remediation (atomic mapping cache, JDBC codec registry per ADR-0002, `inTransaction` template).
- **FR5 family — actionable loader errors** (a/b/c/d/e + WARN envelope-shape). ADR-0009.
  - FR5a: source-on-node + envelope-shaped errors (`format` ∈ `json|yaml|merged|resolved|database|code`)
  - FR5b: YAML source positions on yaml-input envelopes
  - FR5c: multi-file merge attribution (`MergedSource` + `contributors[]` + `ERR_MERGE_CONFLICT` + `WARN_DUPLICATE_DECLARATION`)
  - FR5d: reference-resolution errors (`format: "resolved"` + `referrer` + `target`)
  - FR5e: database-source envelope schema reserved + per-port shape tests + design questions resolved. Real DB-source loader is a future FR.
  - WARN envelope-shape assertion finalized across all 4 ports.
- **FR-006 — `template.output` parser-on-receipt codegen.** ADR-0010. Shipped in all 5 ports (TS / C# / Java / Python / Kotlin); `meta verify` extended to cover output drift.
- **FR-010 — output-format prompt fragment + tolerant `recover` parser.** Shipped in all 5 ports. One `template.output` drives three artifacts: a comment-free output-format prompt fragment (3 styles × json/xml via `@promptStyle`), a tolerant `recover()` (8-stage, never-throws, returns an all-nullable mirror of the payload) that complements FR-006's strict parser, and the `@example`/`@instruction`/`@enumAlias`/`@enumDoc` field-teaching attrs. Pinned by the shared `fixtures/recover-conformance/` corpus; tolerance is at classification + canonical value (not byte-identity). Designed in `docs/superpowers/specs/2026-05-29-fr-010-output-format-prompt-and-tolerant-parsing-design.md`.
- **Prompt-construction pillar — per-port building blocks complete.** Render (Mustache) + payload-VO codegen + `verify` (FR-004), the output parser (FR-006), and the output-format prompt + recover (FR-010) all ship in all 5 ports. The library-side primitives of the fourth pillar are delivered; what remains is MCP exposure (see Planned).
- **Cross-port `templateGenerator()`** (shipped 2026-05-28). TS reference + Python / C# / Java factories; 3/3 conformance fixtures byte-equivalent. Java ships lightweight types under `com.metaobjects.render.templategen` (its legacy `Generator` interface was incompatible). Maven-plugin integration for the Java factory is a follow-up. See `design-docs/2026-05-28-cross-port-template-generator.md`.
- **OMDB Spring Boot 3 starter** (shipped 2026-05-30). Autoconfiguration wires a `DataSource` → `ObjectManagerDB` with Spring-tx; closes the OMDB-modernization open question (jOOQ migration ruled out as a non-goal).
- **FR-008/FR-009 — Cross-port REST API contract + 10 filter operators.** Shipped in all 5 ports.
- **Per-target output directories (TS codegen).** Each generator routes to a named output target (`{ outDir, importBase?, outputLayout?, dbImport? }`).
- **0.6.x → 0.7.0 consumer-friction batch.** Stock `promptRender()` generator; `db`-parameter generated repo helpers (ADR-0008); Cloudflare Workers deploy recipe; CHANGELOG.md backfill + camelCase ↔ snake_case docs. (Currently published as `0.7.0-rc.2`; GA promotion is the next release move.)

## Active

- **0.7.0 GA promotion** — currently `0.7.0-rc.2`. Diff vs rc.2 is essentially one additive type (`warningEnvelopes?` on `LoadOutcome` in `@metaobjectsdev/conformance`). Procedure: `docs/RELEASING.md` (bun publish, regen lockfile, external install smoke in npm + pnpm).

## Planned

- **MCP exposure of declared prompts/tools** — the remaining library-side piece of the prompt-construction pillar. Surface a `template.output` / tool declaration over the Model Context Protocol (model-agnostic) so an LLM host can discover + register it, built on the shipped render / payload / verify / FR-006 / FR-010 primitives. Designed in `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`.
- **Database-source metadata loader** (separate future FR). FR5e reserves the envelope; building the loader (a metaobjects-table schema + a Java loader that reads it) is its own multi-week feature. Will produce `format: "database"` errors / warnings using the pre-validated envelope shape.

### Tracked outside this library repo (not roadmap work here)

These are exercised in adopter projects on top of the shipped per-port primitives, and are deliberately **not** tracked as open items in this repo:

- **Consumer-adoption validation** — downstream consumers migrating onto metaobjects-emitted code across the language paths (the former H5 / H9 / H10). The library surface they exercise (`codegen-spring`, `MetaObjects.Codegen`, the web-client packages, etc.) already ships.
- **Application-level prompt-pillar consolidation** — the end-to-end declared-prompt orchestration and prompt eval harness that sit on top of the per-port primitives (the former H6, **minus** MCP exposure, which remains a library item above).

## Future (sketched)

- Forms codegen revival (deferred from earlier).
- Date / case transforms.
- Materialized views, federated entities, search-index sources.

---

## Note on H4 ("TS-codegen Java target") — retired

An earlier version of this roadmap listed **H4 — TS codegen Java target** as a 2-3 week project to refactor `codegen-ts` into pluggable targets so a Java target could emit Spring code from TS. **That framing is obsolete and retired.**

The pattern that has actually shipped across all four language ports is: **each port has its own codegen layer in its host language**.

| Port    | Codegen module          | Emits                                                 |
|---------|-------------------------|-------------------------------------------------------|
| TS      | `codegen-ts`            | TS entities, Drizzle, Zod, Fastify routes             |
| C#      | `MetaObjects.Codegen`   | EF Core entities, `AppDbContext`, ASP.NET routes, Postgres DDL |
| Java    | `codegen-spring`        | Spring `@RestController`, DTO records, repositories, filter allowlists |
| Kotlin  | `codegen-kotlin`        | KotlinPoet output: Exposed tables, Spring controllers, payload VOs, output parsers, stored procs |
| Python  | `metaobjects.codegen`   | Pydantic models, FastAPI routes, output parsers       |

A polyglot codegen engine in TS would have meant forcing every Java consumer to install Node/bun just to generate Java — and the C# / Kotlin / Python ports already proved this isn't necessary. Java's `codegen-spring` is real, shipped, and emits the full cross-port surface (FR-006 / FR-008 / FR-009 / FR-010) alongside the other ports; there is no remaining per-port codegen gap.
