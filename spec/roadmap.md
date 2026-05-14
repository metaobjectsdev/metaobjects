# MetaObjects Roadmap

## Active
- **H1 — Polyglot monorepo migration** (current)

## Planned
- **H2 — Shared conformance fixtures** (1 wk)
  Extract ~40-60 fixtures from existing TS tests into `fixtures/conformance/`; TS conformance runner; format documented in `spec/conformance-tests.md`.
- **H3 — Java port (Loader + runtime)** (4-6 wk)
  Full Java Loader, typed MetaModel API, conformance test runner, runtime helpers (Spring JDBC, filter parser, currency, JSONB).
- **H4 — TS codegen Java target** (2-3 wk)
  Refactor TS codegen to pluggable targets; Java target emits Spring JDBC DAOs, Spring MVC controllers, POJOs.
- **H5 — First Java consumer migration** (3-4 wk)
  Real-world consumer adopts metaobjects-emitted Java; validates the Java path end-to-end.
- **H6 — Forge AI capabilities expansion** (TBD)
  Additional AI-collaboration features layered on the `@metaobjects/forge` package.
- **H7 — npm publish** (1 wk)
  First stable public release reflecting polyglot reality.
- **H8 — TS consumer npm migration** (0.5 wk)
  First TS consumer switches from `link:` deps to published versions.
- **H9 — Second consumer migration** (2-3 wk)
  TS frontend adopts `@metaobjects/runtime-ts-client`.
- **H10 — Polyglot consumer migration** (3-4 wk)
  Java + TS consumer onto metaobjects (both layers).

## Future (sketched)
- Python port
- C# port
- Forms codegen revival (deferred from earlier)
- Date / case transforms
- Materialized views, federated entities, search-index sources
