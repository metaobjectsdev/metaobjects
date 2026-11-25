---
name: metaobjects-verify
description: Use when checking a MetaObjects project for drift or changing its database schema — running and reading `meta verify` (--db, --codegen, --templates, --deps), emitting and applying migrations with `meta migrate`, fixing a model that will not load after an upgrade (`meta upgrade`), and interpreting conformance or test failures.
---

# MetaObjects verify + migrations

Metadata is the source of truth; generated code, the database schema and prompt text are
derived from it. `verify` finds where a derived artifact has stopped matching, and
`meta migrate` brings the database back in line.

## Essentials

- **Run a bare `meta verify` before you call MetaObjects work done, and `meta verify --db
  <url>` after anything that touched the schema.** A bare run covers the code gates only; the
  database gate is opt-in, and a skipped gate did not guard the build.
- **Each language's own migration tool is first-class; `meta migrate` is the reference
  helper, one option.** Hand your tool the schema `npx meta schema` prints, or let `meta migrate`
  emit the SQL. `meta verify --db` checks the live database whichever tool migrated it, in every
  port. Codegen and template drift run through each port's own build tool (table below).
- **Never change a live database by hand.** The schema is derived like generated code: change
  the metadata, then migrate (`meta migrate` or your own tool). A column added in `psql` is in
  no migration, so the next migration fails on it or quietly diverges.
- **A failure almost always means the metadata changed and a derived artifact did not
  follow.** Fix the artifact (regenerate, migrate) or the metadata, not the gate.
- **A model that does not load is not drift.** A retired name is a load error with no
  compatibility shim; `meta upgrade` rewrites it.
- **`verify` proves the artifacts match the model, never that the model is right.** A
  consistently wrong model passes clean; guard those rules with a ratchet lint.

## Reference files

| File | Open it when |
|---|---|
| `references/migration.md` | emitting or applying a migration, baselining, a first migration on a new database, view ownership (`@sql` / `@unmanaged`) |
| `references/requirements.md` | the project declares `requirement.*` nodes, or a requirement diagnostic appears in a run |
| `references/upgrading.md` | before upgrading MetaObjects, or when the project runs more than one port |

## What drifts

- **Database against metadata**: a column the metadata no longer declares, a missing index, a
  type mismatch. A modeled projection's view body is compared too.
- **Generated code against metadata**: committed generated code is not what the current
  metadata would emit (someone skipped a regen, or edited a generated file).
- **Prompt text against payload**: a template references a `{{field}}` that is not on its
  `@payloadRef` value object, so a renamed field quietly degrades a prompt.
- **A dependency's artifact against the lock file** (`--deps`).

Migrations cannot drift from metadata: they are emitted from a metadata diff.

One view case `verify --db` cannot see. A view body `origin.*` cannot express (a recursive
CTE, a window function) is declared with `source.rdb` `@sql` and stays drift-checked; a
database object owned elsewhere (Flyway, another application) is marked `@unmanaged: true` and
reported as external. A hand-written view carrying neither marker is reported as
informational and never failed, so an undeclared view standing in for an expressible
`object.projection` gets past this gate; the `metaobjects-audit` skill is what finds it.
`references/migration.md` has the full contract.

## The model has to load first: `meta upgrade`

`verify` cannot report drift in a model it could not read. The registry is sealed, so a
retired name has no deprecation shim: it is a load error (`ERR_UNKNOWN_ATTR` and the like) and
the run stops before the first drift check. Loosening strictness does not bring the name back.
Retirements an existing project meets: `@readOnly` became `@mutability`; `origin.collection`
became `origin.aggregate @agg: collect`; on `requirement.*`, `@violation` became
`@counterexample` and `@verifiedBy`, `@supersededBy` and `@status: abandoned | superseded`
were retired; an index key declaring both `@fields` and `@expr` is refused.

```
meta upgrade            # previews every rewrite; writes nothing
meta upgrade --apply    # makes them
```

It is Node-only because it edits the metadata documents every port shares: a Java, Python or
C# project runs `npx meta upgrade` against its own sources, canonical JSON and YAML alike. It
fixes only what has one correct answer and refuses the rest with a non-zero exit, so a
pipeline cannot record a partial migration as done. `references/requirements.md` says what it
refuses on a requirement ledger.

A stale dependency snapshot is also a load failure, in every command:
`ERR_DEPENDENCY_SNAPSHOT_STALE` names the fix, `meta deps sync`.

## A bare `meta verify`

In every port a bare run covers codegen drift, prompt-template drift, the requirement ledger
and the business-rules gate. `--db <url>`, `--deps` and `--replay` are opt-in. A run skips a
gate it has no configuration for and says so (Node `meta` with no `metaobjects.config.ts`,
Python with no `metaobjects.config.yaml`, `dotnet meta` with no `--out <dir>` or
`codegen/Generators.cs`, Maven with no `templateRoot`). Node `meta verify` ends every run with
a `not run:` line naming each gate it skipped and the flag that selects it. Read that line.

Three advisory passes ride along. None fails the build, and each finding names its fix:

- **Anti-pattern pass** (also on every `meta gen`): flags hand-written code the metadata could
  model and names the construct that replaces it. A hand-written aggregate (`AVG`, a
  `reduce` sum) → `origin.aggregate` on an `object.projection`; money as a float → `field.currency`;
  a `CHECK (... IN ...)` value set → `field.enum`. It is how a build that declares a
  projection but still aggregates by hand in a route gets noticed: model it and call the
  generated query.
- **Requirements**: requirements are metadata, so they are checked on every run with no
  subverb. The severity of a broken link depends on the requirement's `@status`
  (`references/requirements.md`).
- **Overlay lint**: a top-level node declared in two or more files where more than one
  declaration lacks `overlay: true`. One unflagged declaration is the base; each further one
  is a finding, because that is the state that forks into a second, disconnected object when
  the target is renamed, where a flagged overlay would fail loudly with
  `ERR_OVERLAY_NO_TARGET`. Mute with `--no-overlay-lint`.

**Read the whole report.** Text output caps each advisory section at 20 lines and says how
many it held back (`--limit <n>`, `--limit all`). On a pipe the default format is TOON: one
machine-readable document on stdout with every gate's verdict and every finding, uncapped,
and narration on stderr (`--format json` for JSON). A pass that did not run reports
`status: "skipped"` and why, so an empty list means "found nothing", never "did not look".

## The drift checks

- **`--db`**: introspects the live database and fails if it has diverged from the metadata.
  Node `meta` only, for every port and whatever tool migrated the database; the other ports'
  `verify` rejects `--db` with exit 2.
- **`--codegen`**: regenerates in memory and compares with the committed generated files, so a
  skipped regen fails the build.

  **A hand edit inside a generated file is reported apart from drift.** The Node gate judges
  the generated contribution against the committed `.metaobjects/.gen-state/.hashes/`, then
  lists each generated file carrying a hand edit. Whether that list fails the build is
  `verify.handEdits` in `.metaobjects/config.json`: `"fail"` exits 1 (what `meta init` writes
  for a new project); `"notice"`, and a project without the key, exits 0, so a weakened
  validator passes there. Check the key. `--forbid-hand-edits` forces `fail` for one run and
  `--allow-hand-edits` relaxes it for one run. To see one edit: delete the file, run
  `meta gen` (it re-emits the pristine generation), then `git diff -R -- <file>`;
  `git checkout -- <file>` restores it. If the edit changed a rule the model declares (a
  length, a range, a required field), make the change in the metadata so the database and
  every port follow it. An `<Entity>.names.ts` artifact always fails on a hand edit, and the
  C#, Java, Kotlin and Python gates compare bytes, so any edit fails there.
- **`--templates`**: for every `template.prompt` and `template.output`, resolves the text,
  parses each `{{...}}` reference, and fails if one is not on the payload value object.
- **`--deps`**: re-resolves each declared dependency and compares its artifact's hash with
  `.metaobjects/deps.lock.json` (the same check as `meta deps check`). Node `meta` resolves
  every transport; the other ports resolve `path` only and report anything else `unresolved`.
  `drifted` or `unresolved` fails with `ERR_DEPENDENCY_UPSTREAM_DRIFT`: review the artifact
  diff, then `meta deps sync`. It is not in the bare default because it needs the publisher's
  path reachable, which a CI checkout of only your repo may not have.

| Port | Codegen drift | Template drift | Dependency drift | Schema drift |
|---|---|---|---|---|
| TS | `meta verify --codegen` | `meta verify --templates` | `meta verify --deps`, `meta deps check` | `meta verify --db <url>` |
| Java / Kotlin | `mvn metaobjects:verify -Dmeta.verify.mode=codegen` | `mvn metaobjects:verify -Dmeta.verify.mode=templates` | `mvn metaobjects:verify -Dmeta.verify.mode=deps` | Node `meta verify --db` |
| C# | `dotnet meta verify --codegen` | `dotnet meta verify --templates` | `dotnet meta verify --deps` | Node `meta verify --db` |
| Python | `metaobjects verify` (codegen is in the default) | n/a | `metaobjects verify --deps`, `metaobjects deps check` | Node `meta verify --db` |

A clean run is silent. A failure names the entity or template, the drifted artifact and, for
templates, the missing reference.

## Schema migrations: `meta migrate` is the reference helper, one option for every port

Each language's native migration tool is first-class (EF Core Migrations, Flyway or Liquibase,
Exposed, Alembic, sqlx), handed the schema `npx meta schema` prints. The Node `meta migrate` is
the reference migration helper, one option for TypeScript, Java, Kotlin, C#, Python and Rust
alike. When the project uses it, it diffs metadata against the schema, emits the migration SQL
and applies it. Point it at the same database your server connects to:

```
meta migrate --from-db --db postgresql://... --dialect postgres --slug init --apply
                                                    # first migration on a brand-new database
meta migrate --dialect postgres --slug add-user-shipping          # everyday: emit migration SQL
meta migrate --dialect postgres --slug add-user-shipping --apply --db postgresql://...
                                                    # ...and apply it
meta migrate --dialect postgres --slug add-user-shipping --dry-run   # preview without writing
```

- Always pass `--dialect`: it selects the diff pipeline, not only the SQL flavor. It is
  required offline and on `baseline`; with `--db` it can be detected from the URL.
- Do not run `meta migrate baseline` on a database that does not exist yet
  (`references/migration.md`).
- Dialects: `postgres` (default), `sqlite` and `d1` (Cloudflare D1, TypeScript only). MySQL is
  a codegen and runtime dialect only: `meta migrate --dialect mysql` is refused and you own
  the DDL.
- The JVM, C# and Python ports have no migration command of their own and no runtime schema
  auto-create. Their dev, test and production databases are provisioned by the project's
  migration tool, which may be `meta migrate`. Each port's `gen` tooling stays native to its
  language.

## Never hand-edit the live database

No `psql` or console `ALTER TABLE` / `CREATE` / `DROP`: not to preview a column, not to patch
a mismatch, not to unblock a boot. It is the usual way a database reaches a state no
migration can reproduce. The column exists but no migration recorded it, so the next
`meta migrate` tries to add it again and fails on `column ... already exists`, or the
difference surfaces days later. "Just adding it quickly to see it" does not feel like a
schema change, which is why it skips the metadata-first step; it is one.

Apply every schema change the same way: change the metadata, then `meta migrate` (or, in a
project that drives its own migrator, a migration written to match the regenerated schema).
To see a new column in a tool or an app, apply the migration and look again.

`meta verify --db` is a done-check, not only a CI gate. Run it after any work that touched the
database or the metadata that shapes it: it fails on exactly this drift (a hand-added column,
a missing index, a mismatched type) at once, not at the next boot.

## What `verify` cannot catch: a model that is wrong but consistent

The drift checks compare derived artifacts with the metadata. They do not ask whether the
metadata models the right thing. The usual case is a UUID column modeled as `field.string`
with `@dbColumnType: uuid`: the generated property is a string, the column really is `uuid`,
so `verify --db` passes while every consumer converts between string and UUID (the
`metaobjects-authoring` skill covers the smell). Nothing drifted; the model is wrong.

For a rule like that, add a project-local CI lint over the metadata sources. A grep is enough:

```
# fail the build if any field.string carries @dbColumnType: uuid.
# Illustrative: tune the matcher to your source format (canonical JSON or sigil-free YAML).
! grep -rEzl '"field\.string"[^}]*"@dbColumnType"[^}]*"uuid"' metaobjects/
```

Make it a ratchet: it stays red until the last offending field is `field.uuid`, so it is both
the migration's completion check and a permanent guard against the smell coming back.

The other rule worth a ratchet is **no physical name as a literal**. Nothing in `verify`
reads the code you wrote: `--codegen` compares generated files with a fresh generation and
`--db` compares the database with the metadata. Build the alternation from the metadata's own
`@table` / `@view` / `@column` values and fail on any hit outside generated output:

```
# fail the build if a declared physical name is spelled in hand-written source.
# Illustrative: generate the alternation from your metadata. A typed ORM handle never matches.
! grep -rEn '"(orders|created_at|purpose_code)"' src/ --exclude-dir=generated
```

The fix for a hit is the `<Entity>Names` constant (`metaobjects-runtime-ui`).

## Reading conformance and test failures

MetaObjects' behavior is pinned by cross-port conformance corpora (metamodel, render,
persistence, API contract, verify). The corpus is the contract, so when output disagrees with
a fixture the output is what is wrong:

- A **loader** failure cites an `ERR_*` code (`ERR_RESERVED_ATTR`, `ERR_UNRESOLVED_SUPER`,
  `ERR_MISSING_REQUIRED_ATTR`, `ERR_BAD_ATTR_VALUE`, `ERR_YAML_COERCION`): fix the metadata,
  not the loader.
- A **render or verify** failure means rendered bytes or a template-drift result diverged
  from the pinned expectation, usually a payload and text mismatch.
- A **persistence or API-contract** failure means a query row or an HTTP response shape
  diverged: a bug in the code under test, not in the corpus.
