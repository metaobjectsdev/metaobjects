# MetaObjects Roadmap

_Last refreshed 2026-05-27._

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
- **FR-006 — `template.output` parser-on-receipt codegen.** ADR-0010. Shipped in TS / C# / Python / Kotlin; `meta verify` extended to cover output drift. Java pending (a small follow-up: `SpringOutputParserGenerator` in `codegen-spring`).
- **FR-008/FR-009 — Cross-port REST API contract + 10 filter operators.** Shipped in all 5 ports.
- **Per-target output directories (TS codegen).** Each generator routes to a named output target (`{ outDir, importBase?, outputLayout?, dbImport? }`).
- **0.6.x → 0.7.0 consumer-friction batch.** Stock `promptRender()` generator; `db`-parameter generated repo helpers (ADR-0008); Cloudflare Workers deploy recipe; CHANGELOG.md backfill + camelCase ↔ snake_case docs. (Currently published as `0.7.0-rc.2`; GA promotion is the next release move.)

## Active

- **0.7.0 GA promotion** — currently `0.7.0-rc.2`. Diff vs rc.2 is essentially one additive type (`warningEnvelopes?` on `LoadOutcome` in `@metaobjectsdev/conformance`). Procedure: `docs/RELEASING.md` (bun publish, regen lockfile, external install smoke in npm + pnpm).

## Planned

- **Java FR-006 — `SpringOutputParserGenerator`** (~1-2 days). Add a per-`template.output` parser generator to `codegen-spring`, mirroring `KotlinOutputParserGenerator`. Java is the only port without FR-006 today. Lives alongside the existing Spring controller / DTO / repo / filter-allowlist generators.
- **H5 — First Java consumer migration** (3-4 wk). Real-world consumer adopts metaobjects-emitted Java (controllers + DTOs + repos via `codegen-spring`, optionally OMDB via `omdb`/`omdb-ktx`). Validates the Java path end-to-end. NOT gated on any other work — `codegen-spring` already ships FR-006-minus + FR-008 + FR-009.
- **H6 — Prompt construction: the fourth pillar (full cross-port)** (7.0.0). The render + payload + verify tiers ship per port; the FR-003 projection substrate now lands the typed-projection prerequisite. Closing out the full pillar means consolidating the cross-port story end-to-end (MCP exposure, eval harness, drift-checked at build time). Designed in `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`.
- **H9 — Second consumer migration** (2-3 wk). TS frontend adopts `@metaobjectsdev/runtime-web` + `@metaobjectsdev/react` + `@metaobjectsdev/tanstack`.
- **H10 — Polyglot consumer migration** (3-4 wk). Java + TS consumer onto metaobjects (both layers).
- **Database-source metadata loader** (separate future FR). FR5e reserves the envelope; building the loader (a metaobjects-table schema + a Java loader that reads it) is its own multi-week feature. Will produce `format: "database"` errors / warnings using the pre-validated envelope shape.
- **Cross-port `templateGenerator()`** — _shipped 2026-05-28_. Python, C#, and Java factories all green; 3/3 conformance fixtures pass byte-equivalently against the TS reference in every port. Java's existing legacy `Generator` interface was incompatible with the cross-port shape, so the Java port ships new lightweight types under `com.metaobjects.render.templategen` instead. Maven plugin integration for the Java factory deferred to a follow-up. See [design doc](design-docs/2026-05-28-cross-port-template-generator.md).

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

A polyglot codegen engine in TS would have meant forcing every Java consumer to install Node/bun just to generate Java — and the C# / Kotlin / Python ports already proved this isn't necessary. Java's `codegen-spring` is real, shipped, and already emits the FR-008 / FR-009 surface; the only remaining cross-port gap is FR-006's `SpringOutputParserGenerator` (~1-2 days, listed under Planned above).
