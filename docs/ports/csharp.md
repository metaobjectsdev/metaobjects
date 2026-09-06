# C# port

A first-class full-stack target on .NET 8. Loader + conformance + EF Core codegen
+ render engine + the `meta` CLI all ship. Targets EF Core + ASP.NET Core +
Postgres + Npgsql.

## Install

Published to [NuGet](https://www.nuget.org/packages/MetaObjects) at `0.25.0` — four
packages, version-locked to the C# port version:

```xml
<!-- YourApp.csproj -->
<ItemGroup>
  <PackageReference Include="MetaObjects"          Version="0.25.0" />
  <PackageReference Include="MetaObjects.Codegen"  Version="0.25.0" />
  <PackageReference Include="MetaObjects.Render"   Version="0.25.0" />
</ItemGroup>
```

Install the CLI as a .NET tool:

```bash
dotnet tool install --global MetaObjects.Cli
dotnet meta          # bare invocation prints the usage banner
```

The C# CLI is invoked as `dotnet meta` (command `dotnet-meta`), or run directly
from the repo via `dotnet run --project server/csharp/MetaObjects.Cli`. It is
deliberately **not** a bare `meta` executable — that name belongs to the
canonical Node `meta` CLI, which owns schema + TS codegen (ADR-0015).

## Configure

Drop metadata under `metadata/`:

```jsonc
// metadata/meta.blog.json
{ "metadata.root": {
    "package": "acme::blog",
    "children": [
      { "object.entity": {
        "name": "Author",
        "children": [
          { "source.rdb": { "@table": "authors" } },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
          { "field.string": { "name": "bio", "@maxLength": 2000 } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ]
      }}
    ]
}}
```

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

var loader = MetaDataLoader.FromDirectory("./metadata", registry);
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

```bash
# Generate EF Core entities + AppDbContext + CRUD minimal-API routes
dotnet meta gen ./metadata --out ./Generated --namespace Acme.Blog

# Drift-check templates against payloads (FR-004)
dotnet meta verify ./metadata --templates ./prompts
```

Schema migrations are owned by the Node `meta` CLI (ADR-0015) — the C# CLI is
`gen` + `verify` only.

`gen` also accepts `--template-spec <json>` (+ `--template-root <dir>`, default
`templates`) — the declarative Mustache template-codegen surface; see
[Declarative template-codegen](#declarative-template-codegen---template-spec) below.

The codegen emits:

- `Author.g.cs` — class per entity (a mutable attributed POCO, not a record).
- `AppDbContext.g.cs` — `DbSet<Author>`, projection `.ToView()`, `@storage` owned
  types via `OwnsOne` (single) / `OwnsMany(...).ToJson(...)` (`@isArray` array-of-VO),
  enum-as-string via `HasConversion<string>()`.
- `AuthorRoutes.g.cs` — CRUD minimal-API endpoints.
- `AuthorFilterAllowlist.g.cs` — the server-side filter/sort allowlist feeding the
  generated list handler.

### `<Entity>Names` — the physical names, as constants

`names` ships in the **default generator suite** — a new project gets
`<Entity>Names.g.cs` without configuring anything. It carries the physical
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

The default column-naming strategy is `literal` here (unlike TypeScript's
`snake_case`) — see the "Column naming" section of
[`features/field-types.md`](../features/field-types.md) for why the defaults
disagree across ports and what to do about it. Both `dotnet meta gen` and
`dotnet meta verify` take the same `--column-naming` flag, so a
`verify --codegen` regen resolves the identical column strings `gen` did.

## Use

```csharp
// Program.cs
using Acme.Blog;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(opts =>
    opts.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

var app = builder.Build();

app.MapAuthorRoutes();   // generated — GET/POST/PUT/DELETE on /api/authors
app.Run();
```

EF Core does the rest — the generated entities and `AppDbContext` are plain EF Core with
no MetaObjects types in them. Note the one exception: generated **routes** emit
`using MetaObjects.Codegen.Runtime;` for the shared filter/sort helpers, so a project that
generates routes references `MetaObjects.Codegen` at runtime. Entities-and-DbContext-only
projects do not.

**Consumer dependencies.** The generated `AppDbContext` and the `Program.cs`
wiring above use EF Core (`AddDbContext`, `DbContext`, `UseNpgsql`), which
MetaObjects does not pull in for you — add the two EF Core NuGet packages to
the consuming app: `Microsoft.EntityFrameworkCore` and
`Npgsql.EntityFrameworkCore.PostgreSQL`.

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
var payload = new WelcomePayload(
    DisplayName: "Ada",
    PostCount: 12,
    Posts: new[] { new PostSummary("Hello") });

string output = Renderer.Render(new RenderRequest {
    Ref = "lobby/welcome",
    Payload = payload,
    Provider = provider,
    Format = "xml",
});
```

`Verify` in `MetaObjects.Render` drift-checks every `template.*` against its
`@payloadRef`. Wire it into your CI step or invoke `dotnet meta verify` directly.

## FR-006 — response parsing

`OutputParserGenerator` (in `MetaObjects.Codegen`) emits one
`<PromptName>.response.cs` file per responding `template.prompt` — one declaring
`@responseRef`. The static `<PromptName>Parser` class follows the BCL `Parse`/`TryParse`
dual-API convention — `Parse` throws on bad input, `TryParse` returns a bool plus an
out-error string.

ADR-0052: the shape parsed INTO is `@responseRef`, never `@payloadRef` (which types the
request the prompt renders outbound), and `template.output` gets no parser at all. This
port's records are VALUE-OBJECT-named, so the response record simply IS the VO's record —
no second naming convention. The strict tier is JSON-only: an `@responseFormat: xml`
reply gets the tolerant extract and nothing strict.

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

## Declarative template-codegen (`--template-spec`)

Beyond the built-in EF Core / routes suite, `dotnet meta gen` runs **declarative
Mustache template generators** from a JSON template-spec — the cross-port contract
shared with the Python port (see
[`docs/features/codegen-concepts.md`](../features/codegen-concepts.md#declarative-template-scopes)
and the neutral data dict in
[`docs/features/codegen-data-shapes.md`](../features/codegen-data-shapes.md)):

```bash
dotnet meta gen ./metadata --out ./Generated \
  --template-spec ./template-spec.json --template-root ./templates
```

```jsonc
// template-spec.json — the cross-port shape
{ "generators": [
    { "name": "entity-doc",
      "scope": "perEntity",            // perEntity | perPackage | perModel
      "outputPattern": "{package}/{Name}.md",
      "template": "entity-doc",          // resolved under --template-root
      "format": "markdown" }            // optional; a registered escaper format
]}
```

**The spec is auto-discovered.** Omit `--template-spec` and the CLI reads
`<projectRoot>/template-spec.json`, where projectRoot is the metadata dir's **parent** —
the same anchor `.metaobjects/` uses (`GenCommand.ProjectRootFor`). The flag overrides it.

Prefer the conventional path over the flag, because **`dotnet meta verify --codegen`
accepts no `--template-spec`**: discovery is how the drift gate learns your template
generators exist. A spec reachable only by flag leaves `verify` regenerating a different
generator list from `gen` and convicting your committed template output as
"committed but a fresh regen would not emit it".

```bash
dotnet meta gen ./metadata --out ./Generated --template-root ./templates
dotnet meta verify --codegen ./metadata --out ./Generated --template-root ./templates
#   ^ both resolve <projectRoot>/template-spec.json — the gate agrees with the generator
```

Each spec entry derives the neutral template data dict for its scope
(`MetaObjects.Codegen.TemplateCodegen.TemplateData`) and names each file via the
`outputPattern` placeholders (`{name}`, `{Name}`, `{package}`). The named generators
are **appended** to the default suite and gated byte-identical against the shared
`fixtures/template-codegen-conformance/` corpus. A `target` field is rejected (C# has
no output-target concept); a bad template ref or wrong `--template-root` surfaces as a
clean error, not a stack trace. For output to be regenerable, the **template** must emit
the `@generated` header itself (the write path refuses to overwrite files lacking it).

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
directly into the generated list handler. The one real gap: read-only
projections (`source.rdb @kind: view/...`) don't get filter routes today — see
[`server/csharp/MetaObjects.Codegen/Generators/KNOWN_GAPS.md`](../../server/csharp/MetaObjects.Codegen/Generators/KNOWN_GAPS.md).

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes (EF Core + Postgres FK clause) |
| Source kinds (table / view / storedProc) | `table` + `view` fully shipped; `storedProc` / `tableFunction` / `materializedView` partial |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes (incl. EF Core `OwnsOne` for `flattened`; `OwnsMany(...).ToJson(...)` for `@isArray` array-of-VO jsonb) |
| Templates + render (FR-004) | Yes (`MetaObjects.Render`) |
| Output parser codegen (FR-006) | Yes (`OutputParserGenerator` — `Parse`/`TryParse` BCL pattern) |
| Payload-VO codegen | Yes (`MetaObjects.Codegen`) |
| Declarative template-codegen | Yes — `dotnet meta gen --template-spec` (scope perEntity/perPackage/perModel + outputPattern; the cross-port JSON contract shared with Python) |
| Migrations | Owned by the Node `meta` CLI (ADR-0015) — no C# migrate surface |
| Drift verify | `dotnet meta verify` (template drift, FR-004) |
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
