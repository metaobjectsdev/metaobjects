# C# codegen specifics

The C# port targets .NET consumers (EF Core + ASP.NET). Codegen runs through the
**`dotnet meta` .NET tool** — there is no Maven plugin and the Node `meta` binary
is **schema-migrations only** on the C# side (ADR-0015): `meta migrate` /
`meta verify --db` are Node-`meta`-owned; everything below is `dotnet meta`.

## Install

Per the always-on descriptor:

```bash
dotnet tool install --global MetaObjects.Cli   # provides `dotnet meta`
dotnet add package MetaObjects.Codegen          # the codegen generators
```

`dotnet meta` is a .NET tool invoked as `dotnet meta <command>` (the underlying
command is `dotnet-meta`).

## Run

```bash
dotnet meta gen metaobjects \
  --out Generated \
  --namespace Acme.Generated
dotnet meta gen --list                      # list registered generators
dotnet meta gen metaobjects --out Generated --generators entity,db-context,routes   # select a subset
dotnet meta verify metaobjects --codegen --out Generated   # codegen-drift gate (regenerate + diff vs committed)
```

`dotnet meta verify` defaults to `--templates` (the FR-004 prompt/template drift
gate, see the prompts reference); `--codegen` is the codegen-output drift gate.
**Schema migration + live-DB drift are NOT `dotnet meta`** — they run through the
Node `meta` tool (see the migration reference).

## `MetaObjects.Codegen` generators

Wire generators by their stable name (`dotnet meta gen --generators <names>`),
or run the default set. Output lands under `--namespace` in `--output-dir`.

| Stable name | Output |
|---|---|
| `entity` | `<Entity>.g.cs` — an EF Core entity class per `object.entity` / projection: PascalCase props mapped via `[Column]`, `[Table]`, `[Key]` (or class-level `[PrimaryKey]` for composites), `[MaxLength]`/validators, nullability from `@required`. Enum fields → a nested (or shared) C# `enum`; object fields → owned-type navigations; value objects → POCOs. A TPH `@discriminator` base is emitted `abstract` with `: Base` subtypes (single-table). |
| `db-context` | one `AppDbContext` — a `DbSet<T>` per entity + `OnModelCreating`: `.HasConversion<string>()` (enums), `.OwnsOne(...)`/`.ToJson(...)` (owned/jsonb object fields), `.HasPrecision(p,s)` (decimals), `.UsingEntity<>(...)` (M:N), `.HasDiscriminator(e => e.Type).HasValue<Sub>(...)` (TPH). |
| `routes` | `<Entity>Routes.cs` — ASP.NET **Minimal API** CRUD per writable entity (`source.rdb @kind="table"`) on the cross-port REST contract (`?filter[field][op]=`, `?sort=field:asc`, `?limit`/`?offset`, `?withCount=1` envelope, 400/404 envelopes). A TPH base emits polymorphic `GET /<base>(+/{id})` + a per-subtype CRUD set at `/<base>/<discriminatorValue lowercased>` (create injects the discriminator, cross-subtype get/update/delete → 404). |
| `filter-allowlist` | per-entity `<Entity>FilterAllowlist` (FR-009 — the server-side field+operator allowlist the routes validate against). |
| `callable` | `<Entity>.callable.g.cs` — an FR-015 calling method for a `source.rdb @kind="storedProc"|"tableFunction"`, via EF `FromSqlInterpolated` (args from the `@parameterRef` value object in declaration order). |
| `output-parser` / `extractor` / `output-prompt` / `render-helper` | the `template.output` prompt-pillar artifacts (strict parser, tolerant `extract`, output-format prompt fragment, typed render helper) — see the **prompts** reference. |
| `template` | the generic Mustache `templateGenerator()` primitive. |

Metadata lives under `metaobjects/` (or wherever you point `--metadata-dir`) in the
same canonical JSON every port reads — fused-key form, `source.rdb` + `@table`,
`@column` for a renamed physical column.

## Persistence + routes are the deployed artifact

C# generates a *complete* server stack: the entity classes + `AppDbContext` ARE the
persistence layer (EF Core), and the minimal-API routes mount on your `WebApplication`.
There is no runtime "ObjectManager" layer to wire — the generated EF Core code is
what runs. (The other ports leave a repository seam; C# does not.)

## Extending the generators (open-for-extension, ADR-0002)

The generators are subclassable: the per-class emit methods are `protected virtual`,
plus finer hooks — `EmitClassHeader` / `EmitClassDeclarationLine` (class declaration:
`partial`, marker interfaces), `EmitPropertyAttributes` (per-property C# attributes),
`EmitFileUsings` (extra usings), `EmitClassBodyTrailer` (extra members). Subclass a
generator and override only the seam you need rather than forking. `@default` on a
scalar emits a literal initializer; an `object.value`'s default storage is jsonb.

**Shared + externally-provided enums (FR-019).** A package-level abstract
`field.enum` (`abstract: true`, `@values`) extended by concrete entity fields is
materialized **once** (`Enums.g.cs`) and referenced — no per-entity nested enum.
Adding `@provided: true` to that declaration suppresses materialization entirely:
consuming fields reference a hand-written/third-party enum, and the C# namespace
**binds to the enum's declaring metadata package** via
`GenConfig.PackageNamespaces["<pkg>"] = "Your.Namespace"` (one entry per namespace;
`ProvidedEnumNamespace` is the single fallback). The `@values` still drive the DB
`CHECK` + validation. This replaces the retired C#-only `@csEnumType` FQN attr
(ADR-0026) — no language FQN ever lives in metadata (ADR-0001).

## Re-scaffold this context

Agent-context scaffolding is owned by the Node `meta` CLI (ADR-0015). `dotnet meta
agent-docs` only prints a redirect and exits non-zero — it does **not** scaffold.
(Re)scaffold the slim always-on Markdown + these `metaobjects-*` skills with
`npx meta agent-docs --server csharp [--client <fw>] [--out <dir>]`. A C# consumer
needs Node `meta` (npx) for this one scaffold step; codegen + verify stay on `dotnet meta`.
