# C# tool + metamodel extensions for Postgres + EF Core adopters — Design

**Status:** Approved (high-level), pending implementation plan.
**Author:** brainstorming session 2026-05-20.
**Supersedes:** `docs/superpowers/specs/2026-05-20-csharp-rdb-persistence-design.md` (paused; this doc replaces it).
**Next step:** `writing-plans` skill → `docs/superpowers/plans/YYYY-MM-DD-csharp-tool-and-metamodel-extensions.md`.

---

## Why this doc exists

The C# loader + conformance corpus shipped at parity with the TS v0.3 metamodel (final commit `463baef`). The next natural step is delivering enough C# tooling — and enough new metamodel vocabulary — for a real-world .NET 8 / Postgres / EF Core team to adopt MetaObjects as its schema authority and retire EF Core Migrations entirely.

This design defines the public capabilities. It is informed by a concrete adopter survey (a ~500-entity .NET 8 / Postgres / EF Core 8 CRM codebase, including its EF Migrations, Fluent API configurations, view DDL, stored functions, and cross-repo type duplication into a downstream TypeScript portal). The adopter-side rollout — bootstrap of a specific schema, cutover ceremony, branch coordination — lives in that team's private repository and is out of scope here.

## What this design covers

1. **A C# CLI tool** (`MetaObjects.Tool`) with introspection, diff, emit, bootstrap, and codegen.
2. **Metamodel extensions** that any language port must honor — Tier 2 (small) and Tier 3 (moderate) additions.
3. **C#-specific codegen escape hatches** — opaque passthrough attributes the loader carries but only the C# codegen consumes.
4. **TS-side completions** needed to make cross-language projection authoring viable end-to-end.
5. **Conformance corpus extensions** so every language port automatically verifies the new vocabulary.

What this design **does not** cover: any consumer-specific data (entity names, migration counts, business domain). Consumer-side adoption details live in adopters' own design docs.

## The shape of the C# tool

`MetaObjects.Tool` — distributed as a `dotnet tool install -g` global CLI. Command surface mirrors the TS `meta` CLI verb namespace so cross-language work is uniform:

```
meta bootstrap --from-db <connstring> --from-ef <assembly.dll> --out metaobjects/
meta migrate emit --against <connstring> --out migrations/<timestamp>_<name>.sql
meta migrate verify --against <connstring>
meta migrate diff --against <connstring>
meta gen --target csharp-ef --out <path>
meta gen --target csharp-fluent --out <path>
```

### `meta bootstrap`

One-shot reverse-engineering. Reads a live Postgres database and (optionally) loads a referenced `DbContext` assembly via reflection to capture metadata that schema introspection alone cannot see: TPH discriminator + subtype values, owned-type column groupings, value-converter signals, query filters.

**Sources of truth, in priority order:**

1. **Postgres introspection** (extends the existing `migrate-ts` introspect for the Tier 2+3 vocabulary below): all tables across all schemas, columns with types/nullability/defaults, indexes including partial (`WHERE`) and unique, foreign keys with `ON DELETE`/`ON UPDATE`, views (name + definition body), functions (name + signature + body), JSONB columns flagged from `information_schema`, computed columns from `pg_attribute.attgenerated`.
2. **EF model reflection** (new C# tooling): loads the consumer's `DbContext` and reads `IModel` to capture TPH discriminators, owned-type structure, value converters, query filters.
3. **Cross-reference pass**: combines (1) and (2). DB introspection wins on conflict; conflicts are emitted as warnings.

**Output:** one `meta.<domain>.json` per logical domain (grouping inferred from the consumer's entity folder structure or DbContext namespace layout).

**Fallback path** if EF model reflection turns out to be fiddly for a given consumer (assembly load failures, design-time DI complexity): parse the `ModelSnapshot.cs` file directly. Validate which approach is robust in the first 2 weeks of implementation.

### `meta migrate emit` / `verify` / `diff`

Same semantics as the TS `migrate-ts` pipeline, identical change-kind vocabulary, identical SQL output for the same metadata + dialect (Postgres). The cross-language conformance corpus enforces this byte-for-byte.

Output is forward-only Postgres SQL scripts, timestamped, suitable for DbUp / Grate / a hand-written runner / an adapted EF `PendingMigrationsUtility`. Tracking table: `__metaobjects_migrations` (managed by the tool, schema documented).

### `meta gen --target csharp-ef` and `csharp-fluent`

Two C# codegen targets:

- **`csharp-ef`** — emits `*.Generated.cs` partial entity classes with properties + the EF data annotations needed for queries (column names, max length, required, indexes-as-attributes when possible).
- **`csharp-fluent`** — emits `*Configuration.Generated.cs` `IEntityTypeConfiguration<T>` classes for Fluent API configuration that doesn't fit into attribute form (TPH `HasDiscriminator`, `OwnsOne`, `HasComputedColumnSql`, partial-index `HasFilter`, value converters when the metadata declares one).

Both targets emit `partial class` so hand-written partials can hold interface markers, custom logic, and any escape-hatch features the user wants to keep manual.

The two targets are independently configurable — a project might prefer attributes-only, Fluent-only, or both. Default: both.

## Metamodel extensions

These additions are Tier 1 cross-language metamodel changes — TS, Java (future), Python (future), and C# all need to recognize and round-trip them. Conformance fixtures live under `fixtures/conformance/` and are required before any language port consumes the new vocabulary.

### Tier 2 — small additions (~1 week each)

| Addition | Shape | Notes |
|---|---|---|
| **JSONB column subtype** | `field.subType = "jsonb"` | Postgres-native. Column maps to `jsonb`. C# codegen emits the property as `string` or a typed model + value converter (configurable via `@csJsonbType`). |
| **Schema namespacing** | A `package` segment maps to a DB schema (e.g., `acme::api` → `acme_api`). Default schema: `public`. | Necessary for projects with curated read-model schemas alongside the canonical OLTP schema. |
| **Partial indexes** | `index.@filter "IsOpen = true"` | Postgres `CREATE INDEX ... WHERE ...`. Common in production schemas. |
| **Computed columns** | `field.@computed "(\"ParentId\" IS NULL)"` | Postgres `GENERATED ... STORED`. Codegen emits `HasComputedColumnSql(...)` on the Fluent side. |

### Tier 3 — moderate additions (~2 weeks each)

| Addition | Shape | Notes |
|---|---|---|
| **TPH discriminator inheritance** | `object.@discriminator "Type"` on the base; `object.@discriminatorValue "Bridge"` on each child object that `extends` it | Maps to EF `HasDiscriminator`. Discriminator column type: int / string / enum. Conformance must cover: nullable subtypes, FK pointing at base vs. subtype, EF skip-navigation onto subtypes. |
| **Owned types** | A field of subtype `ownedComplex` references a separate `object` declared with `object.@owned true`; columns from the owned object flatten into the owner's table with optional column-name remap | Maps to EF `OwnsOne` / `OwnsMany`. Cross-language ports represent the same flattening; non-.NET languages may emit a nested struct or a flattened record. |
| **External-SQL function references** | `function[externalSql]` declaration: name, parameters (typed), return type, and a path to a `.sql` file holding the body | For Postgres functions whose body is too large or imperative to author in metadata. The tool tracks the file's checksum; when it changes, the next `migrate emit` produces a `CREATE OR REPLACE FUNCTION` statement. |
| **External-SQL view references** | `view[externalSql]` declaration: name, optional column list, and a path to a `.sql` file holding the SELECT body | Same pattern for views that aren't projections (legacy hand-written views, complex CTEs that resist projection authoring). |

### Out of metamodel — C#-specific codegen escape hatches

These attributes do not change the cross-language metamodel; they are passthrough attributes that non-C# loaders carry as opaque strings:

- **`object.@csImplements "IFooMarker, IBarMarker"`** → joined onto the generated `partial class` declaration after the base type.
- **`object.@csBase "SomeBaseClass"`** → replaces the default base type for the generated `partial class`.
- **`field.@csAttributes "ReportingField(\"ColumnName\"), JsonIgnore"`** → emitted verbatim onto the generated property.
- **Partial-class pattern** — generated code lives in `<Entity>.Generated.cs`; hand-written code lives in `<Entity>.cs` as `partial class`. Codegen never overwrites the hand-written file.

This is how a consumer codebase preserves the surface area its application depends on (custom attributes, marker interfaces, computed properties on entities) without forcing every shape into the metamodel.

## TS-side completions

Two TS deliverables make the cross-language story end-to-end:

1. **`migrate-ts` view-DDL emit (Postgres)** — the introspect side already captures view names; the emit side currently declares the view change-kinds without producing them. Phase 3 of the adopter rollout needs this. Estimate: ~1 week of incremental work in `typescript/packages/migrate-ts/`.
2. **`@metaobjects/codegen-ts` Drizzle `.existing()` generator** — a new codegen target that emits Drizzle schemas marked `.existing()` from projection metadata, alongside paired TypeScript frontend type aliases (camelCase conversion baked in). For TypeScript consumers of cross-repo metadata-defined views. Estimate: ~2 weeks.

Both extensions are general-purpose and benefit every TypeScript consumer that defines views via projection metadata, not only the specific adopter that motivated this design.

## Conformance corpus extensions

Required new fixtures under `fixtures/conformance/`:

- `field-subtype-jsonb-basic/`
- `package-to-schema-mapping/`
- `index-partial-filter/`
- `field-computed-column/`
- `tph-discriminator-int-base-only/`
- `tph-discriminator-string-base-only/`
- `tph-discriminator-with-subtypes/`
- `tph-discriminator-nullable-subtypes/`
- `owned-type-single/`
- `owned-type-with-column-rename/`
- `owned-type-nullable/`
- `function-externalsql-basic/`
- `view-externalsql-basic/`
- `view-externalsql-with-dependency-tracking/`

Each fixture pairs input metadata with the canonical serializer output. TS implementation establishes the canonical form; C# (and future Java, Python) implementations must match.

## Estimated effort

| Workstream | Weeks |
|---|---|
| Metamodel additions (Tier 2 + Tier 3) — TS reference impl + conformance fixtures | 4-5 |
| `meta bootstrap` (Postgres introspect extensions + EF model reflection) | 3-4 |
| C# `migrate emit` / `verify` / `diff` (Postgres) | 2-3 |
| C# `gen --target csharp-ef` + `csharp-fluent` | 3-4 |
| TS view-DDL emit completion + Drizzle `.existing()` codegen | 3 |
| Adopter integration support / first-real-project fixture iteration | 2-3 (buffer) |
| **Total elapsed (parallelism opportunistic)** | **12-16** |

## Out of scope

- **Runtime `ObjectManager` for C#.** The TS runtime is its own multi-month arc; replicating it in C# is not required for the schema-authority story. Deferred indefinitely.
- **Multi-tenant overlay vocabulary** (e.g., per-customer schema or data divergence). No validated need; flag as future work if a consumer requests it.
- **SqlServer / MySQL / Oracle dialects.** Postgres only for the first C# tool release. The TS pipeline already supports Postgres + SQLite; adding more dialects is its own roadmap.
- **EF Core upgrade compatibility matrix.** The tool targets EF Core 8+; older versions out of scope unless a consumer explicitly requires it.
- **Cross-repo metadata distribution mechanism** (npm package vs git submodule vs source-link). Adopter-decision; documented in adopters' own design docs.

## Risks

1. **EF model reflection at design time has historically been fiddly** — assembly loading, design-time DI, runtime-only configuration. Mitigation: the `ModelSnapshot.cs` parsing fallback. Validate which is robust in the first 2 weeks.
2. **Owned-type codegen has edge cases** the conformance fixtures might not catch on first pass (shadow FKs, nullable owned blocks, nested owned types). Mitigation: 2-3 week buffer in the estimate for first-real-project iteration.
3. **TPH inheritance is the gnarliest codegen pattern.** Subtype-pointing FKs, EF skip-navigation, discriminator-as-enum vs. discriminator-as-int. Mitigation: cover 5+ TPH conformance fixtures before C# codegen ships.
4. **`view[externalSql]` checksum tracking format must be stable across language ports.** A naive whitespace-sensitive checksum is fragile. Mitigation: define a canonical normalization (strip trailing whitespace, normalize line endings, optionally strip SQL comments) — and conformance-test it.
5. **`migrate emit` SQL output divergence between TS and C# implementations.** The cross-language conformance corpus must enforce byte-equality of emitted DDL for the same metadata + dialect. Mitigation: a `fixtures/migrations/` corpus parallel to the loader corpus, validating both implementations against the same canonical script.

## Cross-references

- **Superseded:** `docs/superpowers/specs/2026-05-20-csharp-rdb-persistence-design.md`
- **TS reference implementation:** `typescript/packages/migrate-ts/`
- **TS codegen architecture:** `typescript/packages/codegen-ts/`
- **C# loader (foundation):** `csharp/MetaObjects/`
- **C# loader plan:** `docs/superpowers/plans/2026-05-19-csharp-conformance-port.md`
- **Existing conformance corpus:** `fixtures/conformance/`

## Open decisions for the implementation plan

1. **EF model reflection vs. ModelSnapshot.cs parsing** as the primary path for capturing TPH/owned-type metadata. Validate first.
2. **Codegen output directory layout** — co-located `*.Generated.cs` next to hand-written partials, or a dedicated `Generated/` subtree? Recommend co-located for discoverability.
3. **`__metaobjects_migrations` table schema** — minimum columns, idempotency strategy, interop with DbUp / Grate / EF `PendingMigrationsUtility` shapes.
4. **Canonical SQL-body normalization for `view[externalSql]` / `function[externalSql]` checksums.**
5. **First adopter integration timing** — at what point in the workstream does external validation kick in? Recommend: at the start of Phase 2 codegen (week 8-10), so codegen output is shaped against a real consumer's needs before fixture-only validation closes.
