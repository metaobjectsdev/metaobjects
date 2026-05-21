# MetaObjects Roadmap

## Shipped
- **H1 — Polyglot monorepo migration** (2026-05-14)
  TS code consolidated under `typescript/`; package names normalized to `@metaobjects/*`;
  CLI binary renamed to `meta`; config file `metaobjects.config.ts`; tool-state dir `.metaobjects/`.
- **H2 — Shared conformance fixtures** (2026-05-15)
  Fixtures extracted into `fixtures/conformance/`; TS conformance runner; canonical
  serializer (fused-key form); format documented in `spec/conformance-tests.md`.
- **C# loader + conformance** (shipped at v0.3 parity)
  C# Loader at `csharp/MetaObjects/` plus full conformance corpus green via
  `csharp/MetaObjects.Conformance.Tests/` (`dotnet test`). C# codegen + runtime are out
  of scope at this stage.

## Active
- **H3 — Java port (Loader + runtime + conformance)**
  - **H3a — Java loader-restructure** — shipped 2026-05-19.
  - **H3b — Java conformance harness** — in progress.
  - Remaining: typed MetaModel API, runtime helpers (Spring JDBC, filter parser, currency, JSONB).

## Planned
- **H4 — TS codegen Java target** (2-3 wk)
  Refactor TS codegen to pluggable targets; Java target emits Spring JDBC DAOs, Spring MVC controllers, POJOs.
- **H5 — First Java consumer migration** (3-4 wk)
  Real-world consumer adopts metaobjects-emitted Java; validates the Java path end-to-end.
- **H6 — AI-collaboration capabilities expansion** (TBD)
  Additional AI-collaboration features layered on the MetaObjects toolchain.
- **H7 — npm publish** (1 wk)
  First stable public release reflecting polyglot reality.
- **H8 — TS consumer npm migration** (0.5 wk)
  First TS consumer switches from `link:` deps to published versions.
- **H9 — Second consumer migration** (2-3 wk)
  TS frontend adopts `@metaobjects/runtime-ts-client`.
- **H10 — Polyglot consumer migration** (3-4 wk)
  Java + TS consumer onto metaobjects (both layers).

## Future (sketched)
- Python port (post-H3)
- Forms codegen revival (deferred from earlier)
- Date / case transforms
- Materialized views, federated entities, search-index sources
