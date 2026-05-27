# C# port

A first-class full-stack target on .NET 8. Loader + conformance + EF Core codegen
+ render engine + the `meta` CLI all ship. Targets EF Core + ASP.NET Core +
Postgres + Npgsql.

## Install

> **Note — not yet published to NuGet.** Consume from source via a project reference, OR adopt the in-repo build (`dotnet build server/csharp/`) and link to the produced DLLs. NuGet coordinates land once the C# port is ready for release:

```xml
<!-- YourApp.csproj — planned coordinates once published -->
<ItemGroup>
  <PackageReference Include="MetaObjects"          Version="0.7.0-rc.1" />
  <PackageReference Include="MetaObjects.Codegen"  Version="0.7.0-rc.1" />
  <PackageReference Include="MetaObjects.Render"   Version="0.7.0-rc.1" />
</ItemGroup>
```

The `meta` CLI ships as a .NET tool (`dotnet tool install --global
MetaObjects.Cli`) or run directly from the repo via `dotnet run --project
server/csharp/MetaObjects.Cli`.

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
using MetaObjects.Metadata;
using MetaObjects.Loader;

var registry = Provider.ComposeRegistry(new IMetaDataTypeProvider[] {
    CoreTypesProvider.Instance,
    ForgeTypesProvider.Instance,
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
meta gen ./metadata --out ./Generated --namespace Acme.Blog

# Emit Postgres DDL — full CREATE on first run
meta migrate ./metadata --out ./Migrations/001_init.sql

# Incremental — diff metadata vs live DB
meta migrate ./metadata --out ./Migrations/002.sql \
  --from-db "Host=localhost;Database=blog;Username=postgres" \
  --down   ./Migrations/002_down.sql

# Drift-check templates against payloads (FR-004)
meta verify ./metadata --templates ./prompts
```

The codegen emits:

- `Author.cs` — record per entity.
- `AppDbContext.cs` — `DbSet<Author>`, projection `.ToView()`, `@storage` owned
  types via `OwnsOne`, enum-as-string via `HasConversion<string>()`.
- `Author.routes.cs` — CRUD minimal-API endpoints.

`meta migrate` emits Postgres `CREATE TABLE` with PK / NOT NULL / UNIQUE / FK +
`@storage` columns; `CREATE VIEW` for projection entities (incl. aggregate /
passthrough-`@via` / collection origins).

## Use

```csharp
// Program.cs
using Acme.Blog;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(opts =>
    opts.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

var app = builder.Build();

app.MapAuthorRoutes();   // generated — GET/POST/PUT/DELETE on /api/author
app.Run();
```

EF Core does the rest. The runtime has no MetaObjects dependency.

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

string output = Renderer.Render(new RenderRequest(
    Ref: "lobby/welcome",
    Payload: payload,
    Provider: provider,
    Format: "xml"));
```

`Verify` in `MetaObjects.Render` drift-checks every `template.*` against its
`@payloadRef`. Wire it into your CI step or invoke `meta verify` directly.

## FR-006 — output parsing

`OutputParserGenerator` (in `MetaObjects.Codegen`) emits one
`<TemplateName>.output.cs` file per `template.output` declaration. The static
`<TemplateName>Parser` class follows the BCL `Parse`/`TryParse` dual-API
convention — `Parse` throws on bad input, `TryParse` returns a bool plus an
out-error string.

```csharp
// generated/NpcResponse.output.cs
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

`MetaObjects.Render`'s `Verify` walks `template.output` nodes the same way
it walks `template.prompt`, catching payload-VO ↔ parser drift at build time.
Cross-port design is at [ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md);
the feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#output-parsing-fr-006).

## Angular 18 frontend

C# 12 / .NET 8 backends pair cleanly with an Angular 18 client built from
the universal `@metaobjectsdev/angular` runtime + `@metaobjectsdev/codegen-ts-angular`
codegen packages. The generated ASP.NET Minimal API routes (from
`MetaObjects.Codegen` `RoutesGenerator`) speak the same URL grammar
and wire format the Angular client expects — no special-casing.

End-to-end recipe — CORS wiring, dev-server port conventions, base-URL
configuration, the meta gen command sequence that emits both halves —
lives at [`docs/recipes/csharp-angular18.md`](../recipes/csharp-angular18.md).

Today's `RoutesGenerator` honours pagination (`?limit`/`?offset`), sort
(`?sort=<field>:asc|desc` against a static per-entity allowlist), and the
`?withCount=1` envelope (`{ rows, total }`) that the Angular grid hook
always sends. Filter operators (`eq` / `ne` / `gt` / `gte` / `lt` / `lte`
/ `in` / `like` / `isNull`) per [`api-contract.md`](../features/api-contract.md)
are not yet generated — see
[`server/csharp/MetaObjects.Codegen/Generators/KNOWN_GAPS.md`](../../server/csharp/MetaObjects.Codegen/Generators/KNOWN_GAPS.md).

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes (EF Core + Postgres FK clause) |
| Source kinds (table / view / storedProc) | `table` + `view` fully shipped; `storedProc` / `tableFunction` / `materializedView` partial |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes (incl. EF Core `OwnsOne` for `flattened`) |
| Templates + render (FR-004) | Yes (`MetaObjects.Render`) |
| Output parser codegen (FR-006) | Yes (`OutputParserGenerator` — `Parse`/`TryParse` BCL pattern) |
| Payload-VO codegen | Yes (`MetaObjects.Codegen`) |
| Migrations | `meta migrate` — full CREATE today; introspection-driven incremental landing |
| Drift verify | `meta verify` (template drift); DB-drift verify on the same incremental path |
| Runtime metadata | Loader API + render engine; ObjectManager-style runtime tier on the roadmap |

## Conformance status (as of 2026-05-27)

| Corpus | Result |
|---|---|
| Metamodel (`fixtures/conformance/`) | 91 / 91 |
| YAML authoring (`fixtures/yaml-conformance/`) | 12 / 13 (1 ledgered — `error-yaml-coerced-hex-in-string`, YamlDotNet doesn't coerce `0xFF`) |
| Render (`fixtures/render-conformance/`) | 14 / 14 — byte-identical to TS |
| Verify (`fixtures/verify-conformance/`) | 31 / 31 |
| Persistence (`fixtures/persistence-conformance/`) | 12 / 12 (runnable via `scripts/integration-test.sh csharp`) |
| API contract (`fixtures/api-contract-conformance/`) | 20 / 20 |

## See also

- [`server/csharp/README.md`](../../server/csharp/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the C# output inline
- [`docs/superpowers/specs/2026-05-20-csharp-rdb-persistence-design.md`](../superpowers/specs/2026-05-20-csharp-rdb-persistence-design.md)
