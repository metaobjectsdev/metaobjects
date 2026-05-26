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
| **DB-vs-metadata** | `meta:verify` Maven goal / `meta verify` CLI — introspects the live DB and fails the build if it has drifted from metadata. | CI on every PR |
| **Migration-vs-metadata** | `meta migrate` (TS / C#) / `meta:migrate --flyway` (Java / Kotlin) emits migrations FROM metadata diffs — they cannot drift from metadata by construction. | Build time |
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

```bash
mvn meta:migrate                      # writes a numbered SQL file
mvn meta:migrate -Dflyway=true        # writes V<N>__<slug>.sql under src/main/resources/db/migration/
```

Flyway mode auto-versions by scanning existing migrations.

### Kotlin

Uses the Java Maven plugin's `meta:migrate` mojo (Kotlin codegen tier rides on the
same plugin). Flyway prefix + directory are configurable via the plugin's
`<flywayDir>` / `<flywayPrefix>` parameters.

```bash
mvn meta:migrate -Dflyway=true
```

### C#

```bash
# Full CREATE (initial)
meta migrate ./metadata --out ./migrations/001_init.sql

# Incremental — diff metadata against a live DB
meta migrate ./metadata --out ./migrations/002.sql --from-db "Host=...;Database=..." --down ./migrations/002_down.sql
```

The incremental path uses `NpgsqlIntrospector` to read the current Postgres schema
and emit an `ALTER`-shaped migration.

### Python

```bash
python -m metaobjects.migrate --dry-run
```

(Migration codegen is in progress; see the [Python quickstart](../ports/python.md)
for current status.)

## Drift verify commands per port

| Port | Command | What it does |
|---|---|---|
| TypeScript | `meta verify` | Re-runs codegen as a no-op; reports DB-vs-metadata drift. |
| Java | `mvn meta:verify` | Introspects the live DB; fails the build if schema differs from metadata. |
| Kotlin | `mvn meta:verify` | Same as Java (shared Maven plugin). |
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

## Verified by

The following conformance fixtures gate this feature's behavior across ports:

**Schema migration (`fixtures/persistence-conformance/migrations/`)**

- [`bootstrap-canonical-from-empty.yaml`](../../fixtures/persistence-conformance/migrations/bootstrap-canonical-from-empty.yaml) — full-CREATE bootstrap from an empty database
- [`add-nullable-column.yaml`](../../fixtures/persistence-conformance/migrations/add-nullable-column.yaml) — incremental `ALTER TABLE … ADD COLUMN` for a new nullable field
- [`drop-table-blocked-without-allow.yaml`](../../fixtures/persistence-conformance/migrations/drop-table-blocked-without-allow.yaml) — destructive operations require an explicit allow-flag

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
