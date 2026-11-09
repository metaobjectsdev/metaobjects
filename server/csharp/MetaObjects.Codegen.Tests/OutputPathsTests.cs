// R39: generated output paths are keyed by metadata package. Every per-object generator writes
// `<package segments>/<file>`, so two same-named objects in two packages are two files; the C#
// namespace is still the package binding's, so a same-namespace clash is refused by the claim
// registry with PackageNamespaces as the remedy.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class OutputPathsTests
{
    private static string Note(string pkg, string field) => $$"""
        { "metadata.root": { "package": "{{pkg}}", "children": [
          { "object.entity": { "name": "Note", "children": [
            { "source.rdb": { "@table": "{{pkg.Replace("::", "_")}}_notes" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "{{field}}" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } } ] } } ] } }
        """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(Note("acme::alpha", "alphaText"), id: "a.json"),
            new InMemoryStringSource(Note("acme::beta", "betaText"), id: "b.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, bool mapped) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp", Namespace = "Acme.Generated",
            PackageNamespaces = mapped ? new() { ["acme::alpha"] = "Acme.Alpha", ["acme::beta"] = "Acme.Beta" } : new(),
        },
    };

    [Fact]
    public void A_file_is_written_under_its_objects_package()
    {
        var root = Load();
        Assert.Equal("acme/alpha/Note.g.cs", OutputPaths.Of(root.Objects().First(o => o.ResolutionKey() == "acme::alpha::Note"), "Note.g.cs"));
    }

    [Fact]
    public void Two_same_named_objects_in_two_packages_are_two_files_from_every_per_object_generator()
    {
        var ctx = Ctx(Load(), mapped: true);
        foreach (var (gen, file) in new (IGenerator, string)[]
                 {
                     (new EntityGenerator(), "Note.g.cs"), (new NamesGenerator(), "NoteNames.g.cs"),
                     (new FilterAllowlistGenerator(), "NoteFilterAllowlist.g.cs"),
                 })
        {
            var paths = gen.Generate(ctx).Select(f => f.Path).Where(p => p.EndsWith("/" + file)).Order().ToList();
            Assert.Equal([$"acme/alpha/{file}", $"acme/beta/{file}"], paths);
        }
    }

    [Fact]
    public void One_namespace_still_refuses_the_pair_with_PackageNamespaces_as_the_remedy()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => new EntityGenerator().Generate(Ctx(Load(), mapped: false)).ToList());
        Assert.Contains(NameClaims.ERR_NAME_COLLISION, ex.Message);
        Assert.Contains("GenConfig.PackageNamespaces", ex.Message);
    }
}
