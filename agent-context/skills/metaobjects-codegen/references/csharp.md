# C# codegen specifics

The C# port targets .NET consumers (EF Core + ASP.NET). Codegen runs through the
**`dotnet meta` .NET tool** — there is no Maven plugin and the Node `meta` binary
is **schema-migrations only** on the C# side (ADR-0015): `meta migrate` /
`meta verify --db` are Node-`meta`-owned; everything below is `dotnet meta`.

## Contents
- Install
- Run
- `MetaObjects.Codegen` generators
- Docs — one more entry in `codegen/Generators.cs`
- Persistence + routes are the deployed artifact
- Write your own generator
- Extending the generators (open-for-extension, ADR-0002)
- Re-scaffold this context

## Install

Per the always-on descriptor:

```bash
dotnet tool install --global MetaObjects.Cli   # provides `dotnet meta`
dotnet add package MetaObjects.Codegen          # the codegen generators
dotnet meta init                                # writes codegen/: Generators.cs, Program.cs, Codegen.csproj
```

`dotnet meta` is a .NET tool invoked as `dotnet meta <command>` (the underlying
command is `dotnet-meta`).

## Run

The generator list is `codegen/Generators.cs` (ADR-0034 Amendment 9) — every generator the
project runs, documentation included, each with its options as init properties.
`codegen/Program.cs` is two lines that run it; `dotnet meta init` writes both and
`codegen/Codegen.csproj`. Nothing is generated that the list does not declare.

```csharp
// codegen/Generators.cs
using MetaObjects.Codegen;

public static class Generators
{
    public static IReadOnlyList<IGenerator> All { get; } =
    [
        new MetaObjects.Codegen.Generators.EntityGenerator(),
        new MetaObjects.Codegen.Generators.DbContextGenerator(),
        new MetaObjects.Codegen.Generators.FilterAllowlistGenerator(),
        new MetaObjects.Codegen.Generators.RoutesGenerator(),
    ];
}
```

**Column names come from `naming` in `.metaobjects/config.json`, the one setting every port
reads** (ADR-0058): `meta migrate`, every port's codegen and every runtime `ObjectManager`.
The default is `snake_case`, what `meta migrate` creates. A database whose columns are named
exactly like the fields declares it there, once, for every port:

```json
{ "schema_version": 1, "naming": { "columns": "literal" } }
```

There is no per-port or command-line naming: `--column-naming` is refused, and
`verify --codegen` names a naming mismatch as one rather than telling you to regenerate. Through 1.0 this port defaulted to the field names; a
database built that way needs the `literal` line above.

```bash
dotnet meta gen metaobjects --out Generated --namespace Acme.Generated   # runs the list
dotnet meta gen --list                      # list registered generators
dotnet meta gen metaobjects --out Generated --generators entity   # narrow to declared entries
dotnet meta verify metaobjects --codegen --out Generated   # codegen-drift gate (regenerate + diff vs committed)
```

`gen` and `verify --codegen` always run the list through `dotnet run --project codegen`; with
no `codegen/Generators.cs` they exit 2 and write nothing. `--generators` narrows a run to the
declared entries named and never adds one: naming an entry the list does not declare is
refused. `verify --codegen` regenerates the same list, so it never disagrees with `gen`.

**Where `codegen/` goes, and sharing it with a TypeScript port.** `gen` looks for
`codegen/` in the project root: the parent of the `<metadataDir>` it is given, or the
directory it runs in when given none. Run `dotnet meta init` there (or pass that directory as
`--root <dir>`); a `codegen/` anywhere else is never run. In a repository that also has a
TypeScript port, that is the same `codegen/` the TypeScript side keeps its owned generators
in, and C# ejects land in its `codegen/generators/` beside the `.ts` copies. They coexist:
`Codegen.csproj` compiles only `*.cs` and `tsconfig.codegen.json` only `*.ts`. Ignore the
build output (`codegen/bin/`, `codegen/obj/`) in `.gitignore`.

`dotnet meta verify` defaults to `--templates` (the FR-004 prompt/template drift
gate, see the prompts reference); `--codegen` is the codegen-output drift gate.
**Schema migration + live-DB drift are NOT `dotnet meta`** — they run through the
Node `meta` tool (see the migration reference).

## `MetaObjects.Codegen` generators

Wire generators as a list in **`codegen/Generators.cs`** — a static list of constructed
generators, with their options as init properties (ADR-0034 Amendment 9); `codegen/Program.cs`
is a two-line entry point that passes the list to `CodegenCli.Run`. `dotnet meta init`
(new in 1.1.0) scaffolds both files; `dotnet meta eject` writes them when either is missing.
`dotnet meta gen` runs the declared list, documentation included — there is no default
set and no separate docs command. `--generators <names>` narrows a run to entries the
list already declares, by stable name; it never adds one, and naming an entry the list
does not declare is refused. `dotnet meta gen --list` is the catalog of what the port
registers, not what this project runs; under each name it prints the expression that lists
that generator in `codegen/Generators.cs` and its options. Output lands under `--namespace` in
`--out` unless a generator's own init properties say otherwise — documentation
does (below).

| Stable name | Entry in `codegen/Generators.cs` (`new MetaObjects.Codegen.Generators.…`) | Output |
|---|---|---|
| `entity` | `EntityGenerator()` | `<Entity>.g.cs` — an EF Core entity class per `object.entity` / projection: PascalCase props mapped via `[Column]`, `[Table]`, `[Key]` (or class-level `[PrimaryKey]` for composites), `[MaxLength]`/validators, nullability from `@required`. Enum fields → a nested (or shared) C# `enum`; object fields → owned-type navigations; every concrete value object and sourceless projection → a POCO, which is also the template tier's payload/response type (ADR-0056; package-qualified, e.g. `AcmeAlphaNote`, when another object shares its short name). A TPH `@discriminator` base is emitted `abstract` with `: Base` subtypes (single-table). |
| `db-context` | `DbContextGenerator()` | one `AppDbContext` — a `DbSet<T>` per entity + `OnModelCreating`: `.HasConversion<string>()` (enums), `.OwnsOne(...)`/`.ToJson(...)` (owned/jsonb object fields), `.HasPrecision(p,s)` (decimals), `.UsingEntity<>(...)` (M:N), `.HasDiscriminator(e => e.Type).HasValue<Sub>(...)` (TPH). |
| `routes` | `RoutesGenerator()` | `<Entity>Routes.cs` — ASP.NET **Minimal API** CRUD per writable entity (`source.rdb @kind="table"`) on the cross-port REST contract (`?filter[field][op]=`, `?sort=field:asc`, `?limit`/`?offset`, `?withCount=1` envelope, 400/404 envelopes). A TPH base emits polymorphic `GET /<base>(+/{id})` + a per-subtype CRUD set at `/<base>/<discriminatorValue lowercased>` (create injects the discriminator, cross-subtype get/update/delete → 404). |
| `filter-allowlist` | `FilterAllowlistGenerator()` | per-entity `<Entity>FilterAllowlist` (FR-009 — the server-side field+operator allowlist the routes validate against). |
| `callable` | `CallableGenerator()` | `<Entity>.callable.g.cs` — an FR-015 calling method for a `source.rdb @kind="storedProc"|"tableFunction"`, via EF `FromSqlInterpolated` (args from the `@parameterRef` value object in declaration order). |
| `output-parser` / `extractor` / `output-prompt` / `render-helper` | `OutputParserGenerator()`, `ExtractorGenerator()`, `OutputPromptGenerator()`, `RenderHelperGenerator("prompts")` (its constructor argument is the template root its refs resolve from) | the prompt-pillar artifacts for a **responding `template.prompt`** — one carrying `@responseRef` (ADR-0052: these tiers are INBOUND; `template.output` is outbound only and emits no parser). The strict parser, the tolerant `extract`, the **output-format prompt fragment** (`output-prompt`; presentation via `@promptStyle: guide`/`inline`/`exampleOnly`), and the typed render helper. They reference the value objects' POCOs from `entity` and declare no payload type — wire `entity` too (`--list` says so). See the **prompts** reference. |
| `names` | `NamesGenerator()` | `<Entity>Names.g.cs` — `public abstract class <Entity>Names` of `const` physical database names, MIRRORING THE METADATA TREE: the object's own `Type`/`SubType`/`Name` (`Name` is the OBJECT's name, never a physical one), then per `source.rdb` keyed by `@role` — `SourcePrimaryType`/`SubType`/`Kind`, `SourcePrimarySchema` when declared, and the physical name under the alias for its `@kind` (`SourcePrimaryTable` / `SourceReplicaView` / `SourcePrimaryProc` / `…Function` / `…MaterializedView`) — then a `<Field>Field`/`<Field>Column` pair per field, then each identity and index (`IdentityPkName`, and `IdentityUqCustEmailIndex` / `IndexIxCustStatusIndex` — the DATABASE name, carried for `identity.secondary` and `index.lookup` only), then a complete `ColumnsByField`. There is no `ReadOnly`: it is a derivation over `@kind`, so ask `SourcePrimaryKind`. Emitted for every object with a declared or inherited primary source, PLUS a fragment for any abstract base such an object extends (its own identity + columns, and NO source members — it has no table). A class whose object extends another one **inherits** it (`class CopayAuthNames : AuthNames`) rather than restating its constants — a C# `const` is inherited, so `CopayAuthNames.IdColumn` and `CopayAuthNames.SourcePrimaryTable` resolve through the base (`Type`/`SubType`/`Name` are redeclared with `new`, since every artifact carries its own). `abstract`, not `static`, precisely so it can be inherited; it still cannot be instantiated. In the run, `entity` and `db-context` reference the constants (`[Table(OrderNames.SourcePrimaryTable)]`, `[Column(OrderNames.StatusColumn)]`, `.ToView(OrderNames.SourceReplicaView)`); a run without `names` falls back to literals. |
| `template` | `TemplateGenerator.Create(name, template, walk, provider)` (a factory, not `new`) | the generic Mustache `templateGenerator()` primitive. |

Metadata lives in the directory the gen run's positional `<metadataDir>` argument
names (`dotnet meta gen ./model --out …`); with none, `sources` in
`.metaobjects/config.json` decides, and `metaobjects/` is only that file's default. There
is no `--metadata-dir` flag. It is the same canonical JSON every port reads — fused-key form, `source.rdb` + `@table`,
`@column` for a renamed physical column.

**Projections (read-only views).** An `object.projection` (read-only `source.rdb`
`@kind: view` child) gets an EF entity mapped with `.ToView(...)` and no `[Table]`.

Its REST surface is generated and READ-ONLY (F22): GET list + GET by id, the same
`?filter[...]`/`?sort=` grammar as a table entity against allowlists built from the
projection's OWN declared field set, and `POST` / `PATCH` / `PUT` / `DELETE` each
answering `405 {"error": "method_not_allowed"}` — 405 and not 404 because the same
path answers GET. A KEYLESS projection mounts no `/{id}` route at all, so it refuses only
the collection verb. Keyless here means anything but a declared single-column
`identity.primary`: no identity, or a composite one.

Those refusals are mounted EXPLICITLY, not left to ASP.NET: unmounted, the framework
answers its own 405 with an EMPTY body, which is a wire shape no other port sends.

**Reports.** A concrete `object.report` whose read source is `source.rdb @kind: view` is
served like a keyless projection. For a report `<R>`: `<R>.g.cs` (a keyless row class,
one property per derived field) mapped in the `DbContext` with a `DbSet` and
`HasNoKey().ToView(...)`, `<R>Routes.g.cs` (`MapGet` list, `MapPost` answering 405, no
`{id}` route) and `<R>FilterAllowlist.g.cs`. Every derived field with filter operators
is filterable and sortable; on a report an enum dimension sorts too (an entity's enum
field is still not sortable in C#). The view and its columns are bound by literal, with
no names artifact. `gen` refuses a served report with a derived field over a
`field.object`, or one whose Pascal name equals the report's class name. A report with
no view source, or an abstract one, generates nothing. The route and contract:
`references/reporting.md` in the `metaobjects-authoring` skill.

**Entity read-view (write-through).** An `object.entity` that keeps its writable `table`
primary source and adds a `@role: replica` `@kind: view` source is a write-through
read-view (#214): the generated EF entity carries the derived `origin.*` fields read-only
and `db-context` registers that read model against the replica view (`.ToView(...)`);
reads route to the view, writes to the table (derived fields excluded), and a
create/update re-reads the row via the view by primary key (read-your-writes). The replica
view's DDL is emitted by the Node `meta migrate` from the same origin assembly as a
projection view.

**Requirement tests (`requirement-tests`).** A recommended approach, not a contract. For a
model that declares `requirement.*` nodes it writes, per metamodel package,
`Requirements_<pkgKey>_Witnesses.g.cs` (an interface with one default member per
non-skipped test, each failing with `unimplemented requirement: …`) and
`Requirements_<pkgKey>_Tests.g.cs` (one xUnit `[Fact]` per requirement; `[Fact(Skip = …)]`
for a `planned` or `retired` one), in `<namespace>.Requirements`. Both are rewritten whole
on every run, so never edit them: the project's code goes in one witness class
(`<namespace>.RequirementWitnesses` by default) that implements every generated interface.
Implement each member EXPLICITLY (`void Requirements_<pkgKey>_Witnesses.req_…() { … }`): a
witness whose requirement is retired or deleted then stops compiling (CS0539), where an
implicit `public void req_…()` goes stale silently. List it in `codegen/Generators.cs` with
its own `OutDir`, the test project's directory, since the tests need xunit:
`new MetaObjects.Codegen.Generators.RequirementTestsGenerator { OutDir = "tests/Acme.Shop.Tests/Generated" }`.
The plain `dotnet meta gen ./metadata --out ./Generated` then writes them there and
`dotnet meta verify --codegen` checks them there, in the same run as everything else.
Options (`OutDir`, `TestNamespace`, `WitnessClass`, `Grain`, `Filter`, `Renderer`,
`WarnUncovered`) are init properties set on the entry in an owned
`codegen/Generators.cs`; `Grain` needs `using MetaObjects.Core.Requirement;`. A filter
REPLACES the default of functional L4/L5. `dotnet meta eject requirement-tests` copies the
generator with its default rendering. The requirement checks in `dotnet meta verify` are
core and are not ejectable.

## Docs — one more entry in `codegen/Generators.cs`

There is no `dotnet meta docs` command (removed in 1.1.0, ADR-0034 Amendment 9): the api
reference is `ApiDocsGenerator`, an ordinary entry in the same list as every other
generator:

```csharp
new ApiDocsGenerator { OutDir = "docs/csharp" }   // → docs/csharp/api/csharp (AGENT-API.md + per-entity pages)
```

`dotnet meta gen` writes it, alongside everything else `codegen/Generators.cs` declares.
`AGENT-API.md` has the exact imports, signatures, and payload field shapes for the
generated code. **Before calling any generated code, read `api/csharp/AGENT-API.md`.**
Options (init properties): `OutDir` (give it a directory of generated files only; unset, the pages land under `--out`), `ApiSubDir` (default `api/csharp`),
`ProjectName`, `ModelBaseUrl`. To write only the documentation,
`dotnet meta gen --generators api-docs`. In a repository with more than one port, give each port's documentation its own directory: another port's generated pages count as foreign files, and in a shared directory each port's `verify --codegen` reports the other ports' pages as drift. Migrating a project that ran `dotnet meta docs`:
<https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md>, section "C#".

## Persistence + routes are the deployed artifact

C# generates a *complete* server stack: the entity classes + `AppDbContext` ARE the
persistence layer (EF Core), and the minimal-API routes mount on your `WebApplication`.
There is no runtime "ObjectManager" layer to wire — the generated EF Core code is
what runs. (The other ports leave a repository seam; C# does not.)

## Write your own generator

For any output the model describes and no reference emits, write an `IGenerator` in the
console project `codegen/` (`dotnet meta init` writes it) and list it in
`codegen/Generators.cs`; `dotnet meta gen` and `dotnet meta verify --codegen` run that list.

```csharp
// codegen/generators/FieldListGenerator.cs
using MetaObjects.Codegen;

namespace Codegen.Generators;

public sealed class FieldListGenerator : IGenerator
{
    public string Name => "field-list";

    public IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        ctx.Entities.Where(o => !o.IsAbstract)          // EVERY object arrives, abstract bases included
            .Select(o => new EmittedFile(
                $"field-list/{o.Name}.txt",
                string.Join("\n", o.Fields().Select(f => $"{f.Name}: {f.SubType}{(f.ResolvedIsArray() ? "[]" : "")}")) + "\n"));
}
```

List it in `codegen/Generators.cs` as `new Codegen.Generators.FieldListGenerator()`; every
entry runs, and `--generators` only narrows. Model reads: `Fields()`, `Attr(n)`,
`ResolvedIsArray()`, `EffectiveEnumValues`, `MaxLength` resolve; `IsArray`, `OwnAttr`,
`EnumValues` do not. `ValueObjectNames.ResolveFieldRef(field, ctx.Root)` resolves an
`@objectRef`; `CSharpNaming.RoutePath(obj)` is the REST segment; constants come from
`using static MetaObjects.Core.Field.FieldConstants;`. A generator that throws is reported
as the generator, with its message.

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
