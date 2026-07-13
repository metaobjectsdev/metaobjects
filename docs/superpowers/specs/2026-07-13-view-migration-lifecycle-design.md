# View migration lifecycle — fingerprint convergence, non-destructive replace, loud cascades

**Date:** 2026-07-13
**Status:** Design proposal (no implementation yet)
**Scope:** TypeScript only. Schema migration is TS-owned (ADR-0015) — the Java/Python/C#
migrate engines were removed — so there is **no cross-port fan-out** for this work.
**Packages touched:** `server/typescript/packages/migrate-ts`, `server/typescript/packages/codegen-ts`
(projection view builder), `server/typescript/packages/cli` (allow flags + messaging).

---

## 1. The bug

**`replace-view` fires on every `meta migrate` for every projection view on Postgres,
forever, on a schema with zero metadata changes.** Verified empirically on live
Postgres 16 (2026-07-13).

### 1.1 Root cause: comparing text against a deparser

The pipeline is `buildExpectedSchema(metadata)` → `diff({expected, actual: introspect(db)})`
→ `emit(changes, {dialect})` → apply. The diff compares view bodies textually via
`viewSqlEquals` (`migrate-ts/src/view-sql-compare.ts`): strip the `CREATE VIEW … AS`
prefix, collapse whitespace, lowercase, compare strings.

But **Postgres does not store view SQL.** It stores the *parse tree* (as a rewrite rule
in `pg_rewrite`), and `pg_get_viewdef(c.oid)` — what `readPgViews()` in
`migrate-ts/src/introspect/postgres.ts` reads — **deparses** it back to text in
Postgres's own canonical style. Dumped from live PG 16, for the same view:

We emit (via `codegen-ts` `emitViewDdl`):

```sql
SELECT p.id AS "programId", COUNT(DISTINCT w.id) AS "weekCount", ...
FROM programs p
LEFT OUTER JOIN weeks w ON w."programId" = p.id
GROUP BY p.id
```

`pg_get_viewdef` returns:

```sql
SELECT p.id AS "programId", count(DISTINCT w.id) AS "weekCount", ...
FROM (programs p LEFT JOIN weeks w ON ((w."programId" = p.id)))
GROUP BY p.id
```

The deparser lowercases function names, rewrites `LEFT OUTER JOIN` → `LEFT JOIN`,
parenthesizes the FROM item and the ON predicate, and drops redundant aliases — and
that is just what *this* view exercises. Whitespace-collapse + lowercase cannot bridge
any of it. `viewSqlEquals` therefore returns `false` for every managed view on every
run, and `diffViews` (`migrate-ts/src/diff/index.ts`, Pass 2b) emits `replace-view`
every time. `replace-view` is an always-allowed change kind (`diff/status.ts`), so
every incremental migration silently carries a full re-`CREATE OR REPLACE` of every
projection view.

The comment in `readPgViews` — the body is carried "so the diff can detect view-body
drift (not just name presence)" — is false in practice: with a 100% false-positive
rate the comparator detects nothing. `meta verify --db` (`drift/drift.ts` →
`computeDrift`) shares the same diff, so **the drift gate is permanently red for any
project with a projection view on Postgres** — which trains adopters to ignore it.

### 1.2 Why no amount of textual normalization can fix it

Converging text against `pg_get_viewdef` means predicting the deparser: keyword case,
join-syntax rewrites, parenthesization, alias elision, `::` cast insertion
(`WHERE status = 'x'` deparses as `'x'::text` for varchar columns), `IN` →
`= ANY (ARRAY[…])` rewrites, and more — an open-ended set that changes across PG major
versions. A normalizer that handles all of it *is* a reimplementation of the deparser.
Every serious tool in this space has concluded the same (see §3): you either round-trip
**both** sides through the database's own normalizer (shadow/simulation approach), or
you stop comparing text and compare a **fingerprint you control**.

**SQLite/D1 are unaffected**: `sqlite_master.sql` stores the `CREATE VIEW` text
verbatim (`introspect/sqlite-shared.ts` `readSqliteViews`), so the existing comparator
genuinely converges there — proven by the sqlite drift tests.

### 1.3 Why the test suite never caught it

Two structural gaps, both instances of the "a passing golden can encode the bug"
failure mode this codebase has now hit three times:

1. **`test/unit/diff.test.ts` → "diff — view-body drift" suite** feeds *hand-authored,
   matching* bodies to both sides ("same-named view, identical body
   (whitespace-normalized) → no change"). On real Postgres the actual side is never
   hand-authored — it is deparser output. The test pins the comparator's behavior on
   inputs that cannot occur, and its green status is exactly what let the false claim
   in the `readPgViews` comment survive. There is **no test anywhere** that runs
   `viewSqlEquals`/`normalizeViewSql` against a real deparsed body (verified by grep:
   zero direct tests of either function).
2. **The 0.15.21 `emit → apply → introspect → re-diff must be EMPTY` round-trip gate**
   (`test/integration/postgres-roundtrip.test.ts`) — added precisely because "nothing
   ever ran the pipeline twice against a real DB" — **contains no view scenario**. The
   one gate designed to catch this class has a view-shaped hole.

---

## 2. Design overview

Three coordinated changes, matching the three requirements:

1. **Fingerprint convergence (Postgres).** Stop comparing view text against the
   deparser. At view create/replace time, stamp a content hash of the *generated* body
   into the view's comment (`COMMENT ON VIEW … IS 'metaobjects:v1:sha256:<hex>'`).
   Introspection reads it back via `obj_description(oid, 'pg_class')`. The diff
   compares hashes. Convergence is exact, drift detection is real, and the marker
   doubles as the **managed/unmanaged discriminator** — a hand-written view over a
   projection (doctrine: that is drift, currently invisible) now surfaces, blocked
   behind an explicit adopt flag.
2. **Non-destructive replace wherever legal.** Postgres `CREATE OR REPLACE VIEW` is
   legal only when the new definition keeps every existing output column's *name, type,
   and position* and appends new columns at the end (PG docs, §4.1). The diff learns to
   *decide* replace-vs-drop from the expected column list vs the introspected actual
   column list, instead of hoping. Additive projection changes (field appended) stay
   `CREATE OR REPLACE` — dependents, grants, and comments survive. Everything else
   becomes an explicit, gated drop+create.
3. **Loud cascades.** Introspection enumerates dependent views via
   `pg_depend`/`pg_rewrite` (the dependency is recorded on the dependent view's
   rewrite rule — the classic gotcha). Any `DROP VIEW` whose target has dependents
   outside the migration is **blocked** with the dependent chain in the message; a new
   `--allow drop-view-cascade` emits `DROP VIEW … CASCADE` with a warning banner
   enumerating exactly what will be destroyed. This extends the 0.15.21 fix ("
   `drop-view` was auto-allowed" — see CHANGELOG 0.15.21 and `diff/status.ts`), it does
   not replace it.

Non-goals: materialized views stay hand-managed (already documented in
`build-projection-views.ts` — no CREATE MATERIALIZED VIEW emit, invisible to
`information_schema.views`); no auto-save/restore of *unmanaged* dependents in v1
(§7.3); no view rename detection in v1 (§9).

---

## 3. Prior art (researched 2026-07-13)

| Tool | How it handles declarative views | What we take |
|---|---|---|
| **Atlas** (ariga.io) | Views are first-class schema objects since v0.13; declarative diff plans view changes; 50+ "safety analyzers" lint destructive changes before apply, with a configurable diff policy (e.g. `skip destructive`). Ships a testing framework for views. ([atlasgo.io](https://atlasgo.io/), [v0.13 announcement](https://atlasgo.io/blog/2023/08/06/atlas-v-0-13), [diff policy write-up](https://blog.palark.com/atlas-for-mysql-postgresql-database-schema-migrations/)) | The *shape* of our requirement 3: destructive view changes are a lint/block class with an explicit override, not a silent emit. |
| **alembic_utils** (`PGView` "replaceable entities") | The gold standard for the convergence problem: `get_database_definition` **creates the candidate entity in the database inside a transaction, reads back the database-rendered definition, rolls back** — so *both* sides of the comparison have been through PG's deparser, and simple whitespace-normalized equality is then sound. ([replaceable_entity.py](https://github.com/olirice/alembic_utils/blob/master/src/alembic_utils/replaceable_entity.py), [docs](https://olirice.github.io/alembic_utils/api/)) | Validates that nobody converges *textually* against the deparser. We choose the fingerprint over simulation for `migrate`/`verify` because simulation needs a writable transaction against the target DB on every diff (unacceptable for a read-only drift gate) and behaves badly when the view's *source tables* don't exist yet mid-plan. Simulation is noted as a future deep-verify option (§9). Also instructive: their issue #9 — views referencing views need creation-order handling. |
| **Flyway** | No view model at all — views live in repeatable `R__` migrations, re-run whenever the file **checksum** changes. ([comparison](https://www.jusdb.com/blog/liquibase-vs-flyway-database-migration-comparison)) | The checksum-of-the-source idea *is* the fingerprint, minus the stored-in-DB half. Flyway stores it in its history table; we store it on the object itself so it survives out-of-band DBs and needs no ledger row per view. |
| **Liquibase** | `createView replaceIfExists` maps to `CREATE OR REPLACE VIEW`; a long tail of issues where the naive text handling breaks (e.g. [#1849](https://github.com/liquibase/liquibase/issues/1849): the word "replace" anywhere in the body defeats the rewrite; [#2732](https://github.com/liquibase/liquibase/issues/2732): PG 12 replaceIfExists regressions). Tracks applied changesets by MD5 checksum. | A cautionary tale for string-level cleverness in view DDL handling. |
| **dbt** | Rebuilds views from a `ref()` DAG in topological order. Its `--full-refresh` **drop cascade** behavior is the canonical horror story for requirement 3: dropping an upstream view cascades away downstream views *that other things are querying*, and they stay gone until their own node happens to run — [dbt-core #2185](https://github.com/dbt-labs/dbt/issues/2185), [forum reports](https://discourse.getdbt.com/t/full-refresh-also-deleted-view-which-were-using-the-table/17312). Redshift adopters escape via late-binding views. ([full_refresh docs](https://docs.getdbt.com/reference/resource-configs/full_refresh)) | Exactly why an emitted `CASCADE` must be blocked-by-default and enumerate its victims. Also the topological-order discipline for recreating managed dependents. |
| **pgroll** (Xata) | Hides tables behind per-version *views* to get multi-version schemas; notably it has no answer yet for user views themselves ("no way to provide access to multiple versions of the same view"). ([xata.io/blog/pgroll-schema-migrations-postgres](https://xata.io/blog/pgroll-schema-migrations-postgres)) | Confirms views are the hard unsolved edge even for well-funded tools; nothing to steal directly. |
| **Skeema** | Declarative MySQL/MariaDB; views are a Premium-only feature and the community edition *ignores them entirely* rather than half-support them. ([skeema.io/docs/features/views](https://www.skeema.io/docs/features/views/)) | The honesty of scoping: half-supported views are worse than none. |
| **Redgate SQL Compare** | Deploys views in dependency order computed from the object graph; includes dependents when deploying a changed object. ([forum: dependency order](https://forum.red-gate.com/discussion/15842/how-does-sql-compare-work-out-dependency-order)) | Dependency-ordered emission for managed view chains. |
| **Postgres community pattern** ("view dependency rebuild") | `deps_save_and_drop_dependencies` / `deps_restore_dependencies`: recursively find dependents via `pg_depend` → `pg_rewrite` → `pg_class`, save each dependent's DDL (+ comments + grants) into a helper table ordered by `max(depth)`, drop, do the change, restore in reverse order. ([Pretius write-up](https://pretius.com/blog/postgresql-alter-table-replace-view-dependencies), [mateuszwenus gist](https://gist.github.com/mateuszwenus/11187288), [CYBERTEC on pg_rewrite indirection](https://www.cybertec-postgresql.com/en/tracking-view-dependencies-in-postgresql/)) | The exact catalog query (§7.1) and the depth-ordered restore idea (deferred to a later phase for unmanaged dependents, §7.3). |

Summary of the field: **nobody diffs view text against `pg_get_viewdef`.** They either
(a) re-run source on checksum change (Flyway), (b) simulate through the deparser
(alembic_utils), (c) rebuild unconditionally from a DAG (dbt), or (d) treat views as a
lintable object class with destructive-change gates (Atlas). Our fingerprint design is
(a) + (d), with the checksum stored on the object so the diff stays read-only.

---

## 4. Fingerprint design (Postgres)

### 4.1 Hash input — defined over the normalized generated body

The fingerprint must be a **pure function of what we generate**, never of what PG
stores. Definition:

```
fingerprint(body) = sha256( utf8( normalizeForFingerprint(body) ) )   // lowercase hex, 64 chars

normalizeForFingerprint(body):
  1. strip a leading `CREATE [OR REPLACE] VIEW <name> AS` if present   (defensive; expected side is body-only)
  2. collapse every whitespace run to a single space
  3. strip a trailing `;`
  4. trim
  — and nothing else. NO lowercasing.
```

Rationale:

- **Stable across formatting churn** in `emitViewDdl` (indentation, line breaks) — a
  pretty-printing change must not re-stamp every deployed view.
- **No lowercasing**, deliberately diverging from `normalizeViewSql`: lowercasing
  existed only to chase the deparser (which we no longer chase) and it masks drift in
  case-sensitive string literals (`@filter` values like `'Active'` — the documented
  CAVEAT in `view-sql-compare.ts` becomes real now that aggregate filters carry
  literals). Both fingerprint inputs come from the same emitter, so case-insensitivity
  buys nothing.
- **Semantic emitter changes re-stamp honestly.** If a future `emitViewDdl` renders
  `LEFT JOIN` instead of `LEFT OUTER JOIN`, hashes change and every view gets one
  `replace-view`. That is correct — the deployed view genuinely was created from
  different SQL — and it is a one-time, non-destructive `CREATE OR REPLACE` (§5).

Implementation: a new `migrate-ts/src/view-fingerprint.ts` owning
`normalizeForFingerprint`, `viewFingerprint(body)`, `renderFingerprintComment(fp)`,
`parseFingerprintComment(comment)`. Hashing uses `node:crypto` `createHash("sha256")`
exactly as `snapshot/checksum.ts` already does. **The hash is computed inside
migrate-ts** (in `buildExpectedSchema`, from the threaded-in `ExpectedView.sql`) so the
producer and the parser of the marker live in one module and `codegen-ts` stays
ignorant of migrate concerns — preserving the existing dependency direction
(migrate-ts never imports codegen-ts; the CLI threads views in).

### 4.2 Comment format and versioning

```
metaobjects:v1:sha256:3fa4b1…e9   (marker line)
```

- `metaobjects:` — namespace, consistent with existing generated-artifact markers.
- `v1` — **format version**, bumped only if the normalization rules or marker grammar
  change. A parseable marker with an *unknown* version means "managed by a newer/older
  toolchain": treat as managed, fingerprint-unknown → propose `replace-view`
  (allowed — it is ours) and re-stamp. This makes format migration self-healing.
- `sha256:` — algorithm tag, so a future algorithm swap does not need a `v` bump.
- Marker grammar (parser): `/(?:^|\n)metaobjects:v(\d+):sha256:([0-9a-f]{64})\s*$/`.
  The marker is a **trailing line** of the comment. Today we own the whole comment; if
  projections later gain `@description` → `COMMENT ON VIEW`, the human text goes above
  the marker line and the parser is already position-tolerant.

Emission (`emit/postgres.ts` `renderCreateView`): every `create-view` / `replace-view`
is followed by

```sql
COMMENT ON VIEW "v_program_summary" IS 'metaobjects:v1:sha256:<hex>';
```

Notes: `COMMENT ON` is already proven through the whole emit→apply pipeline (table and
column descriptions use it — `renderTableComments` / `emit-postgres-comment-on.test.ts`),
including statement splitting. `CREATE OR REPLACE VIEW` does **not** clear an existing
comment, so re-stamping explicitly on every replace is required and sufficient;
drop+create clears it and the paired create re-stamps.

Introspection (`introspect/postgres.ts` `readPgViews`): add
`obj_description(c.oid, 'pg_class') AS view_comment` to the existing query, parse the
marker → `ViewDescriptor.fingerprint`. Keep reading `pg_get_viewdef` — no longer for
comparison, but as the **restore payload** for down migrations (§4.5). pg-mem: the
query already lives in a try/catch that returns `[]`; unchanged.

### 4.3 Diff semantics on Postgres

`diffViews` becomes dialect-aware (it already receives `args.dialect`). For
`dialect === "postgres"`, per (schema, name) identity:

| expected | actual | fingerprints | result |
|---|---|---|---|
| present | absent | — | `create-view` (allowed) — unchanged |
| present | present | equal | **no change** — the fix |
| present | present | differ | `replace-view` if replace-legal (§5), else drop+create pair |
| present | present | actual has **no marker** | `replace-view` (or drop+create per §5), **blocked**: `adopt-view` (§4.4) |
| present | present | actual marker has unknown `v` | `replace-view` per §5, allowed (managed, self-healing) |
| absent | present, **marker present** | — | `drop-view`, gated by `allow.dropView` — a *managed* view whose projection was deleted |
| absent | present, no marker | — | `drop-view`, gated by `allow.dropView` (unchanged 0.15.21 behavior); the CLI message now additionally says "unmanaged (no MetaObjects fingerprint)" so the operator knows it is not ours |

The existing guard "either side's knowledge missing → leave it alone rather than emit a
spurious replace" is preserved: expected `sql` undefined, or an introspector that could
read neither body nor comment (pg-mem), produces no view change — matching current
pg-mem behavior.

`viewSqlEquals` is **removed from the Postgres path entirely**. It remains the SQLite
comparator (§6). The stale claim in `view-sql-compare.ts`'s header and in
`readPgViews`'s comment must be rewritten as part of the change.

### 4.4 Unmanaged views and the adopt gate

A same-named view **without** a fingerprint is either (a) a pre-fingerprint managed
view (every deployment upgraded from ≤ 0.15.21 — the entire installed base on day one),
or (b) a genuinely hand-written view sitting where a projection expects one. On
Postgres these are **indistinguishable** (the deparser destroyed the text evidence), and
overwriting (b) destroys hand-written SQL that no down migration can recover. So:
fail closed.

- The change is emitted as `replace-view` with
  `status: { state: "blocked", blockedReason: "existing view \"<name>\" has no MetaObjects fingerprint (hand-written, or created before fingerprinting) — pass --allow adopt-view to overwrite it and take ownership" }`.
- New allow token `adopt-view` → `AllowOptions.adoptView`.
- **Upgrade cost:** one `meta migrate --allow adopt-view` run per environment after
  upgrading, which stamps every projection view. The CLI blocked-output should
  recognize the all-views-unstamped pattern and print the exact command. Loud once,
  silent forever after — the correct trade for a class that was silently destructive.
- Doctrine payoff: `meta verify --db` uses the same diff, so a hand-written view over a
  projection — previously *invisible* to the drift gate — now fails it, which is what
  `docs/features/downstream-metadata-decisions.md` and the agent-context skills promised
  ("a hand-written view is drift").

Known, accepted limitation: a DBA who edits the view via `CREATE OR REPLACE VIEW` *and
leaves our comment in place* forges "current". The fingerprint verifies
declared-vs-stamped, not stamped-vs-actual-parse-tree. The precise tamper detector is
the alembic_utils simulation trick (§9, future `verify --db` deep mode).

### 4.5 Restorable down migrations (opportunistic win)

Today `renderDown` for `drop-view`/`replace-view` emits
`-- WARNING: down migration cannot restore the original view definition`. We already
hold the restore payload: the deparsed body from `pg_get_viewdef` (valid PG SQL) plus
the old marker. Add `restore?: ViewDescriptor` to the `drop-view` and `replace-view`
change variants (mirroring `drop-table`/`drop-index`/`drop-fk`/`drop-check`), populated
by the diff from the actual descriptor. Down becomes:

```sql
CREATE OR REPLACE VIEW "v_x" AS <deparsed body>;
COMMENT ON VIEW "v_x" IS '<old marker verbatim, or NULL if none>';
```

Re-stamping the *old* marker verbatim is faithful: the restored parse tree is exactly
the pre-migration view, and the old marker was its stamp. SQLite gets the same for free
— its introspected `sql` is the full verbatim `CREATE VIEW` statement.

---

## 5. Replace vs drop — the decision table

### 5.1 The Postgres rule

Per the [CREATE VIEW documentation](https://www.postgresql.org/docs/current/sql-createview.html):

> "The new query must generate the same columns that were generated by the existing
> view query (that is, the same column names in the same order and with the same data
> types), but it may add additional columns to the end of the list. The calculations
> giving rise to the output columns may be completely different."

So `CREATE OR REPLACE VIEW` is legal **iff the actual view's column list is a prefix of
the expected view's column list, compared on (name, type, position)**. When legal it is
strictly better than drop+create: dependent views, grants (ACLs), and the object's OID
survive; body-only changes (joins, filters, aggregate expressions) are free.

### 5.2 Deciding legality in the diff — introspected columns, derived expected types

The diff must *decide*, not attempt-and-fail: an illegal OR REPLACE errors at apply
time (`cannot change name of view column …` / `cannot change data type of view
column …` / `cannot drop columns from view`), aborting the migration mid-transaction
with no plan-time warning. Inputs:

- **Actual side**: the view's output columns with types. Views are relations —
  `information_schema.columns` reports them exactly like table columns, so the existing
  `readColumns(k, schema, name)` + `pgTypeToSqlType` machinery is reused verbatim for
  each introspected view. New field `ViewDescriptor.columns?: ViewColumnDescriptor[]`
  (`{ name: string; sqlType: SqlType }`, ordered).
- **Expected side**: `codegen-ts`'s `ExpectedView` gains a `columns` array carrying
  what `extractViewSpec` already knows, in emitted order:
  `{ name /* dbColAlias */, kind: "passthrough" | "aggregate", sourceTable, sourceColumn, agg? }`.
  `migrate-ts`'s `buildExpectedSchema` then resolves each to a `SqlType` **from its own
  expected table descriptors** (passthrough → the source column's type; aggregate → the
  PG result-type rules below). This keeps `codegen-ts` free of `SqlType` knowledge and
  `migrate-ts` free of metadata traversal — the existing layering.

Aggregate result-type rules (PG semantics, small fixed table):

| agg | argument type | result type |
|---|---|---|
| `count` | any | `integer{bits:64}` (bigint) |
| `sum` | smallint/integer | bigint |
| `sum` | bigint | numeric |
| `sum` | numeric / real / double | same as argument |
| `avg` | any integer / numeric | numeric |
| `avg` | real / double | double precision |
| `min`/`max` | any | argument type |

Legality check (`diff`): `replaceLegal(expectedCols, actualCols)` = `actualCols` is a
prefix of `expectedCols` under `(name === name) && sqlTypeEquals(type, type)`
positional comparison. **Fail-safe direction:** if either column list is unavailable
(pg-mem, an unresolvable derivation), legality is `false` → drop+create, which is
gated and loud — a derivation bug can never produce a failed apply, only extra noise.

### 5.3 Decision table by projection-change class

| Projection change | Effect on output columns | Plan | Destructive? |
|---|---|---|---|
| Field **appended** (declared last) | new column at end | `replace-view` (OR REPLACE) | No — dependents/grants survive |
| Aggregate `@filter` added / changed / removed | none (body only) | `replace-view` | No |
| `@agg` changed, result type unchanged (e.g. `min`→`max`; `count`→`sum` over int) | none | `replace-view` | No |
| `@agg` changed, result type changes (e.g. `sum` over bigint → `count` is fine, but `count` → `avg` is bigint→numeric) | type change in place | drop+create | Yes — gated per §7 |
| Join path / `@via` change, same columns | none | `replace-view` | No |
| Field **inserted mid-declaration** | column order changes | drop+create | Yes — gated; see §5.4 |
| Field removed | column removed | drop+create | Yes |
| Field renamed (alias change) | column renamed | drop+create | Yes |
| `columnNamingStrategy` change | mass alias rename | drop+create fan-out | Yes — very loud |
| Source-table column ALTER that the view reads | n/a — PG blocks the ALTER itself | existing Pass 2c drop-before/create-after pair, now dependent-aware (§7) | Only to external dependents |
| View renamed (`@table` on the `source.rdb`) | different identity | `drop-view` (gated) + `create-view` | Yes — no rename detection in v1 (§9) |

### 5.4 Column-order canonicalization: declaration order is already optimal

Investigated per the requirement ("can reordering be canonicalized so an added field
naturally lands last?"). Finding: **the emitted column order is the projection's
declared field order** — `buildSelectSpec` (`codegen-ts/src/projection/extract-view-spec.ts`)
iterates `projection.ownChildren()` in declaration order, and `emitViewDdl` renders
`spec.selectSpec.columns` in that order. Verified in source.

- A metadata-independent stable order (e.g. alphabetical) would be strictly **worse**:
  a new field would land at its sort position, not at the end, shrinking the replaceable
  class, and the switch itself would reorder every existing deployed view (a one-time
  drop+create fan-out with zero benefit).
- Reordering the expected emit to match the *live DB's* incidental column order would
  make emitted SQL a function of DB state — the same metadata would emit different
  migration files against different environments, breaking committed-migration replay
  (`verify/replay.ts`) and the snapshot checksum.
- Therefore: **keep declaration order**, and encode the consequence as authoring
  guidance in the projection docs and the agent-context skills:
  *"append new projection fields at the end of the declaration → non-destructive
  `CREATE OR REPLACE`; inserting mid-list reorders the view's columns and forces a
  gated drop+create."* Field order inside a projection has no other semantic load, so
  this costs authors nothing. The blocked-change message for an order-change
  drop+create should teach it: "hint: appending the new field at the end of the
  projection makes this a non-destructive replace".

---

## 6. SQLite / D1

Decision: **SQLite keeps verbatim-body compare for equality** — it is exact there
(`sqlite_master.sql` is stored verbatim), proven convergent by `drift-sqlite` and the
sqlite roundtrip tests, and switching it to hashes would churn every deployed SQLite/D1
view for zero convergence benefit. `view-sql-compare.ts` survives as the
SQLite-only comparator (header comment rewritten to say so).

**Phase 2 (managed-marker parity):** SQLite has no `COMMENT ON`, but it preserves SQL
comments inside the stored statement text. Emit the marker as a trailing body comment:

```sql
CREATE VIEW "v_x" AS
  SELECT ... /* metaobjects:v1:sha256:<hex> */;
```

- Equality still uses body compare (with the marker comment stripped by the
  normalizer on both sides, so pre-marker and post-marker bodies compare equal).
- The marker's only job on SQLite is the **managed/unmanaged discriminator**, closing
  the same destructive hole as on PG: today a hand-written same-named view on SQLite is
  silently overwritten, because `replace-view` is auto-allowed and renders
  `DROP VIEW IF EXISTS + CREATE`. With the marker: bodies differ + no marker →
  blocked `adopt-view`, same UX as PG.
- **Grandfathering (SQLite only, and only here):** no marker + *marker-stripped bodies
  compare equal* → provably our pre-upgrade view; propose `replace-view` **allowed**
  (stamps the marker, loses nothing). This gentler upgrade is possible on SQLite
  precisely because body comparison is trustworthy there; PG cannot have it.

D1 rides the SQLite emitter unchanged (D1 is SQLite at the SQL level; the
`d1-safety-pass` does not touch view statements). Phase 2 is separable and should land
after the PG work proves the marker grammar.

---

## 7. Cascades and dependents (Postgres)

### 7.1 The catalog query

A view's dependency on the relations it reads is **not** recorded as
view-depends-on-table. It is recorded as *the view's rewrite rule* (`pg_rewrite`, the
`_RETURN` rule holding the parse tree) depending on each referenced relation — the
classic `pg_depend` gotcha ([CYBERTEC: Tracking view dependencies in PostgreSQL](https://www.cybertec-postgresql.com/en/tracking-view-dependencies-in-postgresql/),
[mateuszwenus gist](https://gist.github.com/mateuszwenus/11187288)). Two consequences:
you must join through `pg_rewrite` to find dependents, and **every view depends on
itself** through its own `_RETURN` rule, which must be excluded or a recursive walk
loops forever.

Direct dependents of every user view, one query for the whole DB (no per-view N+1),
added to `introspect/postgres.ts` as `readPgViewDependents`:

```sql
SELECT ref_ns.nspname  AS on_schema,   -- the view being depended ON
       ref_cl.relname  AS on_name,
       dep_ns.nspname  AS dep_schema,  -- the DEPENDENT relation
       dep_cl.relname  AS dep_name,
       dep_cl.relkind  AS dep_relkind  -- 'v' view, 'm' materialized view
FROM pg_depend d
JOIN pg_rewrite  r      ON r.oid = d.objid
JOIN pg_class    dep_cl ON dep_cl.oid = r.ev_class
JOIN pg_namespace dep_ns ON dep_ns.oid = dep_cl.relnamespace
JOIN pg_class    ref_cl ON ref_cl.oid = d.refobjid
JOIN pg_namespace ref_ns ON ref_ns.oid = ref_cl.relnamespace
WHERE d.classid    = 'pg_rewrite'::regclass
  AND d.refclassid = 'pg_class'::regclass
  AND d.deptype    = 'n'
  AND ref_cl.relkind = 'v'
  AND dep_cl.oid <> ref_cl.oid                       -- exclude the self _RETURN rule
  AND ref_ns.nspname NOT IN ('pg_catalog','information_schema')
  AND ref_ns.nspname NOT LIKE 'pg_%'
```

Result stored as `ViewDescriptor.dependents?: DependentRelation[]`
(`{ schema, name, relkind: "v" | "m" }`, direct only). The **transitive closure and
depth ordering are computed in TS** by the diff (walking the direct-dependents map),
not by a recursive SQL CTE — simpler to test, and the closure over already-fetched
edges is trivial. Matview dependents (`relkind = 'm'`) matter even though matviews are
otherwise unmanaged: they can depend on our views and would be destroyed by a CASCADE.
pg-mem: wrap in the standard try/catch → `undefined` (dependents unknown → treated as
none; pg-mem is a test-only engine and the real-PG integration tests are the gate).

### 7.2 Blocking rules and allow-flag UX

Classify each planned `DROP VIEW` target's transitive dependents into:

- **internal** — a managed view that this same migration also drops and recreates
  (present in the `recreatedViews` set that `applyStatus` already computes);
- **external** — everything else: unmanaged views, matviews, managed views *not* being
  recreated in this migration.

Rules (extending `blockedReasonFor` in `diff/status.ts` — the change record gains the
dependent info at diff time, since `applyStatus` sees only changes):

| Situation | Today | New behavior |
|---|---|---|
| Real `drop-view`, no dependents | blocked → `allow.dropView` (0.15.21) | unchanged |
| Real `drop-view`, **external dependents** | blocked by dropView, but with the flag emit would be a plain `DROP VIEW` that **fails at apply** ("cannot drop … because other objects depend on it") | blocked; requires **both** `drop-view` and the new **`drop-view-cascade`**; with both, emit `DROP VIEW … CASCADE` + warning banner |
| Recreate-pair drop (Pass 2c / §5 drop+create), no external dependents | exempt from dropView (view survives) | unchanged — still exempt |
| Recreate-pair drop, **external dependents** | plain `DROP VIEW` fails at apply — a runtime surprise | blocked: the drop destroys the externals even though our view returns; requires `drop-view-cascade`; internal dependents alone do NOT block |

New `AllowOptions.dropViewCascade` + CLI token `drop-view-cascade` (wired through
`cli/src/lib/args.ts` `ALLOW_TOKENS`, `cli/src/lib/allow.ts` `ALLOW_TOKEN_MAP`, and both
help texts). Note `--allow drop-view` alone **never** cascades — the 0.15.21 gate is
strictly extended, never weakened, and plain non-cascading `DROP VIEW` remains the
emitted form whenever dependents are absent, so PG itself backstops a stale dependents
snapshot (TOCTOU): if a dependent appeared between introspect and apply, the plain drop
fails rather than silently cascading.

**Blocked message copy** (rendered via the existing blocked-entry path in
`cli/commands/migrate.ts` / `verify.ts`):

```
BLOCKED  drop-view v_program_summary
  3 dependent objects would be destroyed by this drop:
    - reporting.v_weekly_rollup            (view — NOT managed by MetaObjects)
    - reporting.mv_dashboard_cache         (materialized view — NOT managed by MetaObjects)
    - public.v_program_summary_active      (view — managed, not part of this migration)
  Dropping with CASCADE destroys all of them, and this tool cannot restore
  objects it does not manage.
  To proceed anyway: meta migrate --allow drop-view,drop-view-cascade
  Safer: migrate the dependents off this view first, then re-run.
```

**Emitted warning banner** when cascade is allowed (in the up SQL, immediately above
the statement, so it survives into the committed migration file and any review diff):

```sql
-- ============================================================================
-- WARNING: CASCADE DROP. The following dependent objects are DESTROYED by this
-- statement and are NOT restored by the down migration:
--   reporting.v_weekly_rollup (view), reporting.mv_dashboard_cache (matview)
-- ============================================================================
DROP VIEW "v_program_summary" CASCADE;
```

### 7.3 Deliberately deferred: auto save/restore of external dependents

The community pattern (snapshot dependent DDL via `pg_get_viewdef` + comments + grants
into a helper table, drop in depth order, restore in reverse — Pretius/mateuszwenus)
would let a migration transparently rebuild *unmanaged* dependents around our change.
Deferred because: restoring other owners' objects from deparsed SQL silently re-orders
*their* risk (grants/ownership/comments replay is fiddly to get exactly right), it
turns our migration into a writer of objects we do not manage — against the
schema-scoping doctrine in `diff/index.ts` (`scopeSchemas`: "a table living in a schema
the model never declares belongs to another owner") — and the blocked-flag UX covers
the safety requirement. Revisit if adopters hit the block frequently
(the dependents list in the block message tells us exactly how often).

### 7.4 Ordering

`STAGE_ORDER` already drops all views first (stage 0) and creates them last (stage
7/99), which is sufficient while managed views cannot depend on each other —
projections join *tables* only (`ExpectedView.dependsOn` is tables; `extractViewSpec`
resolves entity join trees to physical tables, and a projection cannot today take
another projection as its base). Add a defensive assertion in the diff: if an expected
view's dependents-closure ever contains another *expected* view, fail with a clear
"stacked managed views need topological create ordering — unsupported" error rather
than emitting creates in map order. If stacked projections ever ship, creates get a
topo sort within stage 7 (dbt/Redgate pattern, and alembic_utils issue #9 is the
cautionary tale).

---

## 8. Implementation plan

Ordered; each step lands with its tests. TDD throughout.

1. **`migrate-ts/src/view-fingerprint.ts` (new).** `normalizeForFingerprint`,
   `viewFingerprint`, `renderFingerprintComment`, `parseFingerprintComment`, marker
   regex, `FINGERPRINT_FORMAT_VERSION = 1`. Unit tests incl. golden hash vectors and
   marker round-trip.
2. **`migrate-ts/src/types.ts`.** `ViewDescriptor` gains `fingerprint?: string`,
   `columns?: ViewColumnDescriptor[]` (`{name, sqlType}`), `dependents?:
   DependentRelation[]`; new `DependentRelation`. `Change`: `drop-view` and
   `replace-view` gain `restore?: ViewDescriptor`; `drop-view` and the replace pair
   carry `dependents?: DependentRelation[]` (external-only, populated by diff);
   `replace-view` gains `unmanagedActual?: boolean` (drives adopt messaging).
   `AllowOptions` gains `dropViewCascade?: boolean`, `adoptView?: boolean`. Doc-comment
   the `sql` field's new role (restore payload on PG, comparator input on SQLite only).
3. **Snapshot format v3.** `snapshot/serialize.ts`: bump `SNAPSHOT_FORMAT_VERSION` to
   3; canonicalize the new view fields; `parseSnapshot` upgrade branch (v<3 → fields
   absent). Extend `test/check/serialize-upgrade.test.ts` and `types-shape.test.ts`.
4. **`codegen-ts/src/projection/build-projection-views.ts`.** `ExpectedView` gains
   `columns: ExpectedViewColumn[]` (`{ name, kind, sourceTable, sourceColumn, agg? }`),
   built from `spec.selectSpec.columns` (order preserved). No hashing here (§4.1).
5. **`migrate-ts/src/expected-schema.ts`.** When threading views in: compute
   `fingerprint` from `sql`; resolve each `ExpectedViewColumn` to a `SqlType` against
   the expected tables + the §5.2 aggregate rule table (new small module
   `view-column-types.ts`); unresolvable → omit `columns` (fail-safe to drop+create).
6. **`migrate-ts/src/introspect/postgres.ts`.** `readPgViews`: add `obj_description`
   → parse marker → `fingerprint`; keep `pg_get_viewdef` → `sql`; per view, reuse
   `readColumns` for `columns`. New `readPgViewDependents` (§7.1 query) → attach
   `dependents`. All under the existing pg-mem try/catch discipline.
7. **`migrate-ts/src/diff/index.ts` + `diff/status.ts`.** `diffViews` dialect split:
   PG = fingerprint table (§4.3) + replace-legality (§5.2) choosing `replace-view` vs
   drop+create pair; SQLite = existing body compare (Phase 2 adds marker-strip +
   grandfathering). Populate `restore`, `dependents` (transitive, external-only),
   `unmanagedActual`. Pass 2c gains the same dependents threading. `applyStatus`:
   adopt gate + cascade gate per §7.2 (keep the (schema,name)-keyed recreate exemption
   from 0.15.21 intact).
8. **`migrate-ts/src/emit/postgres.ts`.** `renderCreateView`: append the
   `COMMENT ON VIEW` stamp (fingerprint from the descriptor; `create-view`/
   `replace-view` both). `drop-view` with allowed cascade → `CASCADE` + warning banner.
   Down arms for `drop-view`/`replace-view`: restore from `restore` (§4.5), keeping the
   old WARNING comment when `restore` is absent.
9. **`migrate-ts/src/emit/sqlite.ts` (Phase 2).** Marker comment in the body; down
   restore from verbatim `restore.sql`.
10. **`cli`**: `lib/args.ts` `ALLOW_TOKENS` += `drop-view-cascade`, `adopt-view`;
    `lib/allow.ts` `ALLOW_TOKEN_MAP` += both; help text in `index.ts` +
    `commands/migrate.ts`; blocked-message copy (§7.2, §4.4) incl. the
    all-views-unstamped upgrade hint; `verify.ts` glyph table unchanged
    (`replace-view` already renders) but the describe line for an unmanaged replace
    should say `(unmanaged — no fingerprint)`.
11. **Docs**: `docs/features/` projection/migrate pages + the agent-context projection
    skill get the append-fields authoring guidance (§5.4), the adopt-view upgrade note,
    and the cascade flag. `view-sql-compare.ts` and `readPgViews` comments rewritten
    (§1.1's false claim must not survive in-source).

### 8.1 Tests — changed and new

**Existing tests that change (and the ones encoding the bug — never assume a golden is correct):**

- `test/unit/diff.test.ts` "diff — view-body drift": **encodes the false premise**
  (§1.3.1) — hand-matched bodies on both sides never occur on PG. Rewrite as: PG cases
  keyed on fingerprints (equal / differ / absent → adopt) and SQLite cases keeping body
  compare. The "identical body → no change" case survives only under
  `dialect: "sqlite"`.
- `test/unit/emit-views.test.ts`: PG assertions gain the `COMMENT ON VIEW` stamp —
  today's golden pins *stampless* output, i.e. the pre-fix world. D1/SQLite arms
  unchanged until Phase 2.
- `test/unit/diff-status-drop-view.test.ts`: extended for cascade/adopt gating; the
  0.15.21 (schema,name) recreate-exemption cases must keep passing unchanged.
- `test/unit/diff-view-recreate.test.ts` (Pass 2c): gains dependents threading cases.
- `test/integration/pg-adversarial-fixes.test.ts` (`user_owned_probe_view`): behavior
  preserved (drop proposed + gated); assertion text may gain the "unmanaged" detail.
- `test/drift/*`, `test/snapshot/*`, `test/check/serialize-upgrade.test.ts`: new fields
  / format v3.
- `cli/test/__snapshots__/cli.test.ts.snap`: help text (new allow tokens) — snapshot
  update is *expected*; review it, don't rubber-stamp it.
- Audit `test/down/` goldens: any golden asserting the
  `-- WARNING: down migration cannot restore the original view definition` line is
  pinning the pre-`restore` behavior and flips to the restore statement.

**New tests:**

- Unit: fingerprint vectors; marker parse (trailing-line, unknown-version, garbage);
  replace-legality matrix (§5.3 rows); aggregate result-type table; dependents closure
  + internal/external classification (incl. matview, self-rule exclusion).
- **Integration (real PG, `MIGRATE_TS_PG_URL`-gated) — the acceptance test for the
  bug itself, extending `postgres-roundtrip.test.ts`:**
  1. projection view: emit → apply → introspect → **re-diff MUST be EMPTY** → re-run
     again (the pipeline-twice discipline from 0.15.21);
  2. append a field → plan is `replace-view` (no drop) → apply → re-diff EMPTY → assert
     via catalog that a pre-created dependent view still exists (proves
     non-destructive);
  3. insert a field mid-declaration → plan is drop+create; with an external dependent →
     blocked; with `drop-view-cascade` → applies, dependent gone, banner present in up
     SQL;
  4. hand-written same-named view (no marker) → blocked adopt; with `adopt-view` →
     applies, stamped, re-diff EMPTY;
  5. pre-fingerprint upgrade simulation: create the view *without* a comment (as
     0.15.21 did), run the new migrate → blocked adopt → `--allow adopt-view` → EMPTY;
  6. down migration restores the previous view from the deparsed body (create → replace
     → apply down → introspect → old columns back).
- Integration (SQLite, Phase 2): marker-strip equality; grandfathering
  (no-marker + equal body → allowed stamp); hand-written divergent view → blocked adopt.
- `verify --db`: a hand-written view over a projection fails the drift gate
  (doctrine closure).

### 8.2 Rollout / compat

- **No metadata changes, no new vocabulary** — ADR-0023 untouched (nothing here is a
  metamodel attr; the fingerprint is emit-layer state, like the ledger).
- Wire-visible surface: two new `--allow` tokens; `COMMENT ON VIEW` statements in
  emitted migrations; snapshot format v3 (older snapshots parse forward).
- One-time operator action per PG environment: `--allow adopt-view` (§4.4). CHANGELOG
  must carry this prominently, mirroring how 0.15.21 documented the drop-view gate.
- Ships as a normal patch on the 0.15.x line (npm-only; other registries unaffected).

---

## 9. Open questions / risks

1. **Stamped-but-tampered views** (§4.4): fingerprint trusts the comment. A future
   `verify --db --deep-views` could adopt the alembic_utils simulation: create the
   expected body as a temp view in a scratch schema inside a rolled-back transaction,
   compare `pg_get_viewdef` of both — deparser-exact tamper detection, at the cost of
   requiring write (DDL) permission for a verify. Out of v1.
2. **View rename.** `@table` change on a projection's `source.rdb` is drop+create
   today (and in this design). `ALTER VIEW … RENAME TO` + a rename heuristic (like
   `detectTableRenames`) would preserve dependents across renames. Deferred; the
   fingerprint actually makes rename *detection* trivial (same hash, different name) —
   note for the follow-up.
3. **Grants on drop+create.** OR REPLACE preserves ACLs; drop+create loses any
   hand-applied `GRANT` on our view and we do not snapshot grants. The cascade/drop
   warning copy should mention it. Snapshotting `pg_class.relacl` into `restore` is a
   possible later refinement.
4. **`dependsOn` vs real dependencies.** Expected-side `dependsOn` lists source
   *tables* (for Pass 2c). The introspected dependents map is the authoritative
   dependents source; do not conflate them. If projections ever stack (§7.4), both
   need the topo-sort work.
5. **pg-mem blindness.** All new catalog reads degrade to `undefined` on pg-mem, so
   unit tests through pg-mem exercise none of this — the real-PG integration suite is
   the only true gate, as 0.15.21 established. Accepting this explicitly: no new
   pg-mem shims.
6. **Comment-channel collisions.** Another tool (or a DBA) overwriting our view
   comment erases the marker → the view degrades to "unmanaged" → blocked adopt. Safe
   direction (fail-closed), but potentially surprising; the adopt message should
   mention the marker may have been overwritten.
7. **Fingerprint churn from emitter evolution** (§4.1): any semantic change to
   `emitViewDdl` output re-stamps every view via one `CREATE OR REPLACE` wave.
   Non-destructive, but release notes for such changes should say so.
8. **Multiple marker versions in one DB** (partial upgrades): handled by the
   unknown-version rule (§4.2) — always self-heals toward the running toolchain's
   version; no coordination needed.

---

## 10. Cross-references

- CHANGELOG 0.15.21 — "`drop-view` was auto-allowed" fix this design extends; the
  "goldens found encoding the bugs they pinned" precedent.
- ADR-0015 — schema migrations are TS-owned (why this is TS-only).
- `diff/status.ts` — 0.15.21 (schema,name) recreate-pair exemption, preserved.
- `docs/features/downstream-metadata-decisions.md` — "a hand-written view over a
  projection is drift"; §4.4 makes the drift gate actually able to see it.
- Prior art sources: see the table in §3 (Atlas, alembic_utils, Flyway, Liquibase,
  dbt, pgroll, Skeema, Redgate, the Postgres dependency-rebuild pattern, and the
  [PostgreSQL CREATE VIEW documentation](https://www.postgresql.org/docs/current/sql-createview.html)).
