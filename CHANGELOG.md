# Changelog

All notable changes to `@metaobjectsdev/*` TypeScript packages are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0; MINOR bumps may introduce breaking changes with notice).

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
