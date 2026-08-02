# Migrations and drift detection

MetaObjects treats metadata as the source of truth and generated code + database
schema as derived. Migration is the build-time pipeline that emits SQL DDL from
metadata diffs; **drift detection** is the cross-cutting discipline that catches
divergence between metadata, code, DB, and prompts.

There are **7 drift sources**, and the toolchain has a guard for each.

## The 7 drift sources

| Drift source | Caught by | When |
|---|---|---|
| **Code-vs-DB** | Codegen — the generated SQL DDL is emitted from the same metadata as the entity / table code. | Build time |
| **Code-vs-API-doc** | Cross-port codegen from the same metadata. | Build time |
| **DB-vs-metadata** | `meta verify --db` (TS CLI) — introspects the live DB and fails if it has drifted from metadata. Includes modeled projection **view bodies** (a changed `CREATE VIEW` is `replace-view` drift); a hand-authored *unmodeled* view is unmanaged and never flagged. A schema concern owned by the Node toolchain regardless of server language; on the JVM ports the runtime auto-create/validator path was removed (ADR-0015) and the `meta:verify` Maven goal is not available. Cloudflare D1 has no client wire protocol, so it can't go through `--db`'s Kysely-driver introspection — use `meta verify --dialect d1 [--d1 <binding>] [--remote]` instead (the same wrangler-shelled-out path `meta migrate --dialect d1` uses); `--remote` is required to check the *deployed* database, not the local `wrangler dev` shadow copy. Pointing `--db file:` at wrangler's local D1 state directory (`.wrangler/state/**/d1/**`) still runs, but only verifies that local copy — `verify` warns when it detects this. | CI on every PR |
| **Migration-vs-metadata** | The Node `meta migrate` emits migrations FROM metadata diffs — they cannot drift from metadata by construction. Schema migrations for **every** port are owned by this Node toolchain (`@metaobjectsdev/cli migrate`, ADR-0015); the C# and Python migrate surfaces were removed. | Build time |
| **Generated-edited** | `@generated` headers in emitted code + three-way merge that preserves hand-edits inside non-generated regions. | Code review |
| **Prompt-vs-payload** | FR-004 `Renderer.verify` parses `{{...}}` references in templates and checks each one exists on the payload VO. | Build time + runtime |
| **Generated-vs-runtime** | Kotlin / Java `MetadataStartupValidator` (from Spring `ApplicationReadyEvent`) re-loads metadata at startup and asserts the generated table objects match. | App startup |

## Authoring (no metadata change required)

Migration is invisible to the metadata author — the same `Author` declaration
drives a `CREATE TABLE` on the first run and an `ALTER TABLE` on later runs.

```json
{
  "object.entity": {
    "name": "Author",
    "children": [
      { "source.rdb": { "@table": "authors" } },
      { "field.long":   { "name": "id" } },
      { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
      { "field.string": { "name": "bio",  "@maxLength": 2000 } },
      { "identity.primary": { "@fields": "id", "@generation": "increment" } }
    ]
  }
}
```

Add a new `email` field tomorrow — the next `meta migrate` emits the
`ALTER TABLE` for the new column.

## Migration commands per port

### TypeScript

```bash
meta migrate                  # diff metadata vs DB → emit migration SQL
meta migrate --dry-run        # preview without writing
meta migrate --dialect d1     # Cloudflare D1 dialect (TS-only)
```

Dialects: `postgres` (default), `sqlite`, `d1`. Output lands under the path
configured in `metaobjects.config.ts` (typically `./migrations/<timestamp>__<slug>.sql`).

**`meta migrate apply-pending`** replays the committed migration files against `--db`
in order, ledger-tracked (`_metaobjects_migrations`) and transactional — with **no
diff and no metadata load**. It is the way to provision a fresh or CI database from the
committed migrations. `meta migrate --apply`, by contrast, is diff-first — it authors a
new migration from the metadata-vs-DB diff before applying it. `apply-pending` just runs
the pending already-committed files, making it idempotent; `--dry-run` lists what would
run. postgres/sqlite only — on D1 use `wrangler d1 migrations apply`.

#### D1: rebuilding a foreign-key-referenced table

Cloudflare D1 applies each migration inside its own implicit transaction, and SQLite
ignores `PRAGMA foreign_keys` while a transaction is open. The SQLite table-rebuild
recipe (used for a `CHECK`, column type/nullability/default, foreign-key, or
`field.enum` values change) relies on `PRAGMA foreign_keys = OFF` taking effect before
it drops and recreates the table — which does not happen on remote D1.

`meta migrate --dialect d1` handles this by **auto-generating a cascade**
([#241](https://github.com/metaobjectsdev/metaobjects/issues/241), closing
[#226](https://github.com/metaobjectsdev/metaobjects/issues/226)'s residual
under-refuse gap below) instead of refusing outright. When a change would rebuild a
table that another table's foreign key references, the emitter rebuilds that table
together with every table that transitively references it, in one pass: the affected
tables are dropped referrers-first and recreated parents-first, under `PRAGMA
defer_foreign_keys = ON` so every foreign-key check defers to the end of D1's implicit
transaction instead of firing mid-rebuild. The result applies cleanly against a
populated production database and re-converges — a follow-up `meta verify`/`meta
migrate` sees no drift. The cascade is built over the **union of the actual (live) and
expected (target) schemas' foreign-key graphs**, so it also covers the case a
target-schema-only check would miss: a single migration that both rebuilds a
referenced table *and* drops the referencing foreign key in the same run. A
projection/view that reads a rebuilt table is dropped before the rebuild and recreated
after — for the CHECK/FK/enum-values rebuild class as well as column changes — so a
dependent view is never stranded mid-migration.

The one case still hand-written: a **multi-table foreign-key cycle** (table A
references B references … references A, two or more tables). A cycle has no
parents-first rebuild order, so `meta migrate --dialect d1` still **refuses at
generation time** — hand-write the migration (drop the foreign key on one side of the
cycle, rebuild the tables, then restore it) or break the cycle in your metadata. A
self-referencing table (a table whose own foreign key targets itself) is not a cycle
in this sense and is handled by the cascade like any other rebuild.

#### A moved primary key (adoption-time refusal)

The diff/emit has no `add-primary-key` / `drop-primary-key` change kind, so an **existing**
table whose live `PRIMARY KEY` differs from the metadata identity cannot be expressed as a
migration. When adopting such a database (`--from-db`), `meta migrate` now **refuses at
generation time** instead of emitting un-appliable SQL — detect-and-refuse, the same arc as
[#226](https://github.com/metaobjectsdev/metaobjects/issues/226)→[#241](https://github.com/metaobjectsdev/metaobjects/issues/241)
for the D1 foreign-key rebuilds above. It throws a `PrimaryKeyChangeError` (naming the table
and both PKs), the CLI catches it and exits 1
([#258](https://github.com/metaobjectsdev/metaobjects/issues/258)).

Previously the move degraded **silently** into an add-column + drop-column: the old PK
column and its constraint were dropped while the new column was never made primary key,
leaving the table with no primary key, so every foreign key referencing it failed at apply
(`there is no unique constraint matching given keys`). This surfaces only when **adopting**
an existing database whose PK disagrees with the metadata — a greenfield `create-table`
carries its primary key inline.

The check is engine-wide (`postgres` / `sqlite` / `d1` — the diff is shared) and runs
**after** rename detection, mapping live PK column names through any detected
`rename-column` change, so a primary-key column that was merely **renamed** (the engine
preserves the PK through `RENAME COLUMN`) is not mistaken for a move. The read-only
`meta verify` / drift path does not set the refusal flag, so `verify` keeps **reporting**
primary-key drift rather than throwing. Auto-migrating the move (adding the
`add-primary-key` / `drop-primary-key` change kinds) is a documented future follow-up.

### Java

Schema migrations for Java projects are owned by the **TypeScript toolchain**
(`@metaobjectsdev/cli migrate`). The Java Maven plugin's `meta:migrate` goal was
removed, and per ADR-0015 the OMDB runtime auto-create path was removed too —
OMDB is pure data-access (CRUD/query/codec/transactions). Provision the schema by
applying the TS-produced DDL/migrations to the database the Java service connects to.

Use the TS CLI against the same database the Java service connects to:

```bash
meta migrate --db postgresql://... --slug initial   # emit migration SQL
meta migrate --db postgresql://... --apply          # apply pending migrations
```

### Kotlin

Kotlin schema migrations follow the same story as Java: the Java Maven plugin's
`meta:migrate` mojo was removed and there is no Kotlin-specific migrate command.
Schema migrations are owned by the TS toolchain:

```bash
meta migrate --db postgresql://... --slug initial
meta migrate --db postgresql://... --apply
```

### C#

Schema migrations for C# projects are owned by the **TypeScript toolchain**
(`@metaobjectsdev/cli migrate`). Per ADR-0015 the C# migrate engine and the
`--from-db` introspection surface were removed — the C# CLI (`dotnet meta`) is
`gen` / `verify` only. Use the TS CLI against the same database the C# service
connects to:

```bash
meta migrate --db postgresql://... --slug initial   # emit migration SQL
meta migrate --db postgresql://... --apply          # apply pending migrations
```

### Python

Schema migrations for Python projects are owned by the **TypeScript toolchain**
(`@metaobjectsdev/cli migrate`). Per ADR-0015 the Python `migrate` module was
removed — the `metaobjects` console script is `gen` / `verify` only (the runtime is
pure data-access via ObjectManager). Use the TS CLI against the same database the
Python service connects to:

```bash
meta migrate --db postgresql://... --slug initial   # emit migration SQL
meta migrate --db postgresql://... --apply          # apply pending migrations
```

## Drift verify commands per port

| Port | Command | What it does |
|---|---|---|
| TypeScript | `meta verify --db` | Introspects the live DB; reports DB-vs-metadata drift. |
| Java | `mvn metaobjects:verify -Dmeta.verify.mode=codegen\|templates` (`meta:verify` Maven goal) + `Renderer.verify` (build-time) | The codegen/template-drift `meta:verify` Maven goal is alive and is how Java gates drift in CI (`codegen` mode regens + fails on drift vs committed output; `templates` mode drift-checks `{{...}}` references against the payload VO via `Renderer.verify`). Only the *live-DB-schema* `meta:verify` goal was removed — that's TS-owned now (`meta verify --db`) — along with the runtime auto-create validator (ADR-0015). |
| Kotlin | `mvn metaobjects:verify -Dmeta.verify.mode=codegen\|templates` (`meta:verify` Maven goal — same goal covers both Java + Kotlin) + `MetadataStartupValidator` (startup) | Same as Java — the `meta:verify` Maven goal remains, plus template-drift and startup validation. |
| C# | `meta verify ./metadata --templates ./prompts` | Drift-checks templates against their payload VOs (FR-004 prompt-drift). |
| Python | `python -m metaobjects.render.verify` | Same as C# verify — template-vs-payload drift. |

## Generated-vs-runtime: Kotlin startup validator

`KotlinSpringConfigGenerator` emits a `@Configuration` class that re-loads
metadata at Spring `ApplicationReadyEvent` and asserts that the generated `Table`
objects still match the metadata. If a developer hand-edited a generated table
and the regen didn't catch it (or a CI race shipped a stale build), the app
fails-fast at startup instead of silently serving wrong data.

```kotlin
// GENERATED — MetadataExposedConfig.kt
@Configuration
class MetadataExposedConfig(private val dataSource: DataSource) {
    init { Database.connect(dataSource) }

    @EventListener(ApplicationReadyEvent::class)
    fun validateMetadata() {
        val loader = loadResources("app", listOf("meta.entities.json"))
        MetadataStartupValidator.validate(loader)
    }
}
```

## Migrating views (projections)

A projection's `CREATE VIEW` is generated from its `origin.*` children, so `meta migrate`
owns the view. Three things are worth knowing.

**Append projection fields; don't insert them.** Postgres can update a view in place
(`CREATE OR REPLACE VIEW`) only when the existing output columns are unchanged and any
new ones are added at the **end**. A view's columns come out in projection *declaration*
order, so:

- adding a field **at the end** of a projection → non-destructive replace. Dependent
  views, grants, and the view's identity all survive.
- inserting a field **in the middle**, reordering, renaming, or removing one → the view
  must be **dropped and recreated**, which is destructive to anything that depends on it
  and is therefore gated (`--allow drop-view`).

Body-only changes — a different join path, an `origin.aggregate @filter`, a changed
aggregate that keeps the same result type — are always non-destructive.

**A cascading drop is blocked, loudly.** If dropping a view would destroy dependent
objects — another application's view, a materialized view — `meta migrate` blocks and
names every one of them. Proceeding requires `--allow drop-view,drop-view-cascade`, and
the emitted migration carries a `WARNING: CASCADE DROP` banner listing what it destroys.
MetaObjects does not manage those objects and cannot restore them. `--allow drop-view`
**alone never cascades.**

**One-time upgrade step (`--allow adopt-view`).** Managed views carry a MetaObjects
fingerprint in their `COMMENT ON VIEW`; that fingerprint — not the view's SQL text — is
how migrate knows whether a view is current. (It cannot use the text: Postgres does not
store view SQL, it stores a parse tree and regenerates the SQL in its own style, so what
you wrote never comes back.) A view with **no** fingerprint is either hand-written or was
created before fingerprinting existed, and those are indistinguishable — so migrate fails
closed rather than overwrite somebody's hand-written SQL:

```
meta migrate --allow adopt-view      # once per environment, after upgrading
```

That stamps the existing views. Afterwards they converge silently. This is also what
closes the loop on the doctrine in
[downstream-metadata-decisions.md](downstream-metadata-decisions.md): a hand-written view
sitting where a projection expects one is now **visible to `meta verify --db`** as drift,
instead of being silently invisible to it.

**Genuinely-irreducible views and externally-owned objects (`@sql` / `@unmanaged`, #208).**
Some read models cannot be expressed as `origin.*` (a recursive CTE, a window function, a
set operation). Rather than hand-write such a view *outside* the tool — where it degrades
to accidentally-unmanaged — carry its body in a `source.rdb` **`@sql`** attribute. The tool
registers, fingerprints, and drift-checks that verbatim body (never parsing it) exactly like
a synthesized view: it emits `CREATE VIEW … AS <your body>` with a fingerprint stamp, a
second migrate is a no-op, and a pre-existing hand-written view at that name is adopted via
the same `--allow adopt-view` step above. An `@sql` view may carry an `extends`-bound
`identity.primary` / fields (for row identity and read-model shape) without the tool
mis-synthesizing a body. For a DB object whose DDL is owned entirely elsewhere (Flyway, a
hand-migration) — a view **or a table** — mark its source **`@unmanaged: true`**: `meta
migrate` never creates, drops, or drift-checks it, and `meta verify --db` reports it as
*external (declared)*. The two are mutually exclusive. See
[ADR-0043](../../spec/decisions/ADR-0043-ddl-ownership-escape-valves.md).

## Verified by

The following conformance fixtures gate this feature's behavior across ports:

**Schema migration (`fixtures/persistence-conformance/migrations/`)**

- [`bootstrap-canonical-from-empty.yaml`](../../fixtures/persistence-conformance/migrations/bootstrap-canonical-from-empty.yaml) — full-CREATE bootstrap from an empty database
- [`add-nullable-column.yaml`](../../fixtures/persistence-conformance/migrations/add-nullable-column.yaml) — incremental `ALTER TABLE … ADD COLUMN` for a new nullable field
- [`drop-table-blocked-without-allow.yaml`](../../fixtures/persistence-conformance/migrations/drop-table-blocked-without-allow.yaml) — destructive operations require an explicit allow-flag
- [`noop-converged-canonical.yaml`](../../fixtures/persistence-conformance/migrations/noop-converged-canonical.yaml) — **the idempotence gate**: apply the whole canonical schema, then diff the same metadata against the database it just produced. A converged schema must emit **zero** SQL. This is what catches any asymmetry between what `emit` writes, what `introspect` reads back, and what the expected schema models — the class of bug that makes `meta migrate` re-propose (and on SQLite, destructively rebuild) unchanged tables forever.

**Template drift (`fixtures/verify-conformance/`)** — the `Renderer.verify` engine
asserts that every variable, section, partial, and required-tag in a template
resolves against its declared payload. 31 fixtures, grouped:

- *Variables*: `verify-var-known-clean`, `verify-var-unknown`, `verify-var-implicit-iterator-clean`, `verify-var-unescaped-and-triple-unknown`
- *Dotted paths*: `verify-dotted-path-clean`, `verify-dotted-path-head-nonfield`, `verify-dotted-path-tail-nonfield`
- *Sections*: `verify-section-over-nonfield`, `verify-section-pushes-element-clean`, `verify-section-element-nonfield`, `verify-nested-sections-clean`, `verify-nested-section-nonfield`, `verify-parent-context-in-section-clean`, `verify-scalar-section-conditional-clean`, `verify-scalar-section-conditional-nonfield`
- *Inverted sections*: `verify-inverted-section-clean`, `verify-inverted-section-over-nonfield`
- *Partials*: `verify-partial-no-provider`, `verify-partial-unresolved`, `verify-partial-resolved-clean`, `verify-partial-resolved-drift`, `verify-partial-in-section-context`
- *Required slots / tags*: `verify-required-slot-used-clean`, `verify-required-slot-unused`, `verify-required-slot-via-section`, `verify-required-tags-present`, `verify-required-tag-in-partial`, `verify-required-tag-self-closing`, `verify-required-tag-missing-open`, `verify-required-tag-missing-close`, `verify-required-tag-prefix-no-overmatch`

Browse the full set under [`fixtures/verify-conformance/`](../../fixtures/verify-conformance/).

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

## See also

- [entities.md](entities.md) — what's being migrated
- [source-kinds.md](source-kinds.md) — `meta migrate` emits view + table DDL
- [templates-and-payloads.md](templates-and-payloads.md) — `Renderer.verify` is the FR-004 drift gate
- [loaders.md](loaders.md) — the runtime validator re-uses the same loader
- [`docs/RELEASING.md`](../RELEASING.md) — `scripts/integration-test.sh` runs persistence-conformance per port pre-release
