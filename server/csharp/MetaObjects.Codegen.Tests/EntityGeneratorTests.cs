using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EntityGeneratorTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":    { "name": "id" } },
        { "field.string":  { "name": "email", "@required": true, "@maxLength": 255 } },
        { "field.boolean": { "name": "subscribed" } },
        { "field.timestamp": { "name": "createdAt" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "gen.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Entity_class_has_table_key_columns_and_nullability()
    {
        var ctx = Ctx(Load());
        var file = Assert.Single(new EntityGenerator().Generate(ctx));
        Assert.Equal("Subscriber.g.cs", file.Path);
        var src = file.Content;

        Assert.Contains("namespace Acme.Generated;", src);
        Assert.Contains("[Table(\"subscribers\")]", src);
        Assert.Contains("public class Subscriber", src);
        // PK long, required -> non-nullable, [Key] + [Column]
        Assert.Contains("[Key]", src);
        Assert.Contains("[Column(\"id\")]", src);
        Assert.Contains("public long Id { get; set; }", src);
        // required string -> [Required(AllowEmptyStrings)] + [MaxLength] + [MinLength(1)] (FR-036 A1)
        // + non-nullable w/ default!
        Assert.Contains("[Column(\"email\")]", src);
        Assert.Contains("[MaxLength(255)]", src);
        Assert.Contains("public string Email { get; set; } = default!;", src);
        // optional value types -> nullable
        Assert.Contains("public bool? Subscribed { get; set; }", src);
        // ADR-0036 Wave 2 — default field.timestamp is an absolute instant → DateTimeOffset.
        Assert.Contains("public DateTimeOffset? CreatedAt { get; set; }", src);
    }

    [Fact]
    public void Generated_entity_compiles()
    {
        var ctx = Ctx(Load());
        var src = new EntityGenerator().Generate(ctx).Single().Content;

        var tree = CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("entitycompile_" + Guid.NewGuid().ToString("N"),
            [tree], refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated entity should compile, got: " + string.Join("; ", errors));
    }

    [Fact]
    public void DbContext_exposes_a_dbset_per_entity()
    {
        var ctx = Ctx(Load());
        var file = Assert.Single(new DbContextGenerator().Generate(ctx));
        Assert.Equal("AppDbContext.g.cs", file.Path);
        Assert.Contains("public class AppDbContext : DbContext", file.Content);
        Assert.Contains("public DbSet<Subscriber> Subscribers { get; set; } = default!;", file.Content);
    }

    [Fact]
    public void Routes_generator_emits_crud_endpoints()
    {
        var ctx = Ctx(Load());
        var file = Assert.Single(new RoutesGenerator().Generate(ctx));
        Assert.Equal("SubscriberRoutes.g.cs", file.Path);
        var src = file.Content;

        Assert.Contains("public static class SubscriberRoutes", src);
        Assert.Contains("public static IEndpointRouteBuilder MapSubscriberRoutes(this IEndpointRouteBuilder app, string prefix = \"/api\")", src);
        // GET list now takes HttpContext (for qs parsing: limit/offset/sort/withCount).
        Assert.Contains("app.MapGet(prefix + \"/subscribers\", async (HttpContext http, AppDbContext db) =>", src);
        Assert.Contains("app.MapGet(prefix + \"/subscribers/{id}\", async (long id, AppDbContext db) =>", src);
        Assert.Contains("db.Subscribers.FindAsync(id)", src);
        // FR-036 #4 — an entity with a @required field (Subscriber.email) gets the
        // presence-checking create handler: it reads the raw JSON body (HttpContext),
        // rejects a body missing/null-ing any @required key with 400 {error:"validation"}
        // BEFORE binding (a value-type default can't be seen as "missing" by [Required]),
        // then deserializes + DataAnnotations-validates.
        Assert.Contains("app.MapPost(prefix + \"/subscribers\", async (HttpContext http, AppDbContext db) =>", src);
        Assert.Contains("foreach (var __req in new[] { \"email\" })", src);
        Assert.Contains("if (!__present.Contains(__req)) return Results.BadRequest(new { error = \"validation\" });", src);
        Assert.Contains("var input = System.Text.Json.JsonSerializer.Deserialize<Subscriber>(__body.RootElement.GetRawText(), jsonOpts);", src);
        // PATCH + PUT share the same update handler (matches TS reference). It takes the raw
        // HttpContext (not a bound DTO) and PARTIAL-merges only the properties present in the
        // JSON body — a bound DTO would fill omitted fields with CLR defaults and clobber them.
        Assert.Contains("async System.Threading.Tasks.Task<IResult> UpdateSubscriber(long id, HttpContext http, AppDbContext db)", src);
        Assert.Contains("foreach (var prop in body.RootElement.EnumerateObject())", src);
        Assert.Contains("app.MapPatch(prefix + \"/subscribers/{id}\", UpdateSubscriber);", src);
        Assert.Contains("app.MapPut(prefix + \"/subscribers/{id}\", UpdateSubscriber);", src);
        Assert.Contains("app.MapDelete(prefix + \"/subscribers/{id}\", async (long id, AppDbContext db) =>", src);
    }

    [Fact]
    public void Routes_generator_list_handler_calls_FilterParser()
    {
        // FR-009: the generated list handler must parse filter[...] qs against
        // the per-entity allowlist + dispatch via EfCoreFilterDispatch. Both
        // are runtime helpers shipped under MetaObjects.Codegen.Runtime.
        var ctx = Ctx(Load());
        var src = Assert.Single(new RoutesGenerator().Generate(ctx)).Content;

        // Imports the runtime namespace.
        Assert.Contains("using MetaObjects.Codegen.Runtime;", src);
        // Parses filter against the per-entity allowlist.
        Assert.Contains("FilterParser.Parse(qs, SubscriberFilterAllowlist.Fields, SubscriberFilterAllowlist.OpsByField)", src);
        // 400 envelope on parse error.
        Assert.Contains("Results.BadRequest(new { error = filter.ErrorEnvelope })", src);
        // Dispatches predicates onto the IQueryable<T>.
        Assert.Contains("EfCoreFilterDispatch.ApplyFilter(q, filter.Predicates)", src);
        // The withCount query is also filtered so total reflects the filtered count.
        Assert.Contains("EfCoreFilterDispatch.ApplyFilter(db.Subscribers.AsNoTracking(), filter.Predicates)", src);
    }

    [Fact]
    public void FilterAllowlist_file_emitted_per_entity_with_expected_fields()
    {
        // FR-009: filter-allowlist-generator emits <Entity>FilterAllowlist.cs
        // listing the filterable fields + per-field operator set. The base
        // Subscriber model in this test doesn't mark any field @filterable,
        // so the file is emitted with empty collections (consumer + routes
        // can unconditionally reference them).
        var ctx = Ctx(Load());
        var file = Assert.Single(new FilterAllowlistGenerator().Generate(ctx));
        Assert.Equal("SubscriberFilterAllowlist.g.cs", file.Path);
        var src = file.Content;
        Assert.Contains("namespace Acme.Generated;", src);
        Assert.Contains("public static class SubscriberFilterAllowlist", src);
        Assert.Contains("public static readonly HashSet<string> Fields", src);
        Assert.Contains("public static readonly Dictionary<string, HashSet<string>> OpsByField", src);
    }

    [Fact]
    public void Routes_generator_emits_api_contract_qs_handling()
    {
        // Sort/limit/offset/withCount per docs/features/api-contract.md.
        var ctx = Ctx(Load());
        var src = Assert.Single(new RoutesGenerator().Generate(ctx)).Content;

        // Sort allowlist contains the entity's scalar fields (Pascal-cased).
        Assert.Contains("SortAllowlist", src);
        Assert.Contains("\"Id\",", src);
        Assert.Contains("\"Email\",", src);
        Assert.Contains("\"Subscribed\",", src);
        Assert.Contains("\"CreatedAt\",", src);

        // Pagination + sort dispatch.
        Assert.Contains("qs.TryGetValue(\"sort\"", src);
        Assert.Contains("qs.TryGetValue(\"limit\"", src);
        Assert.Contains("qs.TryGetValue(\"offset\"", src);

        // withCount envelope: { rows, total }.
        Assert.Contains("qs.TryGetValue(\"withCount\"", src);
        Assert.Contains("Results.Ok(new { rows, total })", src);

        // 404 error envelope.
        Assert.Contains("Results.NotFound(new { error = \"not_found\" })", src);

        // Invalid-sort error envelope (unknown sort field → 400). The cross-port
        // api-contract uses the `invalid_sort` code (verified end-to-end by the
        // SP-F generated-server lane against the corpus), not a generic "validation".
        Assert.Contains("Results.BadRequest(new { error = \"invalid_sort\" })", src);

        // Sort dispatch uses EF.Property (no runtime reflection).
        Assert.Contains("EF.Property<object>", src);
    }

    // -------------------------------------------------------------------------
    // Enum field codegen (Tasks 4.3–4.6)
    // -------------------------------------------------------------------------

    private const string EnumModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long":    { "name": "id" } },
        { "field.enum":    { "name": "status", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot LoadEnum()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(EnumModel, id: "enum.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext EnumCtx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Enum_field_emits_nested_enum_type_with_verbatim_members()
    {
        var ctx = EnumCtx(LoadEnum());
        var file = Assert.Single(new EntityGenerator().Generate(ctx));
        var src = file.Content;

        // Inline enum: type name is <Entity><FieldPascal> = OrderStatus
        Assert.Contains("public enum OrderStatus { DRAFT, PUBLISHED, ARCHIVED }", src);
        // Property typed by the nested enum
        Assert.Contains("public OrderStatus? Status { get; set; }", src);
        // Column mapping annotation
        Assert.Contains("[Column(\"status\")]", src);
    }

    [Fact]
    public void Enum_field_property_is_required_when_in_pk()
    {
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.enum": { "name": "kind", "@values": ["A", "B"] } },
            { "identity.primary": { "@fields": "kind" } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
        Assert.Empty(r.Errors);
        var ctx = EnumCtx(r.Root);
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        // PK enum field is non-nullable (no ?)
        Assert.Contains("public OrderKind Kind { get; set; }", src);
    }

    [Fact]
    public void Enum_abstract_extends_uses_super_name_as_enum_type_name()
    {
        // FR-019: a ROOT-level abstract field.enum is a SHARED enum — materialized ONCE
        // in a dedicated Enums.g.cs (namespace-level), and the entity REFERENCES it (no
        // nested redeclaration). The type name is the super's name ("Status").
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "abstract": true, "@values": ["DRAFT", "PUBLISHED"] } },
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "extends": "Status" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
        Assert.Empty(r.Errors);
        var ctx = EnumCtx(r.Root);
        var files = new EntityGenerator().Generate(ctx).ToList();

        // Shared enum materialized once in Enums.g.cs (type name is the super's "Status").
        var enums = Assert.Single(files, f => f.Path == "Enums.g.cs");
        Assert.Contains("public enum Status { DRAFT, PUBLISHED }", enums.Content);

        // The entity references the shared type — no nested redeclaration.
        var order = Assert.Single(files, f => f.Path == "Order.g.cs");
        Assert.DoesNotContain("public enum Status", order.Content);
        Assert.Contains("public Status? Status { get; set; }", order.Content);
    }

    [Fact]
    public void Generated_enum_entity_compiles()
    {
        var ctx = EnumCtx(LoadEnum());
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        var tree = CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("enumcompile_" + Guid.NewGuid().ToString("N"),
            [tree], refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated enum entity should compile, got: " + string.Join("; ", errors));
    }

    [Fact]
    public void DbContext_emits_has_conversion_for_enum_field()
    {
        var ctx = EnumCtx(LoadEnum());
        var file = Assert.Single(new DbContextGenerator().Generate(ctx));
        Assert.Contains(
            "modelBuilder.Entity<Order>().Property(x => x.Status).HasConversion<string>();",
            file.Content);
    }

    // (Postgres schema DDL — enum → TEXT column + CHECK constraint — is now owned
    // by the TypeScript toolchain; the C# port emits no DDL, so that assertion moved
    // TS-side. The EF Core enum→string conversion is still covered above.)

    [Fact]
    public void Two_fields_extending_same_abstract_enum_emit_declaration_exactly_once()
    {
        // FR-019: two fields both resolving to the ROOT-level abstract "OrderStatus" share
        // ONE materialized type in Enums.g.cs (the entity references it from both props, no
        // nested redeclaration). Regression guard against a duplicate-type (CS0102) emit.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "OrderStatus", "abstract": true, "@values": ["DRAFT", "PUBLISHED"] } },
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "currentStatus",  "extends": "OrderStatus" } },
            { "field.enum": { "name": "previousStatus", "extends": "OrderStatus" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
        Assert.Empty(r.Errors);
        var ctx = EnumCtx(r.Root);
        var files = new EntityGenerator().Generate(ctx).ToList();

        // Exactly one enum declaration across the whole emitted set (in the shared file).
        var occurrences = files.Sum(f =>
            System.Text.RegularExpressions.Regex.Matches(f.Content, @"public enum OrderStatus\b").Count);
        Assert.Equal(1, occurrences);
        Assert.Contains("public enum OrderStatus { DRAFT, PUBLISHED }",
            Assert.Single(files, f => f.Path == "Enums.g.cs").Content);

        // Both properties exist on the entity, typed by the shared enum (no nested decl).
        var order = Assert.Single(files, f => f.Path == "Order.g.cs");
        Assert.DoesNotContain("public enum OrderStatus", order.Content);
        Assert.Contains("public OrderStatus? CurrentStatus { get; set; }", order.Content);
        Assert.Contains("public OrderStatus? PreviousStatus { get; set; }", order.Content);

        // The whole set must compile cleanly (no CS0102 / unresolved type).
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))).ToList();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("enumdedup_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "deduped enum set should compile, got: " + string.Join("; ", errors));
    }

    [Fact]
    public void Runner_writes_generated_files_but_refuses_handwritten()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mo-gen-" + Guid.NewGuid().ToString("N"));
        try
        {
            var config = new GenConfig { OutDir = dir, Namespace = "Acme.Generated" };
            var r1 = CodegenRunner.Run(config, Load(), [new EntityGenerator()]);
            Assert.Contains(r1.Files, f => f.Path == "Subscriber.g.cs" && f.Status == "written");
            Assert.True(File.Exists(Path.Combine(dir, "Subscriber.g.cs")));

            // Re-run overwrites the @generated file.
            var r2 = CodegenRunner.Run(config, Load(), [new EntityGenerator()]);
            Assert.Contains(r2.Files, f => f.Path == "Subscriber.g.cs" && f.Status == "written");

            // A hand-written file (no marker) is refused.
            File.WriteAllText(Path.Combine(dir, "Subscriber.g.cs"), "// my hand-written file\n");
            var r3 = CodegenRunner.Run(config, Load(), [new EntityGenerator()]);
            Assert.Contains(r3.Files, f => f.Path == "Subscriber.g.cs" && f.Status == "skipped-handwritten");
            Assert.Equal("// my hand-written file\n", File.ReadAllText(Path.Combine(dir, "Subscriber.g.cs")));
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
