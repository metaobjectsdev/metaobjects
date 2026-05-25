# FR: Release notes (`CHANGELOG.md`) + naming-convention docs hygiene

**Status:** Design — implementation-ready (small)
**Date:** 2026-05-25
**Scope:** TypeScript documentation (`CHANGELOG.md` at repo root + `README.md` addendum)
**Origin:** A downstream consumer doing the 0.5 → 0.6 upgrade survey reported it took
~10 minutes of git-log archaeology to confirm what changed; the codegen's camelCase TS ↔
snake_case SQL mapping took multiple iterations to discover by error rather than docs.

## Goal

1. Add `CHANGELOG.md` at the monorepo root, backfilled for 0.5.0 → 0.6.0 and maintained
   going forward.
2. Document the camelCase TS ↔ snake_case SQL field-name mapping as a deliberate design
   choice in `README.md`, including the `@dbColumn` override.

Both are small but high-leverage docs adds.

## Why

### Release notes

Currently the only release docs are `docs/RELEASING.md` (the *process* doc) and git
commit messages. Consumers — including AI agents triaging upgrades — have no canonical
place to read "what shipped in 0.6.0." This costs every adopter, recurringly, on every
version bump.

### Naming convention

Generated Drizzle uses camelCase TS property names (`councilId`, `createdAt`) for
snake_case SQL columns (`council_id`, `created_at`). The mapping is sensible (idiomatic
both sides), but discovery is by-error: adopters write `db.select().from(councils).where(eq(councils.council_id, ...))`,
TS complains that `council_id` doesn't exist on the table object, and the adopter has to
infer the camelCase rule.

## Design

### `CHANGELOG.md`

Standard [Keep a Changelog](https://keepachangelog.com/) format. Sections per release:
**Added**, **Changed**, **Fixed**, **Deprecated**, **Removed**, **Security**.

Initial backfill covers 0.5.0 and 0.6.0:

```markdown
# Changelog

All notable changes to `@metaobjectsdev/*` TypeScript packages will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0; MINOR
bumps may introduce breaking changes with notice).

## [0.6.0] — 2026-05-25

### Added
- **Cloudflare D1 dialect for `meta migrate`** — `--dialect d1`, `meta init --d1`,
  `wrangler.toml` binding resolution, `introspectD1` via shell-out, `renderD1` =
  `renderSqlite` + D1-safety post-pass (strip explicit txns, reject ATTACH/VACUUM),
  `writeMigrationD1` (Wrangler `<seq>_<slug>.sql` + `.down/` sidecar), optional `--apply`
  hook. See `docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md`.
- Projection (`source.dbView`) migrations now emit DDL for D1 alongside Postgres/SQLite.
- New `render` package added to the publish-candidate set (Tier 0); 12 packages now
  released in lockstep.

### Changed
- `Dialect` union extended to include `"d1"`; existing `"sqlite"` / `"postgres"` paths
  unchanged.
- `MigrateBlock` in `.metaobjects/config.json` gained an optional `d1` sub-block
  (`binding`, `remote`, `autoApply`, `wranglerConfigPath`).

### Fixed
- SQL injection in `introspectD1` pragma calls via crafted SQLite identifier names;
  pragma queries now double-quote-escape identifiers (kysely-based `introspectSqlite`
  path was already safe via Kysely's parameterization).
- Deleted dead `parseWranglerExecuteJson` export from `cli/lib/wrangler.ts`.
- `codegen-ts/src/templates/jsdoc.ts` satisfies `exactOptionalPropertyTypes`.

### Security
- Pragma identifier injection patched; see Fixed.

## [0.5.0] — 2026-05-23

First public release. 11 publish-candidate packages on `latest`; `cli` shipped as `0.5.1`
patch. Projects D–G shipped end-to-end (filter syntax, source-aware entities, currency,
TanStack codegen). See `spec/roadmap.md` for the full Projects D–G coverage.
```

Going forward: every release bumps the version section. Per-package CHANGELOGs are not
required at the monorepo workspace level; the root one captures the lockstep release.

### Naming convention in README

Append a section to `README.md` (or to a per-package `codegen-ts/README.md`):

```markdown
## Naming conventions: camelCase TS ↔ snake_case SQL

`@metaobjectsdev/codegen-ts` maps `snake_case` metadata field names to `camelCase` TS
property names by default. The underlying SQL column stays `snake_case`.

```jsonc
// Metadata
{ "field.long": { "name": "council_id" } }
```

```ts
// Generated TS — property is camelCase
import { councils } from "./generated/Council";
const id = council.councilId;
db.select().from(councils).where(eq(councils.councilId, "abc"));
```

```sql
-- Generated DDL — column stays snake_case
CREATE TABLE councils (
  council_id TEXT NOT NULL PRIMARY KEY,
  ...
);
```

To override the SQL column name per-field, use `@dbColumn`:

```jsonc
{ "field.long": { "name": "councilId", "@dbColumn": "council_uuid" } }
```

The mapping policy is project-wide via `columnNamingStrategy` in `metaobjects.config.ts`:
`snake_case` (default) | `literal` | `kebab-case`. See
`docs/superpowers/specs/2026-05-21-per-target-output-dirs-design.md` for the full
rationale.
```

## Tests / verification

- `CHANGELOG.md` lint: a one-line CI check (or pre-commit hook) verifying the file exists
  and is non-empty. Optional but cheap.
- No new code tests required.

## Out of scope

- Auto-generating `CHANGELOG.md` entries from commit conventions. We don't enforce
  conventional commits today; this would be a separate FR.
- Per-package `CHANGELOG.md`s. The root one captures the lockstep release; per-package
  files would duplicate.
- Translating the naming-convention docs to per-port specs in non-TS ports — that
  belongs in each port's own docs when their codegen ships.

## Open questions

None — purely additive docs.
