# C# server runtime

The C# runtime tier **is the generated EF Core stack itself** — there is no separate
`ObjectManager` engine to wire. `EntityGenerator` + `DbContextGenerator` emit
`<Entity>.g.cs` classes plus one `AppDbContext.g.cs` that ARE the persistence layer (EF
Core), and `RoutesGenerator` emits ASP.NET minimal-API routes that mount on your
`WebApplication`. Unlike the other ports, C# leaves **no repository seam** — the generated
code is what runs. Schema is TS-owned (ADR-0015); EF Core is pure data-access at runtime.

## The generated persistence layer

`dotnet meta gen` emits an entity POCO per `object.entity` / projection and a single
`AppDbContext` with a `DbSet<T>` per entity (naively pluralized) plus an `OnModelCreating`
that carries the mapping:

```csharp
// generated AppDbContext.g.cs
public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Author> Authors { get; set; } = default!;

    protected override void OnModelCreating(ModelBuilder b)
    {
        // .HasConversion<string>() (enums), .OwnsOne(...).ToJson(...) / .OwnsMany(...).ToJson(...)
        // (jsonb object fields), .HasPrecision(p,s) (decimals), .ToView("v_...") (projections),
        // .HasDiscriminator(...).HasValue<Sub>(...) (TPH single-table).
    }
}
```

## Query + persist with EF Core

Register the generated context against your provider, then query/write with plain LINQ +
`SaveChangesAsync` — the generated entities and `AppDbContext` are ordinary EF Core:

```csharp
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(connString));
// ...
var authors = await db.Authors.AsNoTracking()
    .Where(a => a.Name == "Ada").ToListAsync();

db.Authors.Add(new Author { Name = "Ada" });
await db.SaveChangesAsync();   // server-generated PK round-trips back onto the entity
```

## Return-type contract

The EF Core query path materializes **native in-process CLR types**, never wire strings
(ADR-0019), verified by the port's runtime-return-type test:

- `field.decimal` → `decimal` — exact, **lossless end-to-end**, no float round-tripping.
- `field.long` → `long`; other scalars to their native CLR types.
- a default `field.timestamp` (instant) → `DateTimeOffset` over a `timestamptz` column; a
  naive `@localTime:true` timestamp → `DateTime` — native temporals, not strings.
- an untyped `@dbColumnType:jsonb` open-JSON column → a `System.Text.Json.JsonDocument` (the
  parsed value, not raw text); a **typed** `field.object @storage:jsonb` (with `@objectRef`)
  materializes the generated value-object class via `OwnsOne`/`OwnsMany(...).ToJson(...)`.

Wire canonicalization (currency → integer minor units, temporals → ISO-8601, UUID →
canonical hex) happens only when a row leaves over HTTP — at the serialization boundary in
the generated routes — never inside the EF Core query path. Currency is integer minor units
on the wire and in storage (a native `long` in-process); the server never formats —
formatting is client-side in the universal (TS/Angular) web client.

## Serving the REST contract

`RoutesGenerator` emits `<Entity>Routes.g.cs` — full CRUD per writable entity
(`source.rdb @kind="table"`), read-only list/get for a projection/view, and a collection-GET
for a composite-/no-PK entity — with a `Map<Entity>Routes(this IEndpointRouteBuilder,
string prefix = "/api")` extension, on the
cross-port REST contract (five CRUD endpoints, `?filter[field][op]=`, `?sort=field:asc`,
`?limit`/`?offset`, `?withCount=1` envelope, 400/404 envelopes). A TPH `@discriminator`
base emits polymorphic `GET /<base>(+/{id})` plus a per-subtype CRUD set at
`/<base>/<discriminatorValue lowercased>` (create injects the discriminator, cross-subtype
get/update/delete → 404). Wire it after registering the context:

```csharp
var app = builder.Build();
app.MapAuthorRoutes("/api");   // the generated extension; you pass the prefix at mount time (default "/api")
app.Run();
```

Filter operators (`eq` `ne` `gt` `gte` `lt` `lte` `in` `like` `isNull`) ship via the
per-entity `<Entity>FilterAllowlist` (from `FilterAllowlistGenerator`); the generated list
handler calls the `FilterParser` / `EfCoreFilterDispatch` runtime helpers in
`MetaObjects.Codegen`, so your ASP.NET host references that assembly at runtime. The same
universal TS/Angular web client consumes those routes unchanged — the wire format matches
the Java, Kotlin, and Python backends byte-for-byte.

## Physical names below LINQ

Inside LINQ keep the property (`db.Authors.Where(a => a.Name == …)`): it is type-checked
against the model, and a string constant there trades a compile error for a runtime one.
Where LINQ does not reach — raw SQL, a migration script, a log line — take the physical
name from the generated `<Entity>Names.g.cs`. `names` is in the default suite, and the
generated entity and `AppDbContext` already read it, so it cannot disagree with the
mapping: `AuthorNames.Name` is the table, `AuthorNames.<Field>Column` the column,
`AuthorNames.ColumnsByField` the whole map. Never a literal — and never
`nameof(Author.Name)`, which is the CLR property, not the column.
