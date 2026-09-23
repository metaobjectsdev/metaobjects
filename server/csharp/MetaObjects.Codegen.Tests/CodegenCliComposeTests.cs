// An ejected codegen/Program.cs lists only the generators the project OWNS; its
// `--generators` selection still names every generator the project runs. The owned
// runner composes the two. Before it did, ejecting one generator silently dropped every
// other generator the project selected, because the runner ignored --generators.

using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class CodegenCliComposeTests
{
    private sealed class Owned(string name) : IGenerator
    {
        public string Name { get; } = name;
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => [];
    }

    [Fact]
    public void No_selection_runs_only_the_owned_list()
    {
        IReadOnlyList<IGenerator> owned = [new Owned("entity")];

        var suite = CodegenCli.ComposeGenerators(owned, null, "prompts");

        Assert.Same(owned[0], Assert.Single(suite));
    }

    [Fact]
    public void An_owned_copy_takes_the_packaged_generators_place_in_selection_order()
    {
        // An ejected copy keeps the reference's Name, which for `entity` is not the
        // stable selection name — the match must go through the packaged instance.
        var packaged = GeneratorRegistry.Resolve(["entity", "names", "filter-allowlist"]);
        var mine = new Owned(packaged[0].Name);

        var suite = CodegenCli.ComposeGenerators([mine], ["entity", "names", "filter-allowlist"], "prompts");

        Assert.Equal(packaged.Select(g => g.Name), suite.Select(g => g.Name));
        Assert.Same(mine, suite[0]);
        Assert.IsNotType<Owned>(suite[1]);
        Assert.IsNotType<Owned>(suite[2]);
    }

    [Fact]
    public void An_owned_generator_the_selection_does_not_name_still_runs()
    {
        var custom = new Owned("audit-log");

        var suite = CodegenCli.ComposeGenerators([custom], ["entity"], "prompts");

        Assert.Equal([GeneratorRegistry.Resolve(["entity"])[0].Name, "audit-log"], suite.Select(g => g.Name));
    }

    [Fact]
    public void An_unknown_selected_name_is_refused()
    {
        var ex = Assert.Throws<ArgumentException>(
            () => CodegenCli.ComposeGenerators([], ["no-such-generator"], "prompts"));
        Assert.Contains("no-such-generator", ex.Message);
    }
}
