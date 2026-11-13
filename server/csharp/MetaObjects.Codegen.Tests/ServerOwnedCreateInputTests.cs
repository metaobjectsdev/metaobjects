// ServerOwnedCreateInputTests — a generated create hands storage ONLY what the client may set.
// The HTTP behaviour is gated by the api-contract corpus (`input-server-owned-dropped`,
// `tph-input-server-owned-dropped`, secret-fields); this pins the emission: the generated key,
// the TPH discriminator and the M:N navigations are reset before `Add`, and a readOnly field of
// EVERY shape (including a TPH subtype's own) is declared with a private setter.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ServerOwnedCreateInputTests
{
    private const string PlainModel = """
    { "metadata.root": { "package": "acme::input", "children": [
      { "object.entity": { "name": "Post", "children": [
        { "source.rdb":       { "@table": "posts" } },
        { "field.long":       { "name": "id" } },
        { "field.string":     { "name": "title", "@maxLength": 100 } },
        { "field.string":     { "name": "role", "@maxLength": 20, "@mutability": "readOnly" } },
        { "field.enum":       { "name": "stage", "@values": ["Draft", "Live"], "@mutability": "readOnly" } },
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb":       { "@table": "tags" } },
        { "field.long":       { "name": "id" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "PostTag", "children": [
        { "source.rdb":       { "@table": "post_tags" } },
        { "field.long":       { "name": "postId" } },
        { "field.long":       { "name": "tagId" } },
        { "identity.primary": { "@fields": ["postId", "tagId"] } },
        { "identity.reference": { "name": "fkPost", "@fields": "postId", "@references": "Post" } },
        { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
      ]}}
    ]}}
    """;

    private const string AssignedKeyModel = """
    { "metadata.root": { "package": "acme::input", "children": [
      { "object.entity": { "name": "Code", "children": [
        { "source.rdb":       { "@table": "codes" } },
        { "field.string":     { "name": "id", "@maxLength": 20 } },
        { "identity.primary": { "@fields": "id", "@generation": "assigned" } }
      ]}}
    ]}}
    """;

    private const string TphModel = """
    { "metadata.root": { "package": "acme::input", "children": [
      { "object.entity": { "name": "Thing", "@discriminator": "kind", "children": [
        { "source.rdb":       { "@table": "things" } },
        { "field.long":       { "name": "id" } },
        { "field.enum":       { "name": "kind", "@values": ["A", "B"] } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "AThing", "extends": "Thing", "@discriminatorValue": "A", "children": [
        { "field.string": { "name": "note", "@maxLength": 20 } },
        { "field.string": { "name": "grade", "@maxLength": 20, "@mutability": "readOnly" } }
      ]}},
      { "object.entity": { "name": "BThing", "extends": "Thing", "@discriminatorValue": "B", "children": [
        { "field.int": { "name": "qty" } }
      ]}}
    ]}}
    """;

    private const string RequiredReadOnlyModel = """
    { "metadata.root": { "package": "acme::input", "children": [
      { "object.entity": { "name": "Member", "children": [
        { "source.rdb":       { "@table": "members" } },
        { "field.long":       { "name": "id" } },
        { "field.string":     { "name": "title", "@required": true, "@maxLength": 100 } },
        { "field.string":     { "name": "role", "@required": true, "@maxLength": 20, "@mutability": "readOnly" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}}
    ]}}
    """;

    // A legal way to say "the server owns this": the generated increment key and the TPH
    // discriminator are themselves @mutability: readOnly. The entity then declares both with
    // PRIVATE setters (A_readOnly_field_of_every_shape_has_a_private_setter), so a create that
    // reset them (`input.Id = default!;`) would not compile in the adopter's build — CS0122.
    private const string ReadOnlyKeyAndDiscriminatorModel = """
    { "metadata.root": { "package": "acme::input", "children": [
      { "object.entity": { "name": "Seal", "@discriminator": "kind", "children": [
        { "source.rdb":       { "@table": "seals" } },
        { "field.long":       { "name": "id", "@mutability": "readOnly" } },
        { "field.enum":       { "name": "kind", "@values": ["A", "B"], "@mutability": "readOnly" } },
        { "field.string":     { "name": "label", "@maxLength": 40 } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "ASeal", "extends": "Seal", "@discriminatorValue": "A", "children": [
        { "field.int": { "name": "qty" } }
      ]}},
      { "object.entity": { "name": "BSeal", "extends": "Seal", "@discriminatorValue": "B", "children": [
        { "field.string": { "name": "note", "@maxLength": 40 } }
      ]}}
    ]}}
    """;

    private static string Emit(string model, string generator, string file)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "input.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
        };
        IGenerator g = generator == "routes" ? new RoutesGenerator() : new EntityGenerator();
        return g.Generate(ctx).Single(f => f.Path == file).Content;
    }

    [Fact]
    public void Create_resets_a_generated_key_and_empties_navigations_before_Add()
    {
        var src = Emit(PlainModel, "routes", "PostRoutes.g.cs");
        var post = src[src.IndexOf("app.MapPost(", StringComparison.Ordinal)..];
        var reset = post.IndexOf("input.Id = default!;", StringComparison.Ordinal);
        var tags = post.IndexOf("input.Tags = new System.Collections.Generic.List<Tag>();", StringComparison.Ordinal);
        var add = post.IndexOf("db.Posts.Add(input);", StringComparison.Ordinal);
        Assert.True(reset >= 0 && tags >= 0 && add > reset && add > tags, post);
    }

    [Fact]
    public void An_assigned_key_is_the_callers_and_is_not_reset()
    {
        var src = Emit(AssignedKeyModel, "routes", "CodeRoutes.g.cs");
        Assert.DoesNotContain("input.Id = default!;", src);
        Assert.DoesNotContain("Server-owned", src);
    }

    [Fact]
    public void A_readOnly_field_of_every_shape_has_a_private_setter()
    {
        var src = Emit(PlainModel, "entity", "Post.g.cs");
        Assert.Contains("Role { get; private set; }", src);
        Assert.Contains("Stage { get; private set; }", src);
        Assert.Contains("Title { get; set; }", src);
    }

    [Fact]
    public void A_tph_subtype_readOnly_field_has_a_private_setter()
    {
        var src = Emit(TphModel, "entity", "AThing.g.cs");
        Assert.Contains("Grade { get; private set; }", src);
        Assert.Contains("Note { get; set; }", src);
    }

    [Fact]
    public void A_required_readOnly_field_is_not_demanded_of_the_create_body()
    {
        // The client cannot set `role` (private setter), so the create must neither require its
        // key nor reject the body over its [Required]: otherwise the entity could not be created.
        var src = Emit(RequiredReadOnlyModel, "routes", "MemberRoutes.g.cs");
        var post = src[src.IndexOf("app.MapPost(", StringComparison.Ordinal)..];
        var req = post[post.IndexOf("foreach (var __req in", StringComparison.Ordinal)..];
        req = req[..req.IndexOf('\n')];
        Assert.Contains("\"title\"", req);
        Assert.DoesNotContain("\"role\"", req);
        Assert.Contains("System.Array.IndexOf(new[] { \"Role\" }, m) < 0", post);
        var syntaxErrors = CSharpSyntaxTree.ParseText(src).GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString()).ToList();
        Assert.True(syntaxErrors.Count == 0, string.Join("\n", syntaxErrors));
    }

    [Fact]
    public void Tph_subtype_create_resets_the_key_and_pins_the_discriminator_to_the_route_subtype()
    {
        var src = Emit(TphModel, "routes", "ThingRoutes.g.cs");
        var start = src.IndexOf("app.MapPost(prefix + \"/things/a\"", StringComparison.Ordinal);
        var end = src.IndexOf("app.MapPost(prefix + \"/things/b\"", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start, src);
        var a = src[start..end];
        Assert.Contains("input.Id = default!;", a);
        Assert.Contains("input.Kind = default!;", a);
        Assert.True(a.IndexOf("input.Kind = default!;", StringComparison.Ordinal) < a.IndexOf(".Add(input);", StringComparison.Ordinal), a);
    }

    [Fact]
    public void A_readOnly_key_and_readOnly_discriminator_get_no_reset_and_the_model_compiles()
    {
        // System.Text.Json never binds a private setter, so the resets would be redundant —
        // and CS0122. Oracle: the Roslyn compile of the generated tree (the adopter's build);
        // the wrong behavior rejected is `input.Id = default!;` / `input.Kind = default!;`
        // assigning private-setter properties.
        var r = new MetaDataLoader().Load([new InMemoryStringSource(ReadOnlyKeyAndDiscriminatorModel, id: "ro-key.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
        };
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .ToList();
        var routes = sources.Single(f => f.Path == "SealRoutes.g.cs").Content;
        var post = routes[routes.IndexOf("app.MapPost(", StringComparison.Ordinal)..];
        Assert.DoesNotContain("input.Id = default!;", post);
        Assert.DoesNotContain("input.Kind = default!;", post);

        var trees = sources
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path))
            .ToList();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        foreach (var p in tpa.Split(Path.PathSeparator)) if (p.Length > 0) paths.Add(p);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.ModelBuilder).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.PrimaryKeyAttribute).Assembly.Location);
        paths.Add(typeof(MetaObjects.Codegen.Runtime.FilterParser).Assembly.Location);
        var refs = paths.Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create(
            "ro_key_disc_compile_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()} @ {d.Location}")
            .ToList();
        Assert.True(errors.Count == 0,
            "readOnly key + readOnly discriminator model must compile:\n" + string.Join("\n", errors));
    }
}
