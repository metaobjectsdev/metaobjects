# C# port

A first-class full-stack target on .NET 8. Loader + conformance + EF Core codegen
+ render engine + the `meta` CLI all ship. Targets EF Core + ASP.NET Core +
Postgres + Npgsql. The baseline is **.NET 8** (`net8.0`); the tool and the packages are not
built for earlier runtimes.

## Regeneration and hand edits

`dotnet meta gen` has no three-way merge (that is TypeScript-only). It decides per file from a
committed hash manifest, `.metaobjects/.gen-state/.hashes.json`: a file that still matches what
the generator wrote is overwritten, and an edited one is refused by name. To change what a
generator emits, `dotnet meta eject <name>` copies it into `codegen/generators/` for you to own.
Commit the manifest.

## Keep your EF Core model: contracts as plain DTOs

Contracts and entities are not forced into one type. Declare an object with **no
`source.rdb`** (a *sourceless* object) and `EntityGenerator` writes a POCO with DataAnnotations
and **no EF mapping**: no `[Table]`, no `DbSet<>`, no `AppDbContext` entry, no CRUD routes, no
filter allowlist. A sourced entity gets `[Table]`/`[Key]`/`[Column]` and the full EF Core
surface. So the same model can hold sourceless request/response contracts that you hand to your
own controllers and sourced entities where you want MetaObjects to own the mapping; your
existing hand-written EF entities are not touched.

A declaration with no `source.rdb` (this one is a plain DTO POCO):

```json
{ "object.entity": {
    "name": "AuthorSummary",
    "children": [
      { "field.long":   { "name": "id" } },
      { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
      { "identity.primary": { "@fields": "id" } }
    ]
}}
```

Wire only the generators you want in `codegen/Generators.cs`; leave `db-context` out if you keep your own `DbContext`, since the generated `AppDbContext` emits Postgres column types (`uuid`, `jsonb`, `timestamptz`) today. Note that the generated CRUD
routes use the *entity* POCO, as described under [Use](#use); the DTO shape above is for
objects you keep sourceless.

## Install

Published to [NuGet](https://www.nuget.org/packages/MetaObjects) at `1.1.4` — four
packages, version-locked to the C# port version: `MetaObjects` (loader), `MetaObjects.Codegen`,
`MetaObjects.Render` and the `MetaObjects.Cli` tool.

Install the CLI as a .NET tool, then scaffold the generator list:

```bash
dotnet tool install --global MetaObjects.Cli
dotnet meta          # bare invocation prints the usage banner
dotnet meta init     # writes codegen/Generators.cs (the generator list), codegen/Program.cs, codegen/Codegen.csproj
```

Your app is a separate project beside `codegen/`. `dotnet meta init` runs from the root of your
repository, and the app's `.csproj` at that root must not compile `codegen/`, which has its own
`Main` (without the `Compile Remove` the build fails with CS0579 and CS8802). This sample uses
SQLite so it runs with nothing else installed; the same generated code runs on Postgres (see
[Use](#use)):

```xml
<!-- App.csproj -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="MetaObjects.Codegen" Version="1.1.4" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="8.0.11" />
  </ItemGroup>
  <ItemGroup>
    <Compile Remove="codegen/**" />
  </ItemGroup>
</Project>
```

The C# CLI is invoked as `dotnet meta` (command `dotnet-meta`), or run directly
from the repo via `dotnet run --project server/csharp/MetaObjects.Cli`. It is
deliberately **not** a bare `meta` executable — that name belongs to the
canonical Node `meta` CLI, which owns schema + TS codegen (ADR-0015).

## Configure

Drop metadata under `metaobjects/`, for example `metaobjects/meta.blog.json`:

```json
{ "metadata.root": {
    "package": "acme::blog",
    "children": [
      { "object.entity": {
        "name": "Author",
        "children": [
          { "source.rdb": { "@table": "authors" } },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "name", "@required": true, "@maxLength": 200, "@filterable": true } },
          { "field.string": { "name": "bio", "@maxLength": 2000 } },
          { "field.enum":   { "name": "role", "@values": ["writer", "editor"], "@required": true, "@filterable": true } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ]
      }}
    ]
}}
```

### Building on a shared model (optional)

A model published from another repository is declared under `dependencies` in
`.metaobjects/config.json` and synced by the Node CLI (`meta deps sync` writes
`.metaobjects/deps.lock.json` and a committed snapshot under `.metaobjects/deps/`). `dotnet meta`
reads both, at every rung of the source ladder, and never writes them: a snapshot that no longer
matches the lock fails with `ERR_DEPENDENCY_SNAPSHOT_STALE`. The snapshot loads first, so your
own metadata can `extends`, overlay or reference its nodes, but an imported node is not generated
(and is not counted by the requirement gate) unless `scope.include` names its package. What C#
does and does not do is in
[Metadata dependencies](../features/metadata-dependencies.md).

### Custom providers (optional)

If your app needs a metamodel subtype the core doesn't ship, declare an
`IMetaDataTypeProvider` and compose it into the registry before loading:

```csharp
using MetaObjects;
using MetaObjects.Loader;

var registry = Provider.ComposeRegistry(new IMetaDataTypeProvider[] {
    CoreTypes.CoreTypesProvider,
    yourProvider,            // adds your custom subtype/attrs
});

var loader = MetaDataLoader.FromDirectory("./metaobjects", registry);
```

The provider object has the same four-member contract (`Id`, `Dependencies`,
`Description`, `RegisterTypes(registry)`) as TS / Python. Composition errors
surface `ERR_PROVIDER_DUPLICATE_ID`, `ERR_PROVIDER_MISSING_DEPENDENCY`,
`ERR_PROVIDER_DEPENDENCY_CYCLE` — codes match the cross-port contract. See
[`../features/extending-with-providers.md`](../features/extending-with-providers.md)
for the full reference and
[`../recipes/extending-metaobjects-with-providers.md`](../recipes/extending-metaobjects-with-providers.md)
for a worked example.

## Generate

**The generator list.** Every generator a project runs is an entry in `codegen/Generators.cs`,
with its options as init properties, the api reference included (ADR-0034 Amendment 9).
`dotnet meta init` writes that file with an empty list, beside `codegen/Program.cs` (two
lines that run it) and `codegen/Codegen.csproj`. `dotnet meta gen` runs the list through
`dotnet run --project codegen`; nothing is generated that the list does not declare, and a
project with no `codegen/Generators.cs` gets an error, not output.

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

```csharp
// codegen/Program.cs
using MetaObjects.Codegen;
return CodegenCli.Run(args, Generators.All);
```

Replace the empty list `dotnet meta init` wrote with the one above before the first `gen`: with
an empty list `gen` writes nothing, and it needs an output directory (`--out`, or `csharp.outDir`
in `.metaobjects/config.json`, below).

```bash
# Run the list: EF Core entities + AppDbContext + CRUD minimal-API routes
dotnet meta gen ./metaobjects --out ./Generated

# The drift gate: regenerate into a temp tree and fail (exit 1, naming the files) if the
# committed ./Generated differs. Run it in CI.
dotnet meta verify ./metaobjects --codegen --out ./Generated
```

`verify --codegen` is the gate for generated code. `dotnet meta verify ./metaobjects
--templates ./prompts` is a different gate, for prompt templates against their payloads
(FR-004): it says nothing about generated code, and it fails with exit 2 when the directory it
is given does not exist. A bare `dotnet meta verify ./metaobjects` runs that templates gate
against `prompts/` when it exists, else `templates/`, and fails the same way when neither
exists. It also runs the codegen gate when `--out <dir>` and `codegen/Generators.cs` are
present, and skips it with a note otherwise; name both subverbs to require both.

The output directory and the namespace are project settings, so `gen` and `verify` cannot
disagree about them. Declare them once in `.metaobjects/config.json`; `outDir` is relative to the
directory holding `.metaobjects/`:

```json
{ "schema_version": 1, "csharp": { "outDir": "Generated", "namespace": "Acme.Blog" } }
```

Each generated type's namespace comes from the package bindings, keyed by that type's own
metadata package: a type-level override (`GenConfig.TypeOverrides`), then a package-level one
(`PackageNamespaces`), then the `Convention` rule (strip a package prefix, prepend a root, case
each `::` segment), then `UnmappedStrategy`. The default strategy, `Flatten`, puts every type in
one namespace: `--namespace` when given, else `csharp.namespace`. There is no built-in value, so
a run that emits a file needing it with neither set stops and names both; a run that emits
nothing never asks. The namespace must be a dotted path of C# identifiers. `dotnet meta gen` and
`verify` set only that flat namespace; the per-package bindings are `GenConfig` properties, set
when you run codegen from your own code with `CodegenRunner`.

With that, `dotnet meta gen` writes there, `dotnet meta verify --codegen` diffs against it, and
a plain `dotnet meta verify` in CI runs the codegen gate with no flags. `--out <dir>` still works
and wins over the config. A project that sets neither gets the skip note, which names the setting.
The other ports ignore the `csharp` block.

`dotnet meta gen --list` is the catalog, and it shows what each generator requires. `routes`
requires `entity`, `db-context` and `filter-allowlist`, because the handlers it emits
reference their output; `gen` warns when one is missing from the list, since the result
would not compile. `--generators <names>` narrows a run to the declared entries named; it
never adds one, and naming an entry the list does not declare is refused.

**Own a generator.** `dotnet meta eject <name>...` copies a reference generator into
`codegen/generators/`. Every generator `dotnet meta gen --list` shows is ejectable except
`template`, the Mustache primitive, which has no emit logic of its own to own. An ejected
generator comes with the emitters it writes its output through (the enum, navigation,
doc-comment and prompt-tier writers), so the copy owns the code that writes the file and not
a shell around the package's; the naming and type-mapping tables (`CSharpNaming`,
`ValueObjectNames`) stay in the package as the engine. Eject writes the three `codegen/` files
when they are missing, with the copy already listed as `new Codegen.Generators.<Name>()`;
when `codegen/Generators.cs` exists it prints that entry for you to add in place of the
packaged one. `dotnet meta eject api-docs` does the same for the api reference. Ejecting into
a project whose `codegen/Codegen.csproj` pins an older `MetaObjects.Codegen` than the tool
prints a warning naming the line to change. See
[Own your codegen → C#](../features/own-your-codegen.md#c-dotnet-meta-eject).

**Give a copy back.** `dotnet meta eject --undo` drops every owned copy that is identical to the
shipped generator (the comparison ignores blank lines, order and trailing whitespace, and covers
the emitters eject handed over with it); `dotnet meta eject --undo <name>...` drops only those.
A named copy that differs is refused with exit 2 and nothing is removed, naming how far it
differs, unless you pass `--force` to discard your edits. Every name is checked before anything
is deleted. A companion file goes only when it is identical and no remaining owned generator
uses it, and `codegen/runtime/` goes only when every owned generator that used it is gone.
`--undo` never edits `codegen/Generators.cs` or the project: it prints the line to change for
each entry (`new Codegen.Generators.X()` back to `new MetaObjects.Codegen.Generators.X()`), and
says plainly when nothing is identical. There is no `doctor` command: the one-line notice `gen`
prints when identical copies exist (stderr, advisory, never the exit code) and
`dotnet meta gen --list`, which marks each owned copy `identical` or `DIFFERS`, are where stale
or identical copies show.

**Strictness.** `dotnet meta gen` loads leniently: an unknown `@attribute` is a warning naming
the attribute, node and file, and gen generates anyway. `dotnet meta gen --strict` loads as
`verify` does (ADR-0023): the same `ERR_UNKNOWN_ATTR` lines with a gen-specific hint (drop `--strict`), exit 1, before any file is
written. `verify` itself stays strict unless you pass `--lax`.

## Write your own generator

A generator is a class that implements `IGenerator` (`MetaObjects.Codegen/Generator.cs`): a
kebab-case `Name` and `Generate(GenContext)`, which returns the files (`EmittedFile(path,
content)`, the path relative to the output directory). `ctx.Entities` and `ctx.Root` are the
loaded model. Optional members: `OutDir` (write somewhere other than `--out`), `HandEdits`.

```csharp
// codegen/generators/EntityList.cs
using MetaObjects.Codegen;

public sealed class EntityListGenerator : IGenerator
{
    public string Name => "entity-list";

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var names = ctx.Entities.Select(e => e.Name).Order(StringComparer.Ordinal);
        yield return new EmittedFile("EntityList.g.cs",
            "// <auto-generated/>\npublic static class EntityList\n{\n" +
            "    public static readonly string[] Names = [" + string.Join(", ", names.Select(n => $"\"{n}\"")) + "];\n}\n");
    }
}
```

Wire it by adding one entry to the list in `codegen/Generators.cs`, beside the packaged ones:

```csharp
    [
        new MetaObjects.Codegen.Generators.EntityGenerator(),
        new EntityListGenerator(),
    ]
```

`dotnet meta gen` then runs it with the rest of the list, and `dotnet meta verify --codegen`
regenerates it and compares, so a hand edit to its output or a model change that moves it fails
the gate like any packaged generator's. The example above is compiled and run by
`GeneratorAuthoringExampleTests`. To start from a shipped generator rather than a blank class,
`dotnet meta eject <name>` copies one in.

## Documentation

`dotnet meta init --with-docs` writes the list with the api reference already in it
(`new MetaObjects.Codegen.Generators.ApiDocsGenerator { OutDir = "docs/csharp", ProjectName = "<dir>" }`),
so `gen` writes it. It does not write `.metaobjects/config.json`: set `"csharp": { "outDir": "<dir>" }`
there and a plain `dotnet meta verify` drift-checks the docs with the rest of the codegen output
(`verify --codegen` compares the whole tree of each entry's `OutDir`, so keep it generated files
only). Against an existing list, init prints the entry to add and edits nothing. Without the flag
init is unchanged. The api pages carry a "Model / metadata" link only when the entry sets
`ModelBaseUrl`: the C# port writes no model pages of its own, so a relative link would resolve to
nothing and is omitted.

Schema migrations are owned by the Node `meta` CLI (ADR-0015) — the C# CLI is
`gen` + `verify` only.

A declarative Mustache template-spec is one more entry in `codegen/Generators.cs`; see
[Declarative template-codegen](#declarative-template-codegen-templatespecgenerator) below.

The codegen emits:

- `Author.g.cs` — class per entity (a mutable attributed POCO, not a record).
- `<Report>.g.cs` — keyless row class per **view-backed report** (`object.report` with a
  read-only `@kind: view` source); mapped in `AppDbContext` with `DbSet` +
  `HasNoKey().ToView(...)`. It is served like a keyless projection: `<Report>Routes.g.cs`
  (`MapGet` list, `MapPost` answering 405, no `{id}` route) and
  `<Report>FilterAllowlist.g.cs`, with every derived field that has filter operators
  filterable and sortable (on a report an enum dimension sorts too; an entity's enum field
  does not). A derived field that can be null is a nullable member (`long?`, `decimal?`); a
  measure with `@default`, and in a `@spine` report a key or `@required` column of the spine
  entity, is not (`long`, `decimal`). No names artifact. An enum dimension reaches the wire
  as its string symbol only when the host serializes enums as strings (`ConfigureHttpJsonOptions` with a
  `JsonStringEnumConverter`): the routes return the row object and the host owns serialization.
  See [reporting](../features/reporting.md#how-a-report-is-served).
- `AppDbContext.g.cs` — `DbSet<Author>`, projection `.ToView()`, `@storage` owned
  types via `OwnsOne` (single) / `OwnsMany(...).ToJson(...)` (`@isArray` array-of-VO),
  enum-as-string via `HasConversion<string>()`.
- `AuthorRoutes.g.cs` — CRUD minimal-API endpoints.
- `AuthorFilterAllowlist.g.cs` — the server-side filter/sort allowlist feeding the
  generated list handler.

### Decimals and null members on the wire

What the generated API writes is the project setting `wire` in `.metaobjects/config.json`
([api-contract.md, "The wire setting"](../features/api-contract.md#the-wire-setting)). With no
setting, it writes what System.Text.Json writes: a decimal is a JSON number that keeps its scale
(`12.50`, `0.0000001`), and a value object's null member is `null` with its key present. That is
the 1.0.x output. `"wire": { "decimals": "string" }` writes the canonical string of ADR-0019
Amendment 1 (`12.50` is `"12.5"`, zero is `"0"`). `"nullMembers": "omit"` leaves a null member
out (`[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` on each nullable member),
and `"emit"` is what the default already writes.

Input is the same in every mode. It may be a string or a number, is read exactly, and is
`400 validation` when it has more fraction digits than `@scale` or more integer digits than
`@precision - @scale` (no `@scale` beside `@precision` means 0). A filter operand compares
exactly; a bad one is `400 invalid_filter_value`. On SQLite a decimal is read at 15 significant
digits. Every port runs the shared vectors in `fixtures/decimal-wire/`.

`dotnet meta gen` writes `DecimalWire.g.cs` once per namespace that has a decimal (named
`DecimalWire.<Namespace>.g.cs` when the model binds more than one namespace;
`MetaNetValidation` follows the same rule). By default a decimal property carries
`[DecimalWire.Number]`, or `[DecimalWire.Number(precision, scale)]` with `@precision`. Under
`"decimals": "string"` it carries the string converter, or `[DecimalWire.Declared(precision,
scale)]`. A decimal array is an `IList<decimal>`. A stored value the CLR `decimal` cannot hold
answers `500 {"error": "decimal_out_of_range"}` (`DecimalRangeEndpointFilter`). An owned `routes`
generator copies `DecimalWire.cs` and `DecimalRangeEndpointFilter.cs`. Do not strip the
attributes or delete `DecimalWire.g.cs` to change the output: they also check input. Set `wire`
and regenerate.

### `<Entity>Names` — the physical names, as constants

`names` is opt-in — list `new MetaObjects.Codegen.Generators.NamesGenerator()` in
`codegen/Generators.cs` (`dotnet meta gen --list` names the whole catalog). Listing a generator is not
owning it: to change what `names` emits, `dotnet meta eject names` copies its source
into `codegen/generators/` (see "Own a generator" above). When listed, a project gets
`<Entity>Names.g.cs`. It carries the physical
database names for one object as `const string`s:

```csharp
// SubscriberNames.g.cs (using/namespace elided)
public abstract class SubscriberNames
{
    public const string Type = "object";
    public const string SubType = "entity";
    public const string Name = "Subscriber";

    public const string SourcePrimaryType = "source";
    public const string SourcePrimarySubType = "rdb";
    public const string SourcePrimaryKind = "table";
    public const string SourcePrimaryTable = "subscribers";

    public const string CreatedAtField = "createdAt";
    public const string CreatedAtColumn = "created_at";
    public const string IdField = "id";
    public const string IdColumn = "id";

    public const string IdentityPrimaryType = "identity";
    public const string IdentityPrimarySubType = "primary";
    public const string IdentityPrimaryName = "primary";

    public static readonly Dictionary<string, string> ColumnsByField = new(System.StringComparer.Ordinal)
    {
        ["createdAt"] = CreatedAtColumn,
        ["id"] = IdColumn,
    };
}
```

**The artifact mirrors the metadata tree.** Every node it describes — the object, each
`source.rdb`, each identity, each index — carries its own `Type`, `SubType` and `Name`,
and a physical name sits under the member that says what it IS:
`SourcePrimaryTable`, `SourceReplicaView`, `SourcePrimaryProc`, using the metamodel's own
FR-016/ADR-0018 kind→alias map. `SubscriberNames.SourcePrimaryView` does not exist, so
the read site answers "table or view?" instead of the reader having to. Sources are keyed
by `@role`, which is what gives a **write-through** entity's replica view a member of its
own (`SourceReplicaView`) — it declares two physical names and the artifact used to carry
one.

> **`Name` changed meaning in 0.25.0 and still compiles.** It held the PHYSICAL name; it
> now holds the object's own name. `[Table(SubscriberNames.Name)]` in hand-written code
> binds a table called `Subscriber` instead of `subscribers` — silently. `Kind`, `ReadOnly`
> and a top-level `Schema` are gone and fail to compile, which is the loud half. Grep for
> `Names.Name` before regenerating. `ReadOnly` is not relocated but REMOVED: it was never
> metadata, only a derivation over `@kind` — ask `SourcePrimaryKind` instead.

An identity or index carries an `Index` member — its DATABASE name — only where one
exists: `identity.secondary` and `index.lookup`. An `identity.primary` gets none, because
no port's codegen names a primary key (Postgres migrations hardcode `<table>_pkey`, SQLite
emits an unnamed PK), and carrying that would restate a migrate-only formula in the
artifact built to stop exactly that.

`const`, not `static readonly`: a `[Table("...")]`/`[Column("...")]` attribute
argument must be a compile-time constant, and those two attributes are the
whole reason this artifact can replace a literal there rather than sit beside
one. The generated entity class and `AppDbContext` already reference these
constants — `[Table(SubscriberNames.SourcePrimaryTable)]`, `[Column(SubscriberNames.CreatedAtColumn)]`
— instead of embedding the same physical names a second time, so the constant
and the EF mapping cannot drift apart.

**Prefer a typed handle where one exists.** If the ORM gives you a
type-checked object for the same thing, use that. Replacing it with a string
constant trades an error the compiler catches for one the database raises at
runtime. These constants are for the places with no typed handle: raw SQL, a
migration script, a log line, an external system's column mapping.

Here, that handle is the generated EF Core property. If you are writing a
LINQ query, use it (`db.Subscribers.Where(s => s.CreatedAt > cutoff)`) — it is
type-checked against the `DbContext` model, and swapping it for
`SubscriberNames.CreatedAtColumn` trades a compile error for a runtime one.
Reach for the constant instead in raw SQL (`FromSqlRaw`/`FromSqlInterpolated`),
a migration script, a log line, or an external system's column mapping.

**It follows `extends`, so a constant you do not find on a class is on its base.**
`<Entity>Names` is a `public abstract class` — abstract rather than static precisely so it
can be inherited — and an object that extends another produces a class that extends the
other's:

```csharp
public abstract class CopayAuthNames : AuthNames
{
    public const string CopayAmountField = "copayAmount";
    public const string CopayAmountColumn = "copay_cents";
    public new const string Type = "object";
    public new const string SubType = "entity";
    public new const string Name = "CopayAuth";
    // SourcePrimaryTable / IdColumn / … are the base's. A C# const is inherited, so
    // CopayAuthNames.SourcePrimaryTable and CopayAuthNames.IdColumn both resolve.
}
```

`new` on `Type`/`SubType`/`Name` because every artifact declares its own three and a derived
`const` hides the base's rather than clashing with it.

Two forms, and which one you get is structural. An object with its OWN source declares its
own `Source<Role>*` members; one that INHERITS its source — a TPH subtype sharing its base's
single table — declares none and takes them from the base. An abstract base a persisted
entity extends gets a class of its own carrying the columns it declares and **no source
members at all** — it has no table and must never acquire one. `ColumnsByField` stays
complete on every class, inherited entries included.

Column names come from the project's `naming` setting in `.metaobjects/config.json`
(ADR-0058), the one every port reads, default `snake_case` (what `meta migrate` creates). A
database whose columns are named exactly like the fields declares
`"naming": { "columns": "literal" }`; through 1.0 that was this port's default. `dotnet meta gen`
and `dotnet meta verify --codegen` both read the setting, so a plain run and the drift gate
resolve the identical column strings; `--column-naming` is refused
([physical-naming.md](../features/migrations/physical-naming.md)). `verify --codegen` says so
when the committed output was generated with another rule, rather than telling you to
regenerate. See the "Column naming" section of
[`features/field-types.md`](../features/field-types.md).

### Report export

A served report (a view-backed `object.report`) can be downloaded as a file:
`GET /api/<segment>?format=csv|json|xml`, the contract in
[api-contract.md](../features/api-contract.md#report-export). It is on when you list the
`report-export` generator beside `routes` in `codegen/Generators.cs`, and not otherwise: with it
unlisted, the generated routes are byte-identical to before.

```csharp
new ReportExportGenerator { MaxRows = 50_000, XmlNulls = ReportExportXmlNulls.Nil, CsvBom = false }
```

- **Wiring** is the generator list. `routes` asks the run (`GenContext.ReportExportMaxRows`) whether
  a `report-export` entry is listed, so an ejected copy (`dotnet meta eject report-export`) wires the
  routes exactly as the packaged one does. `dotnet meta gen --generators routes` alone leaves it off.
- **Writes** one shared `ReportExportWriter.g.cs` per project (CSV quoting, CRLF, the injection guard,
  the `ExportCsvBom` constant, `XmlWriter` output, wire-form conversion of a cell) and one
  `<Report>Export.g.cs` per served report (its columns in derived-field order). The generated code uses
  `TextWriter`, `XmlWriter` and `System.Text.Json` only and adds no package. The HTTP side (`?format=`,
  the three 400 envelopes, `Content-Disposition`) is `ReportExportHttp`, one of the helper-runtime files
  `dotnet meta eject routes` copies.
- **`MaxRows`** (default 100,000) is the export cap. With `?format` set it governs and
  `report_too_large` never answers; without it the list route's `ReportMaxRows` (10,000) is untouched.
- **`XmlNulls`** defaults to `Nil`: a null field is an empty element with `xsi:nil="true"` and the root
  declares `xmlns:xsi`. That is what `XmlSerializer` writes for a nullable value type and what
  `DataContractSerializer` writes for any null, and it keeps a null apart from an empty string. `Empty`
  writes a bare empty element and declares nothing.
- **JSON** is the list route's body (the array, or `{ rows, total }` with `withCount`) through the host's configured JSON options (so a `wire` setting and
  a `JsonStringEnumConverter` apply as on the list route), served as `application/json`.
- A character XML 1.0 cannot carry is written as U+FFFD rather than failing the export.

## Use

```csharp
// Program.cs
using System.Text.Json.Serialization;
using Acme.Blog;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(opts => opts.UseSqlite("Data Source=blog.db"));
// Enum fields (role) travel as their symbols ("writer"), not integers: the routes return the
// entity and the host owns serialization, so without this POST {"role":"writer"} is a 400.
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));

var app = builder.Build();
using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();  // the sample creates its own table

app.MapAuthorRoutes();   // generated — GET/POST/PATCH/PUT/DELETE on /api/authors
app.Run();
```

```bash
dotnet run --urls http://127.0.0.1:5077
curl -X POST -H 'content-type: application/json' -d '{"name":"Ada","role":"writer"}' http://127.0.0.1:5077/api/authors   # 201
curl -g 'http://127.0.0.1:5077/api/authors?filter[role][eq]=writer'                                                      # 200, the row
```

A filter works on a field marked `@filterable` (`name` and `role` above); any other field answers
400 `invalid_filter_field`.

**Postgres.** Swap `UseSqlite(...)` for `UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection"))`
and add `Npgsql.EntityFrameworkCore.PostgreSQL` instead of the SQLite package. `EnsureCreated`
is for samples; on Postgres create the tables with the Node CLI's migrations
(`meta migrate`, ADR-0015) — the C# port has no migrate surface.

EF Core does the rest — the generated entities and `AppDbContext` are plain EF Core with
no MetaObjects types in them. Note the one exception: generated **routes** emit
`using MetaObjects.Codegen.Runtime;` for the shared filter/sort helpers, so a project that
generates routes with the packaged generator references `MetaObjects.Codegen` at runtime.
Entities-and-DbContext-only projects do not.

**Owning the routes, helpers included.** `dotnet meta eject routes` copies the routes
generator into `codegen/generators/` AND the helper source its output calls into
`codegen/runtime/`: `FilterParser`, `FilterParseResult`, `FilterPredicate`,
`EfCoreFilterDispatch`, `ValueObjectValidator`, `ConstraintErrors` and
`Iso8601TimestampConverter`, each under the namespace `Codegen.Runtime`. The owned
generator's output imports `Codegen.Runtime` instead of the package. Compile the folder into
your app (`<Compile Include="../codegen/runtime/**/*.cs" />`) and the generated routes need
no `MetaObjects.Codegen` reference; a fix to the filter parser is then an edit in your repo,
not a wait for a release. What stays in the package is core: `ExtractObject` (the reply
parser the prompt tier calls) and `M2MResolver` (metadata-driven M:N traversal), plus the
loader, registry, render and verify. `dotnet meta gen --list` reports the copy `identical`
or per-file `DIFFERS`, `verify --codegen` does not treat it as drift, and
[Own your codegen → C#](../features/own-your-codegen.md#ejecting-routes-hands-over-the-helper-runtime-too)
has the diff recipe for pulling an upstream fix into it.

**Consumer dependencies.** The generated `AppDbContext` and the `Program.cs`
wiring above use EF Core (`AddDbContext`, `DbContext`, `UseSqlite`), which
MetaObjects does not pull in for you — add the EF Core provider package for your
database to the consuming app (`Microsoft.EntityFrameworkCore.Sqlite` above,
`Npgsql.EntityFrameworkCore.PostgreSQL` for Postgres).

```csharp
// Optional handwritten service over the generated DbContext
public class AuthorService(AppDbContext db)
{
    public Task<List<Author>> ListAsync() => db.Authors.ToListAsync();

    public async Task<long> CreateAsync(string name, string? bio = null)
    {
        var author = new Author { Name = name, Bio = bio };
        db.Authors.Add(author);
        await db.SaveChangesAsync();
        return author.Id;
    }
}
```

## FR-004 — render

```csharp
using MetaObjects.Render;

var provider = new FilesystemProvider("./prompts");
// The @payloadRef value object's own POCO, emitted by EntityGenerator (ADR-0056).
var payload = new WelcomePayload
{
    DisplayName = "Ada",
    PostCount = 12,
    Posts = new List<PostSummary> { new() { Title = "Hello" } },
};

string output = Renderer.Render(new RenderRequest {
    Ref = "lobby/welcome",
    Payload = payload,
    Provider = provider,
    Format = "xml",
});
```

`Verify` in `MetaObjects.Render` drift-checks every `template.*` against its
`@payloadRef`. Wire it into your CI step or invoke `dotnet meta verify` directly.
The renderer reads a POCO through its `[JsonPropertyName]` wire names, so `{{postCount}}`
resolves against the `PostCount` property and `{{#hasPosts}}` works.

## FR-006 — response parsing

`OutputParserGenerator` (in `MetaObjects.Codegen`) emits one
`<PromptName>.response.cs` file per responding `template.prompt` — one declaring
`@responseRef`. The static `<PromptName>Parser` class follows the BCL `Parse`/`TryParse`
dual-API convention — `Parse` throws on bad input, `TryParse` returns a bool plus an
out-error string.

ADR-0052: the shape parsed INTO is `@responseRef`, never `@payloadRef` (which types the
request the prompt renders outbound), and `template.output` gets no parser at all. The
parser returns the `@responseRef` value object's own POCO (`<Vo>.g.cs`, from
`EntityGenerator`; ADR-0056) — so wire `entity` in the same run. A `@required` member is
enforced by a generated `JsonTypeInfo` modifier rather than the C# `required` keyword,
because the REST tier shares the POCO. The strict tier is JSON-only: an
`@responseFormat: xml` reply gets the tolerant extract and nothing strict.

```csharp
// generated/NpcResponse.response.cs
public static class NpcResponseParser
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = false,
    };

    /// <exception cref="JsonException">malformed JSON or schema mismatch.</exception>
    public static NpcResponse Parse(string text) =>
        JsonSerializer.Deserialize<NpcResponse>(text, Options)
            ?? throw new JsonException("deserialized to null");

    public static bool TryParse(string text,
        [NotNullWhen(true)] out NpcResponse? value,
        [NotNullWhen(false)] out string? error) { ... }
}
```

The `[NotNullWhen]` attributes mean nullable-flow analysis lets you use `npc`
without a null-check after a `true` return, and `error` without one after `false`.

Consumer wiring:

```csharp
string llmResponse = await myLlmClient.CompleteAsync(promptText);

// Throwing path
var npc = NpcResponseParser.Parse(llmResponse);

// TryParse for explicit error handling
if (NpcResponseParser.TryParse(llmResponse, out var npc, out var error))
    return Ok(npc);
else
    return BadRequest(new { error });
```

`MetaObjects.Render`'s `Verify` walks both template subtypes, catching payload ↔
template drift at build time.
Cross-port design is at [ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md);
the feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#response-parsing-fr-006).

**Consumer dependency.** `System.Text.Json` ships in the .NET 8 BCL — no
NuGet package to add. The generated parser uses the strict (case-sensitive)
default options.

## Requirement tests

Declare what the software must do as `requirement.*` nodes and `dotnet meta verify` checks
them on every run; the `requirement-tests` generator then writes one xUnit test per tested
requirement. The generator is a reference helper and a recommended approach, not a
contract: `dotnet meta eject requirement-tests` copies it to
`codegen/generators/RequirementTestsGenerator.cs` for you to change. The checks in `verify`
are core and are not ejectable.

```bash
# The gate: runs on every verify, beside whichever drift gate it was given
dotnet meta verify ./metaobjects --codegen --out ./Generated
dotnet meta verify ./metaobjects --codegen --out ./Generated --require-implementers
# Recommended once the ledger is clean: use this form in the project's verify script or pre-push hook

# The tests: the same run as everything else codegen/Generators.cs declares. The entry's
# OutDir puts them in the test project, which references xunit; the app's --out does not.
dotnet meta gen ./metaobjects --out ./Generated
dotnet meta verify ./metaobjects --codegen --out ./Generated
```

Give the entry an `OutDir` in `codegen/Generators.cs` (below): the tests need xunit, which
the project compiling `--out` does not reference, so they go into the test project. `gen`
writes them there and `verify --codegen` compares them there, in the same run that writes
and checks your entities. Point `OutDir` at a directory that holds generated files only:
`verify --codegen` compares the whole tree.

Per metamodel package the generator writes `Requirements_<pkgKey>_Witnesses.g.cs`, an
interface with one default member per test that is not skipped, and
`Requirements_<pkgKey>_Tests.g.cs`, one `[Fact]` per requirement (`[Fact(Skip = "…")]` for
a `planned` or `retired` one). Both are in `<namespace>.Requirements` and are rewritten
whole on every run. The tests construct one class of yours, `<namespace>.RequirementWitnesses`
by default, which implements every generated interface. Until that class exists the test
project does not compile. Implement each member **explicitly**:

```csharp
using Acme.Shop.Requirements;
using Xunit;

namespace Acme.Shop;

public class RequirementWitnesses : Requirements_acme_shop_Witnesses
{
    void Requirements_acme_shop_Witnesses.req_acme_shop_Orders_Recorded__object_entity()
    {
        // fails when a placed order has no row
    }
}
```

A requirement that becomes `live` adds a member whose default fails the test
(`unimplemented requirement: <id> - write <WitnessClass>.<key>() so that it fails when:
<counterexample>`), with no compile break. One that is retired or deleted removes its
member, and an explicit implementation of it then stops compiling (CS0539). A
`public void req_…()` implements the member implicitly, and a stale one keeps compiling, so
it goes stale silently. If a test reports `unimplemented requirement` for a witness you
believe you wrote, the method is not implementing the member: in the implicit form it must
be `public`, non-static, parameterless and named exactly as the interface names it.

The seven options are init properties on the generator, set on its entry in
`codegen/Generators.cs`:

```csharp
// codegen/Generators.cs
using MetaObjects.Codegen;
using MetaObjects.Core.Requirement;   // RequirementTestGrain, IRequirementTestFilter

public static class Generators
{
    public static IReadOnlyList<IGenerator> All { get; } =
    [
        new MetaObjects.Codegen.Generators.RequirementTestsGenerator
        {
            OutDir = "tests/Acme.Shop.Tests/Generated",
            WitnessClass = "Acme.Shop.Tests.Witnesses",
            Grain = RequirementTestGrain.Member,
            WarnUncovered = false,
        },
    ];
}
```

After `dotnet meta eject requirement-tests` the entry names your owned copy instead,
`new Codegen.Generators.RequirementTestsGenerator { … }`. Write each entry fully
qualified, as above: an owned copy and the packaged class share a simple name, so adding
`using MetaObjects.Codegen.Generators;` beside `using Codegen.Generators;` makes each
`new <Name>Generator()` ambiguous (CS0104).

| Property | Meaning |
|---|---|
| `OutDir` | Where the tests are written, relative to the directory the run starts in. Default: the run's `--out`. Set it to the test project's directory. |
| `TestNamespace` | Namespace of the generated tests. Default `<namespace>.Requirements`. |
| `WitnessClass` | Full name of your witness class. Default `<namespace>.RequirementWitnesses`. |
| `Grain` | `RequirementTestGrain.Concern` (default): one test per distinct `<type>.<subType>` a requirement claims. `Member`: one per distinct `implementedBy` reference that resolves. |
| `Filter` | An `IRequirementTestFilter` (`bool Include(RequirementView view)`) that **replaces** the default of functional requirements at L4 and L5. The view carries `SubType`, `Level` (`int?`, null when not declared), `Status`, `Path`, `Package` and `ImplementedByTypes`. |
| `Renderer` | An `IRequirementTestRenderer` (in `MetaObjects.Codegen`); it returns a `RenderedTest` to replace the text of one test, or `null` to keep the default. |
| `WarnUncovered` | `true` (default): one warning naming up to five requirements the filter left out. |

The hook types, the identity function and the digest stay in the package when you eject;
the owned copy uses them from there. A package that loses its last requirement loses its
two files: `dotnet meta gen` deletes them through the hash manifest (an edited one is refused by
name), and until then `dotnet meta verify --codegen` reports each as
`committed but a fresh regen would not emit it`. The model and the
other ports' spelling are in
[Generated requirement tests and witnesses](../features/requirements.md#generated-requirement-tests-and-witnesses).

## Declarative template-codegen (`TemplateSpecGenerator`)

Beyond the built-in EF Core / routes suite, `dotnet meta gen` runs **declarative
Mustache template generators** from a JSON template-spec — the cross-port contract
shared with the Python port (see
[`docs/features/codegen-concepts.md`](../features/codegen-concepts.md#declarative-template-scopes)
and the neutral data dict in
[`docs/features/codegen-data-shapes.md`](../features/codegen-data-shapes.md)). The spec is
declared where every generator is, as an entry in `codegen/Generators.cs`:

```csharp
new MetaObjects.Codegen.TemplateCodegen.TemplateSpecGenerator
{
    Spec = "template-spec.json",   // from the directory gen runs in, as --out is
    TemplateRoot = "templates",    // optional; default the run's --template-root, else prompts/ when it exists, else templates/
},
```

```jsonc
// template-spec.json — the cross-port shape
{ "generators": [
    { "name": "entity-doc",
      "scope": "perEntity",            // perEntity | perPackage | perModel
      "outputPattern": "{package}/{Name}.md",
      "template": "entity-doc",          // resolved under TemplateRoot
      "format": "markdown" }            // optional; a registered escaper format
]}
```

`dotnet meta verify --codegen` regenerates the same entry, so the gate and the generator
agree. Through 1.0 the CLI also read `--template-spec` or a project-root `template-spec.json`
on its own; neither is read now, and a run that finds either with no `TemplateSpecGenerator`
entry fails before writing anything, with a line that starts
`dotnet meta gen: found 1.0 template-spec configuration (`. See
[the migration section](../features/migrations/docs-are-generators.md#c).

Each spec entry derives the neutral template data dict for its scope
(`MetaObjects.Codegen.TemplateCodegen.TemplateData`) and names each file via the
`outputPattern` placeholders (`{name}`, `{Name}`, `{package}`). The entry's files land under
`--out`, or under its own `OutDir` when it sets one, and are gated byte-identical against the
shared `fixtures/template-codegen-conformance/` corpus. A `target` field is rejected (C# has no
output-target concept); a missing spec file, a bad template ref or a wrong `TemplateRoot`
surfaces as a clean error, not a stack trace. The write path decides from the committed hash
manifest, not the `@generated` header, so the template need not emit one (see
[codegen-concepts](../features/codegen-concepts.md#7-safety-never-clobbering-hand-edits)).

## Angular 18 frontend

C# 12 / .NET 8 backends pair cleanly with an Angular 18 client built from
the universal `@metaobjectsdev/angular` runtime + `@metaobjectsdev/codegen-ts-angular`
codegen packages — which are **source-only today, not published to npm** (build
them from the TS workspace; see the
[recipe](../recipes/csharp-angular18.md)). The generated ASP.NET Minimal API routes (from
`MetaObjects.Codegen` `RoutesGenerator`) speak the same URL grammar
and wire format the Angular client expects — no special-casing.

End-to-end recipe — CORS wiring, dev-server port conventions, base-URL
configuration, the `dotnet meta gen` command sequence that emits both halves —
lives at [`docs/recipes/csharp-angular18.md`](../recipes/csharp-angular18.md).

Today's `RoutesGenerator` honours pagination (`?limit`/`?offset`), sort
(`?sort=<field>:asc|desc` against a static per-entity allowlist), and the
`?withCount=1` envelope (`{ rows, total }`) that the Angular grid hook
always sends. Filter operators (`eq` / `ne` / `gt` / `gte` / `lt` / `lte`
/ `in` / `like` / `isNull`) per [`api-contract.md`](../features/api-contract.md)
ship too — the generated `<Entity>FilterAllowlist` (`FilterAllowlistGenerator`)
feeds `FilterParser.Parse` + `EfCoreFilterDispatch.ApplyFilter`, both wired
directly into the generated list handler. A read-only projection
(`source.rdb @kind: view`) and a view-backed report get the same filter and sort
on their list route, against an allowlist of their own fields.

**Known gaps** (full list with workarounds in
[KNOWN_GAPS.md](https://github.com/metaobjectsdev/metaobjects/blob/main/server/csharp/MetaObjects.Codegen/Generators/KNOWN_GAPS.md)):
no `filter[or]` / `filter[and]` boolean grouping and a single sort key only (both outside the
cross-port contract today); the `<Entity>View` / `<Entity>Views` names are reserved for a
write-through entity's generated read model; an `EmitMappedClass` override does not reach that
read model; M:N traversal on a write-through entity is not routed through the replica view; the
ordered-comparison filter fallback in `EfCoreFilterDispatch` needs a hand-written typed
dispatcher for some column types; there is no metadata-driven runtime tier (EF Core output is
generated code), and no `migrate` surface (schema is TypeScript-owned).

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes (EF Core + Postgres FK clause) |
| Source kinds (table / view / storedProc) | `table` + `view` fully shipped; `storedProc` / `tableFunction` / `materializedView` partial |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes (incl. EF Core `OwnsOne` for `flattened`; `OwnsMany(...).ToJson(...)` for `@isArray` array-of-VO jsonb) |
| Templates + render (FR-004) | Yes (`MetaObjects.Render`; Mustache only — a Jinja body is refused with `ERR_TEMPLATE_ENGINE_UNSUPPORTED`, ADR-0061) |
| Output parser codegen (FR-006) | Yes (`OutputParserGenerator` — `Parse`/`TryParse` BCL pattern) |
| Payload-VO codegen | Yes — the payload IS the value object's own POCO from `EntityGenerator` (ADR-0056); no separate payload generator |
| Declarative template-codegen | Yes — a `TemplateSpecGenerator` entry in `codegen/Generators.cs` (scope perEntity/perPackage/perModel + outputPattern; the cross-port JSON contract shared with Python) |
| Migrations | Owned by the Node `meta` CLI (ADR-0015) — no C# migrate surface |
| Drift verify | `dotnet meta verify` (template drift, FR-004; `--codegen` regenerates the list in `codegen/Generators.cs` and diffs it) |
| API reference docs | Yes — the `ApiDocsGenerator` entry in `codegen/Generators.cs` (`OutDir`, `ApiSubDir`, `ProjectName`, `ModelBaseUrl`); `dotnet meta docs` was removed in 1.1.0 ([migration](../features/migrations/docs-are-generators.md#c)) |
| Requirement gate + requirement tests | Yes (`dotnet meta verify`, on every run; `requirement-tests` emits xUnit and is ejectable) |
| Runtime metadata | Loader API + render engine; ObjectManager-style runtime tier on the roadmap |

## Conformance status

Per-corpus pass counts move every release — see
[`docs/CONFORMANCE.md`](../CONFORMANCE.md) for the current, authoritative
per-port numbers (metamodel, YAML, render, verify, persistence, API
contract). C# is green across all six active corpora today.

## See also

- [`server/csharp/README.md`](../../server/csharp/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the C# output inline
- [`docs/superpowers/specs/2026-05-20-csharp-rdb-persistence-design.md`](../superpowers/specs/2026-05-20-csharp-rdb-persistence-design.md)
