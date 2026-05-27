# Changelog

All notable changes to `@metaobjectsdev/*` TypeScript packages are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0; MINOR bumps may introduce breaking changes with notice).

## [Unreleased]

### Added
- **`entityFile({ allowlists: false })` opt-in flag** (`@metaobjectsdev/codegen-ts`) —
  Worker/Lambda consumers can disable the Fastify-flavored
  `<Entity>FilterAllowlist` + `<Entity>SortAllowlist` emission. Generated
  entity files then carry no `@metaobjectsdev/runtime-ts/drizzle-fastify`
  imports at all and `runtime-ts` can be omitted from the consumer's deps
  entirely. The client-side `<Entity>Filter` type is still emitted (zero
  runtime-ts dependency). Default remains `true` for back-compat; consumers
  using `routesFile()` should leave the default. Closes the long-term
  recommendation from the 0.7.0-rc.1 Worker-consumer friction batch
  (commit bd0bcb8).
- **Loader error envelope + source-on-node** (`@metaobjectsdev/metadata`) —
  per [ADR-0009](spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md),
  every `MetaData` node now carries a `source: ErrorSource` provenance field
  (`{ format: "json", files: [...], jsonPath: "..." }` for loaded nodes;
  `{ format: "code" }` for programmatically constructed). `ParseError` now
  conforms to the cross-port `LoaderError` schema: required `code`, required
  `message`, required `source` envelope. New `LoadResult.warnings:
  LoaderWarning[]` channel (legacy parser/validator strings are wrapped at
  the loader boundary as `WARN_LEGACY` envelopes; future overlay-merge
  detection in FR5c will be the first feature to emit native envelope-shaped
  warnings). New public exports from `@metaobjectsdev/metadata`:
  `ErrorSource`, `LoaderError`, `LoaderWarning`, `NodeContext`, `Contributor`
  types, plus the `codeSource()` helper. Foundation for FR5b (YAML
  positions), FR5c (multi-file merge attribution), FR5d (reference-resolution
  errors), FR5e (database-source errors).
- **`outputParser()` stock generator** in `@metaobjectsdev/codegen-ts/generators` —
  for every declared `template.output`, emits a typed Zod parser file with a
  dual-API surface (`parseXxx(text)` throws, `safeParseXxx(text)` returns
  Result). Field-type → Zod-type mapping covers all scalars, arrays, and
  nested `field.object` with `@objectRef`. The emitted file is self-contained
  (no cross-file payload import) and exports a `<TemplateName>Data` type-alias
  derived via `z.infer`; consumers who also wire `promptRender()` can use the
  payload-VO interface from `prompts.ts` interchangeably (structurally
  identical). Wire it into `metaobjects.config.ts`:
  `generators: [..., outputParser()]`.
- **`meta verify` extension** for `template.output` drift — the build-time
  drift gate now checks both subtypes. Output diagnostics carry `(output)`
  prefix; prompt diagnostics gain `(prompt)` prefix for symmetry.
- **Conformance fixture `template-output-simple`** — shared cross-language
  corpus gains `input/meta.npc.json`, `expected.json`, and
  `expected/NpcResponseOutput.output.ts` byte-exact codegen artifact. TS
  conformance runner verifies `outputParser()`'s output matches.

### Changed
- `meta verify` log line format adds `(<subtype>)` after the template name
  (e.g., `[npcTurn] (prompt) ERR_*`). A pre-FR6 log scraper that matched
  on the bare `[name]` prefix needs to update its regex.
- **BREAKING (codegen-ts):** Generated `<Entity>.queries.ts` CRUD helpers now
  accept a Drizzle `db` instance as the **first parameter** of every function
  (`findUserById(db, id)`, `listUsers(db, opts)`, `createUser(db, data)`,
  `updateUser(db, id, data)`, `deleteUserById(db, id)`). The module-level
  `import { db } from "<dbImport>"` line is no longer emitted; instead, every
  file declares a dialect-correct `type Db = ...` alias at the top. Migration:
  bump, regen, search-and-replace call sites — see the new
  [wiring-generated-queries.md](docs/recipes/wiring-generated-queries.md)
  recipe for the full guide. Background: [ADR-0008](spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md).
  Enables Cloudflare Workers / edge consumers to drop their typecheck stubs;
  enables multi-tenant servers + test-isolated `db` setups. `routesFile()` is
  unchanged.
- **BREAKING (metadata):** `ParseError` constructor signature changed. Was
  `new ParseError(msg, { code?, source?: string, path? })`; now
  `new ParseError(msg, { code, source: ErrorSource })`. Direct construction
  outside the metadata package is rare (loader-internal API), but anyone
  catching + repackaging a `ParseError` reads `.source` as the new envelope
  type, not a string. Legacy `error.path` is gone — read
  `error.source.jsonPath` instead.
- **BREAKING (metadata):** `LoadResult.warnings` retyped from `string[]` to
  `LoaderWarning[]` per ADR-0009. Consumers that inspected warning content
  via `result.warnings[i].includes(...)` should now read
  `result.warnings[i].message.includes(...)`. The public
  `ExportResult.warnings` (returned by `loadAndExportJson()`) keeps its
  `string[]` shape — extracted via `.map((w) => w.message)`.

See [ADR-0010](spec/decisions/ADR-0010-template-output-parser-codegen.md)
for the cross-port design.

### Fixed
- **`@metaobjectsdev/cli` now pulls `@metaobjectsdev/runtime-ts` transitively.**
  Generated entity files emit `import type { FilterAllowlist, SortAllowlist }
  from "@metaobjectsdev/runtime-ts/drizzle-fastify"` unconditionally; until
  now, consumers who installed only `cli` (the recommended umbrella) hit
  unresolved-import errors on the first `meta gen`. `cli` now declares
  `runtime-ts` as a runtime dependency at the same pinned workspace version.
  The imports are type-only, so the addition has no Worker/Lambda bundle
  impact. (Reported from a 0.7.0-rc.1 Worker consumer.) Long-term, an opt-in
  flag on `entityFile({ allowlists: false })` will let Workers consumers skip
  the imports entirely — that's a separate follow-up.
- **`meta migrate --dialect d1` no longer fails against wrangler's local D1
  sandbox.** `introspectD1` was calling `SELECT sqlite_version()` to populate
  `SnapshotMeta.sqliteVersion`, but workerd blocks that function in the local
  D1 sandbox. The introspector now tries the call once and falls back to a
  static known-good version (`"3.44.0"` — matches Cloudflare D1's shipped
  SQLite) on failure. Remote `wrangler d1 execute` paths still answer the
  function and use the live value. (Reported from the same 0.7.0-rc.1
  consumer.)

## [0.6.0] — 2026-05-25

### Added
- **Cloudflare D1 dialect for `meta migrate`** — `--dialect d1`,
  `meta init --d1`, `wrangler.toml` binding resolution, `introspectD1` via
  shell-out, `renderD1` = `renderSqlite` + D1-safety post-pass (strip explicit
  txns, reject `ATTACH`/`VACUUM`), `writeMigrationD1` (Wrangler
  `<seq>_<slug>.sql` + `.down/` sidecar), optional `--apply` hook. See
  [`docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md`](docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md).
- Projection (`source.dbView`) migrations now emit DDL for D1 alongside
  Postgres/SQLite.
- New `render` package added to the publish-candidate set (Tier 0); 12
  packages now released in lockstep.

### Changed
- `Dialect` union extended to include `"d1"`; existing `"sqlite"` /
  `"postgres"` paths unchanged.
- `MigrateBlock` in `.metaobjects/config.json` gained an optional `d1`
  sub-block (`binding`, `remote`, `autoApply`, `wranglerConfigPath`).
- Generated `deleteXById(...)` helpers now use `.returning()` so the
  response shape is portable across D1, libsql/Turso, and Postgres (was
  previously libsql/Turso-specific).

### Fixed
- SQL injection in `introspectD1` pragma calls via crafted SQLite identifier
  names; pragma queries now double-quote-escape identifiers (the Kysely-based
  `introspectSqlite` path was already safe via Kysely's parameterization).
- Removed dead `parseWranglerExecuteJson` export from `cli/lib/wrangler.ts`.
- `codegen-ts/src/templates/jsdoc.ts` now satisfies `exactOptionalPropertyTypes`.

### Security
- Pragma identifier injection patched in the D1 introspector; see Fixed.

## [0.5.0] — 2026-05-23

First public release. 11 publish-candidate packages on `latest`; `cli` shipped
as `0.5.1` patch shortly after. Projects D–G shipped end-to-end (typed filter
syntax, source-aware entities + projections, currency, TanStack codegen).
See [`spec/roadmap.md`](spec/roadmap.md) for the full Projects D–G coverage.
