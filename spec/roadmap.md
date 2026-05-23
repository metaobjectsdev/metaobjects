# MetaObjects Roadmap

## Shipped
- **H1 — Polyglot monorepo migration** (2026-05-14)
  TS code consolidated under `typescript/`; package names normalized to `@metaobjectsdev/*`;
  CLI binary renamed to `meta`; config file `metaobjects.config.ts`; tool-state dir `.metaobjects/`.
- **H2 — Shared conformance fixtures** (2026-05-15)
  Fixtures extracted into `fixtures/conformance/`; TS conformance runner; canonical
  serializer (fused-key form); format documented in `spec/conformance-tests.md`.
- **C# loader + conformance** (shipped at v0.3 parity)
  C# Loader at `csharp/MetaObjects/` plus full conformance corpus green via
  `csharp/MetaObjects.Conformance.Tests/` (`dotnet test`). C# codegen + runtime are out
  of scope at this stage.
- **Per-target output directories (TS codegen)** (2026-05-22)
  Each generator routes to a named output target (`{ outDir, importBase?, outputLayout?,
  dbImport? }`), so generated code lands with its runtime concern (model → database
  package, routes → API app, hooks/forms/grids → web app). Cross-target entity-module
  references emit as extension-less `importBase` package paths; same-target stays
  relative; single-`outDir` projects are byte-identical. Design:
  `docs/superpowers/specs/2026-05-21-per-target-output-dirs-design.md`.

## Active
- **H3 — Java port (Loader + runtime + conformance)**
  - **H3a — Java loader-restructure** — shipped 2026-05-19.
  - **H3b — Java conformance harness** — in progress.
  - Remaining: typed MetaModel API, runtime helpers (Spring JDBC, filter parser, currency, JSONB).
  - **FR-003 — Java RDB persistence, schema migration & projections (7.0.0)**: ports the OMDB
    persistence engine onto current core, adds a diff-and-converge `meta migrate`, jsonb value-objects,
    and origin-driven projection views — re-unifying the Java module line at a single 7.0.0. The runtime
    half of the Java story (TS already ships `runtime-ts` + `migrate-ts`). Designed in
    `docs/superpowers/specs/2026-05-22-fr-003-omdb-persistence-schema-migration-projections-design.md`.

## Planned
- **H4 — TS codegen Java target** (2-3 wk)
  Refactor TS codegen to pluggable targets; Java target emits Spring JDBC DAOs, Spring MVC controllers, POJOs.
- **H5 — First Java consumer migration** (3-4 wk)
  Real-world consumer adopts metaobjects-emitted Java; validates the Java path end-to-end.
- **H6 — Prompt construction: the fourth pillar** (7.0.0)
  Make an LLM prompt a declared, deterministic, testable artifact instead of a string assembled
  imperatively and scattered across services. A prompt's payload is declared as a typed projection
  (reusing the FR-003 substrate, so payload bloat is a diff); its text is external and provider-resolved;
  a logic-less Mustache engine renders deterministically — snapshot-testable in CI, byte-stable so a
  whitespace/ordering change can't break exact-prefix prompt caching, and `verify`'d at build time so a
  renamed field can't silently degrade a prompt. The render is conformance-gated, so the guarantee holds
  in every language port (and an eval harness renders exactly what prod ships). Designed in
  `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`. Depends on
  FR-003 shipping (≥ 7.0.0-M1). MCP / metadata-graph exposure is where this pillar heads next.
- **H7 — npm publish** (1 wk)
  First stable public release reflecting polyglot reality.
- **H8 — TS consumer npm migration** (0.5 wk)
  First TS consumer switches from `link:` deps to published versions.
- **H9 — Second consumer migration** (2-3 wk)
  TS frontend adopts `@metaobjectsdev/runtime-web` + `@metaobjectsdev/react` + `@metaobjectsdev/tanstack`.
- **H10 — Polyglot consumer migration** (3-4 wk)
  Java + TS consumer onto metaobjects (both layers).

## Future (sketched)
- Python port (post-H3)
- Forms codegen revival (deferred from earlier)
- Date / case transforms
- Materialized views, federated entities, search-index sources
