// M2MCodegenTests — FR-018 Unit 11: C# M:N codegen emission.
//
// Asserts the three emitted artifacts for a many-to-many relationship:
//   1. EntityGenerator: a navigation collection (ICollection<Target>) on the source.
//   2. DbContextGenerator: HasMany().WithMany().UsingEntity<Through>(...) wiring.
//   3. RoutesGenerator: GET /<source-plural>/{id}/<relationName> junction traversal.
//
// Covers all three resolution modes (hetero / directed self-join / symmetric).
// The cross-port REST contract (source URL = pluralized ENTITY name, relation
// segment = relationship name) is the behavioral gate exercised over HTTP in the
// api-contract-conformance m2m corpus; this test gates the EMISSION shape.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class M2MCodegenTests
{
    // The m2m model: Post -tags-> Tag via PostTag (hetero); Person -following->
    // Person via Follow (directed self-join, @sourceRefField); Person -friends->
    // Person via Friendship (@symmetric). Mirrors the api-contract m2m corpus.
    private const string Model = """
    { "metadata.root": { "package": "acme::social", "children": [
      { "object.entity": { "name": "Post", "children": [
        { "source.rdb": { "@table": "posts" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "title" } },
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "PostTag", "children": [
        { "source.rdb": { "@table": "post_tags" } },
        { "field.long": { "name": "postId" } },
        { "field.long": { "name": "tagId" } },
        { "identity.primary": { "@fields": ["postId", "tagId"] } },
        { "identity.reference": { "name": "fkPost", "@fields": "postId", "@references": "Post" } },
        { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
      ]}},
      { "object.entity": { "name": "Person", "children": [
        { "source.rdb": { "@table": "people" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name" } },
        { "relationship.association": { "name": "following", "@cardinality": "many", "@objectRef": "Person", "@through": "Follow", "@sourceRefField": "followerId" } },
        { "relationship.association": { "name": "friends",   "@cardinality": "many", "@objectRef": "Person", "@through": "Friendship", "@symmetric": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Follow", "children": [
        { "source.rdb": { "@table": "follows" } },
        { "field.long": { "name": "followerId" } },
        { "field.long": { "name": "followeeId" } },
        { "identity.primary": { "@fields": ["followerId", "followeeId"] } },
        { "identity.reference": { "name": "fkFollower", "@fields": "followerId", "@references": "Person" } },
        { "identity.reference": { "name": "fkFollowee", "@fields": "followeeId", "@references": "Person" } }
      ]}},
      { "object.entity": { "name": "Friendship", "children": [
        { "source.rdb": { "@table": "friendships" } },
        { "field.long": { "name": "personAId" } },
        { "field.long": { "name": "personBId" } },
        { "identity.primary": { "@fields": ["personAId", "personBId"] } },
        { "identity.reference": { "name": "fkPersonA", "@fields": "personAId", "@references": "Person" } },
        { "identity.reference": { "name": "fkPersonB", "@fields": "personBId", "@references": "Person" } }
      ]}}
    ]}}
    """;

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
    };

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "m2m.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static string FileContent(IEnumerable<EmittedFile> files, string path) =>
        files.Single(f => f.Path == path).Content;

    [Fact]
    public void Descriptor_derives_all_three_modes()
    {
        var root = Load();
        var post = root.FindObject("Post")!;
        var person = root.FindObject("Person")!;

        var hetero = Assert.Single(M2MNavigationBuilder.For(post, root));
        Assert.Equal("tags", hetero.Name);
        Assert.Equal("Tag", hetero.Target.Name);
        Assert.Equal("PostTag", hetero.Junction.Name);
        Assert.Equal("postId", hetero.SourceField);
        Assert.Equal("tagId", hetero.TargetField);
        Assert.False(hetero.Symmetric);

        var personNavs = M2MNavigationBuilder.For(person, root);
        Assert.Equal(2, personNavs.Count);

        var following = personNavs.Single(n => n.Name == "following");
        Assert.Equal("followerId", following.SourceField);   // @sourceRefField
        Assert.Equal("followeeId", following.TargetField);
        Assert.False(following.Symmetric);
        Assert.True(following.IsSelfJoin);

        var friends = personNavs.Single(n => n.Name == "friends");
        Assert.True(friends.Symmetric);
        Assert.Equal("personAId", friends.SourceField);
        Assert.Equal("personBId", friends.TargetField);
    }

    [Fact]
    public void Entity_emits_navigation_collection()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var post = FileContent(files, "Post.g.cs");
        // Hetero nav: ICollection<Tag> Tags. Not EF-mapped scalar — a nav collection.
        Assert.Contains("public ICollection<Tag> Tags { get; set; }", post);

        var person = FileContent(files, "Person.g.cs");
        // Self-join navs use the relationship name (Following / Friends), targeting Person.
        Assert.Contains("public ICollection<Person> Following { get; set; }", person);
        Assert.Contains("public ICollection<Person> Friends { get; set; }", person);
    }

    [Fact]
    public void DbContext_emits_using_entity_for_hetero()
    {
        var ctx = Ctx(Load());
        var db = FileContent(new DbContextGenerator().Generate(ctx), "AppDbContext.g.cs");
        // Hetero: HasMany(Tags).WithMany().UsingEntity<PostTag>(...) with explicit FK config.
        Assert.Contains("Entity<Post>()", db);
        Assert.Contains("HasMany(x => x.Tags)", db);
        Assert.Contains("UsingEntity<PostTag>", db);
    }

    [Fact]
    public void Routes_emit_m2m_traversal_endpoint()
    {
        var ctx = Ctx(Load());
        var routes = FileContent(new RoutesGenerator().Generate(ctx), "PostRoutes.g.cs");
        // GET /<source-plural>/{id}/<relationName> — pluralized ENTITY name (posts), relation = tags.
        Assert.Contains("prefix + \"/posts/{id}/tags\"", routes);

        var personRoutes = FileContent(new RoutesGenerator().Generate(ctx), "PersonRoutes.g.cs");
        // Person pluralizes to "persons" per the cross-port grammar.
        Assert.Contains("prefix + \"/persons/{id}/following\"", personRoutes);
        Assert.Contains("prefix + \"/persons/{id}/friends\"", personRoutes);
    }

    [Fact]
    public void Entity_plus_dbcontext_compile_against_ef_core_8()
    {
        // The UsingEntity<Through> wiring + the [NotMapped] self-join navs must form a
        // compilable EF model. Roslyn-compile the entity POCOs + AppDbContext together
        // against EF Core 8 (routes excluded — ASP.NET types are outside this sandbox;
        // the Kestrel generated-lane compiles + hosts them).
        var ctx = Ctx(Load());
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .ToList();

        var trees = sources
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToList();

        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        foreach (var p in tpa.Split(Path.PathSeparator)) if (p.Length > 0) paths.Add(p);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.ModelBuilder).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions).Assembly.Location);
        // EFCore.Abstractions supplies [PrimaryKey] (class-level composite key) — the
        // junction entities (PostTag/Follow/Friendship) carry composite PKs.
        paths.Add(typeof(Microsoft.EntityFrameworkCore.PrimaryKeyAttribute).Assembly.Location);
        var refs = paths.Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();

        var comp = CSharpCompilation.Create(
            "m2m_compile_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();
        Assert.True(errors.Count == 0,
            "Generated M:N entity + AppDbContext should compile against EF Core 8:\n" + string.Join("\n", errors));
    }
}
