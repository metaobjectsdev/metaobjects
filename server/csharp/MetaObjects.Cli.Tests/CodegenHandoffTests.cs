// ADR-0034 Amendment 3 hand-off. HasOwnedCodegen is the pure decision TryRun spawns a
// process on; covered here without paying for a `dotnet run` in every test run. The
// spawn-and-execute path itself is covered by the one real e2e test
// (EjectEndToEndTests) — see its header for why that one is allowed to be slow.

using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class CodegenHandoffTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-handoff-" + Guid.NewGuid().ToString("N"));

    public CodegenHandoffTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    [Fact]
    public void No_codegen_project_means_no_handoff()
    {
        Assert.False(CodegenHandoff.HasOwnedCodegen(_root));
    }

    [Fact]
    public void An_ejected_codegen_project_is_detected()
    {
        var dir = Path.Combine(_root, "codegen");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "Codegen.csproj"), "<Project />");

        Assert.True(CodegenHandoff.HasOwnedCodegen(_root));
    }

    [Fact]
    public void A_generators_dir_alone_with_no_csproj_is_not_a_handoff_target()
    {
        Directory.CreateDirectory(Path.Combine(_root, "codegen", "generators"));
        File.WriteAllText(Path.Combine(_root, "codegen", "generators", "EntityGenerator.cs"), "// x");

        Assert.False(CodegenHandoff.HasOwnedCodegen(_root));
    }
}
