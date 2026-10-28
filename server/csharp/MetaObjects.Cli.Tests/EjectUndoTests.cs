// `dotnet meta eject --undo [<name>...]` — drop owned generator copies identical to the shipped
// ones, and the `gen` notice that says such copies exist. Same contract as the TypeScript port.

using MetaObjects.Cli;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class EjectUndoTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-undo-" + Guid.NewGuid().ToString("N"));
    private string Owned(string rel) => Path.Combine(_root, rel.Replace('/', Path.DirectorySeparatorChar));

    public EjectUndoTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private void Eject(params string[] names) =>
        Assert.Equal(0, EjectCommand.Run(names, _root, force: false).ExitCode);

    private void Edit(string rel) => File.AppendAllText(Owned(rel), "\n// my own edit\nvar mine = 1;\n");

    [Fact]
    public void With_no_names_removes_every_identical_copy_and_keeps_the_edited_one()
    {
        Eject("entity", "filter-allowlist");
        Edit("codegen/generators/EntityGenerator.cs");

        var result = EjectCommand.Undo([], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.False(File.Exists(Owned("codegen/generators/FilterAllowlistGenerator.cs")));
        Assert.True(File.Exists(Owned("codegen/generators/EntityGenerator.cs")));
        Assert.Contains(result.Out, l => l.StartsWith("removed codegen/generators/FilterAllowlistGenerator.cs"));
        Assert.DoesNotContain(result.Out, l => l.Contains("removed codegen/generators/EntityGenerator.cs"));
    }

    [Fact]
    public void It_prints_the_edit_that_points_the_entry_back_and_never_edits_Generators_cs()
    {
        Eject("filter-allowlist");
        var before = File.ReadAllText(Owned("codegen/Generators.cs"));

        var result = EjectCommand.Undo([], _root, force: false);

        Assert.Equal(before, File.ReadAllText(Owned("codegen/Generators.cs")));
        var text = string.Join("\n", result.Out);
        Assert.Contains("new Codegen.Generators.FilterAllowlistGenerator()", text);
        Assert.Contains("new MetaObjects.Codegen.Generators.FilterAllowlistGenerator()", text);
    }

    [Fact]
    public void A_named_copy_that_differs_is_refused_with_exit_2_and_nothing_is_removed()
    {
        Eject("entity", "filter-allowlist");
        Edit("codegen/generators/EntityGenerator.cs");

        var result = EjectCommand.Undo(["filter-allowlist", "entity"], _root, force: false);

        Assert.Equal(2, result.ExitCode);
        Assert.True(File.Exists(Owned("codegen/generators/FilterAllowlistGenerator.cs")));
        Assert.True(File.Exists(Owned("codegen/generators/EntityGenerator.cs")));
        var err = string.Join("\n", result.Err);
        Assert.Contains("entity DIFFERS", err);
        Assert.Contains("--force", err);
    }

    [Fact]
    public void Force_removes_a_copy_that_differs()
    {
        Eject("entity");
        Edit("codegen/generators/EntityGenerator.cs");

        var result = EjectCommand.Undo(["entity"], _root, force: true);

        Assert.Equal(0, result.ExitCode);
        Assert.False(File.Exists(Owned("codegen/generators/EntityGenerator.cs")));
    }

    [Fact]
    public void An_unknown_or_not_owned_name_refuses_the_whole_call()
    {
        Eject("filter-allowlist");

        Assert.Equal(2, EjectCommand.Undo(["filter-allowlist", "no-such"], _root, force: false).ExitCode);
        var notOwned = EjectCommand.Undo(["filter-allowlist", "entity"], _root, force: false);
        Assert.Equal(2, notOwned.ExitCode);
        Assert.Contains("entity", string.Join("\n", notOwned.Err));
        Assert.True(File.Exists(Owned("codegen/generators/FilterAllowlistGenerator.cs")));
    }

    [Fact]
    public void Says_plainly_when_nothing_is_identical()
    {
        Eject("entity");
        Edit("codegen/generators/EntityGenerator.cs");

        var result = EjectCommand.Undo([], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("no owned copy is identical", string.Join("\n", result.Out));
        Assert.True(File.Exists(Owned("codegen/generators/EntityGenerator.cs")));
    }

    [Fact]
    public void Says_plainly_when_nothing_is_owned()
    {
        var result = EjectCommand.Undo([], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("no owned generator copies", string.Join("\n", result.Out));
    }

    [Fact]
    public void Companions_go_with_the_generator_unless_a_remaining_owned_generator_uses_them()
    {
        var api = GeneratorRegistry.Get("api-docs")!;
        Assert.NotEmpty(api.Companions);
        Eject("api-docs");
        var companion = EjectableGenerators.OwnedRelativePath(api.Companions[0]);
        Assert.True(File.Exists(Owned(companion)));

        Assert.Equal(0, EjectCommand.Undo([], _root, force: false).ExitCode);
        Assert.False(File.Exists(Owned(companion)));
        Assert.False(File.Exists(Owned("codegen/generators/ApiDocsGenerator.cs")));
    }

    [Fact]
    public void An_edited_companion_is_kept_and_so_the_generator_is_not_identical()
    {
        var api = GeneratorRegistry.Get("api-docs")!;
        Eject("api-docs");
        var companion = EjectableGenerators.OwnedRelativePath(api.Companions[0]);
        Edit(companion);

        var result = EjectCommand.Undo([], _root, force: false);

        Assert.Contains("no owned copy is identical", string.Join("\n", result.Out));
        Assert.True(File.Exists(Owned(companion)));
    }

    [Fact]
    public void Gen_notice_names_identical_copies_and_the_undo_command_and_is_silent_otherwise()
    {
        Assert.Null(OwnedCopy.IdenticalNotice(_root));

        Eject("entity", "filter-allowlist");
        Edit("codegen/generators/EntityGenerator.cs");

        var notice = OwnedCopy.IdenticalNotice(_root)!;
        Assert.DoesNotContain('\n', notice);
        Assert.Contains("filter-allowlist", notice);
        Assert.DoesNotContain("entity", notice);
        Assert.Contains("dotnet meta eject --undo", notice);
    }

    [Fact]
    public void A_changed_helper_runtime_keeps_its_generator_out_of_the_notice_and_out_of_no_name_undo()
    {
        Eject("routes");
        Assert.Contains("routes", OwnedCopy.IdenticalNotice(_root)!);
        var runtimeFile = $"{HelperRuntime.OwnedDirectory}/{HelperRuntime.Files[0]}";
        Edit(runtimeFile);

        Assert.Null(OwnedCopy.IdenticalNotice(_root));
        var result = EjectCommand.Undo([], _root, force: false);
        Assert.Equal(0, result.ExitCode);
        Assert.True(File.Exists(Owned("codegen/generators/RoutesGenerator.cs")));
        Assert.True(File.Exists(Owned(runtimeFile)));

        var named = EjectCommand.Undo(["routes"], _root, force: false);
        Assert.Equal(2, named.ExitCode);
        Assert.Contains(HelperRuntime.Files[0], string.Join("\n", named.Err));
        Assert.True(File.Exists(Owned("codegen/generators/RoutesGenerator.cs")));
    }

    [Fact]
    public void Undoing_the_last_runtime_user_removes_the_whole_identical_helper_runtime()
    {
        Eject("routes");

        var result = EjectCommand.Undo([], _root, force: false);

        Assert.Equal(0, result.ExitCode);
        Assert.False(Directory.Exists(Owned(HelperRuntime.OwnedDirectory)));
        Assert.Contains(result.Out, l => l.StartsWith("The helper runtime copy is gone"));
    }
}
