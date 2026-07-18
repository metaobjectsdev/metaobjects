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
| **DB-vs-metadata** | `meta verify --db` (TS CLI) — introspects the live DB and fails if it has drifted from metadata. Includes modeled projection **view bodies** (a changed `CREATE VIEW` is `replace-view` drift); a hand-authored *unmodeled* view is unmanaged and never flagged. A schema concern owned by the Node toolchain regardless of server language; on the JVM ports the runtime auto-create/validator path was removed (ADR-0015) and the `meta:verify` Maven goal is not available. | CI on every PR |
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
| Java | `Renderer.verify` (build-time) | Template-drift: verifies `{{...}}` references resolve against the payload VO. Live-DB-schema drift is TS-owned (`meta verify --db`); both the `meta:verify` Maven goal and the runtime auto-create validator were removed (ADR-0015). |
| Kotlin | `Renderer.verify` (build-time) + `MetadataStartupValidator` (startup) | Same as Java — template-drift and startup validation. No `meta:verify` Maven goal. |
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
