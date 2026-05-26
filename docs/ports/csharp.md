# C# port

A first-class full-stack target on .NET 8. Loader + conformance + EF Core codegen
+ render engine + the `meta` CLI all ship. Targets EF Core + ASP.NET Core +
Postgres + Npgsql.

## Install

```xml
<!-- YourApp.csproj -->
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

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes (EF Core + Postgres FK clause) |
| Source kinds (table / view / storedProc) | `table` + `view` fully shipped; `storedProc` / `tableFunction` / `materializedView` partial |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes (incl. EF Core `OwnsOne` for `flattened`) |
| Templates + render (FR-004) | Yes (`MetaObjects.Render`) |
| Payload-VO codegen | Yes (`MetaObjects.Codegen`) |
| Migrations | `meta migrate` — full CREATE today; introspection-driven incremental landing |
| Drift verify | `meta verify` (template drift); DB-drift verify on the same incremental path |
| Runtime metadata | Loader API + render engine; ObjectManager-style runtime tier on the roadmap |

## Conformance status (as of 2026-05-25)

| Corpus | Result |
|---|---|
| Metamodel (`fixtures/conformance/`) | Largely caught up — known-gap list tracks the `source.rdb` paradigm cluster + `doc-common-attrs-on-all-types` |
| YAML authoring (`fixtures/yaml-conformance/`) | Yes |
| Render (`fixtures/render-conformance/`) | Yes — byte-identical to TS |
| Verify (`fixtures/verify-conformance/`) | Yes |
| Persistence (`fixtures/persistence-conformance/`) | Yes — 12 / 12 (runnable via `scripts/integration-test.sh csharp`) |

## See also

- [`server/csharp/README.md`](../../server/csharp/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the C# output inline
- [`docs/superpowers/specs/2026-05-20-csharp-rdb-persistence-design.md`](../superpowers/specs/2026-05-20-csharp-rdb-persistence-design.md)
