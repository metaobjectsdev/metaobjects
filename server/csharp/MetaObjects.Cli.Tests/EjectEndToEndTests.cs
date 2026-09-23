// ADR-0034 Amendment 3 — the ONE real end-to-end eject test (task's own allowance:
// "keep one e2e test that uses a ProjectReference instead of the PackageReference" when
// a `dotnet run` e2e is too slow/network-bound for every test). Everything else in this
// port's eject coverage runs in-process (EjectCommandTests, OwnedCopyTests,
// EjectedGeneratorCompileTests' in-memory Roslyn compile-and-invoke). This test is the
// one that actually shells out to `dotnet run` against a SEPARATE, freshly-scaffolded
// console project — proving proof (b): "an edited copy's change appears in `gen` output
// and `verify --codegen` passes" — which requires a REAL compile of the edited file,
// something no in-process technique can substitute for.
//
// SUBSTITUTION, documented per the task instructions: `dotnet meta eject` scaffolds
// codegen/Codegen.csproj with a `<PackageReference Include="MetaObjects.Codegen" .../>`
// pinned to the tool's own version — correct for a real adopter, who installs it from
// NuGet. This repo's MetaObjects.Codegen has never been published (it is mid-development
// in this very session), so after ejecting, this test REWRITES that one line to a
// `<ProjectReference>` pointing at this checkout's own MetaObjects.Codegen.csproj before
// running `dotnet run`. That is the only difference from what a real adopter's
// codegen/Codegen.csproj looks like; everything else (the ejected generator copy,
// Program.cs, the `dotnet run --project codegen -- gen/verify` invocations) is exactly
// what ships.
//
// SLOW ON PURPOSE: two `dotnet run` invocations, each restoring + building the
// MetaObjects/MetaObjects.Render/MetaObjects.Codegen/Codegen chain. Kept to ONE test.

using System.Diagnostics;
using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class EjectEndToEndTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-eject-e2e-" + Guid.NewGuid().ToString("N"));
    private string CodegenCsproj => Path.Combine(_root, "codegen", "Codegen.csproj");
    private string GeneratorCopy => Path.Combine(_root, "codegen", "generators", "EntityGenerator.cs");
    private string MetadataDir => Path.Combine(_root, "metaobjects");
    private string OutDir => Path.Combine(_root, "out");

    public EjectEndToEndTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "fixtures", "persistence-conformance")) &&
                Directory.Exists(Path.Combine(dir.FullName, "server", "csharp")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException("could not locate the repo root from " + AppContext.BaseDirectory);
    }

    /// <summary>Run <paramref name="args"/> against the ejected codegen project and
    /// return (exitCode, combined stdout+stderr).</summary>
    private (int ExitCode, string Output) RunCodegenProject(params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = _root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        // No long-lived build processes. `dotnet run` otherwise leaves MSBuild worker nodes
        // (node reuse), the MSBuild server and the VBCSCompiler server running after it
        // exits, and they inherit the redirected stdout/stderr — so ReadToEndAsync never sees
        // EOF and the test hangs with the child already gone.
        psi.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        psi.Environment["DOTNET_CLI_USE_MSBUILD_SERVER"] = "0";
        psi.Environment["UseSharedCompilation"] = "false";
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("--project");
        psi.ArgumentList.Add(Path.Combine(_root, "codegen"));
        psi.ArgumentList.Add("--");
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi)!;
        // Read stdout AND stderr CONCURRENTLY. `dotnet run` builds a 4-project chain
        // (MetaObjects -> MetaObjects.Render -> MetaObjects.Codegen -> Codegen) and can
        // write well past the ~64KB OS pipe buffer on either stream; reading one to
        // completion before starting the other is the textbook Process deadlock — the
        // child blocks writing to the unread stream while this method blocks reading the
        // other one. Awaiting both tasks together is the fix.
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        var exited = proc.WaitForExit(TimeSpan.FromMinutes(5));
        var output = Task.WhenAll(stdoutTask, stderrTask).GetAwaiter().GetResult();
        if (!exited)
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
            throw new TimeoutException($"`dotnet run --project codegen -- {string.Join(' ', args)}` did not exit within 5 minutes.");
        }
        return (proc.ExitCode, output[0] + output[1]);
    }

    [Fact]
    public void Edited_ejected_copy_changes_gen_output_and_verify_codegen_passes()
    {
        var repoRoot = RepoRoot();

        // A small, self-contained metadata source — copied rather than pointed at the
        // shared fixtures/ corpus directly, so every write this test makes (gen output,
        // .metaobjects/.gen-state/) lands under the temp root and never touches the
        // checked-in repo tree.
        Directory.CreateDirectory(MetadataDir);
        File.WriteAllText(Path.Combine(MetadataDir, "meta.acme.json"), """
        { "metadata.root": { "package": "acme::widgets", "children": [
          { "object.entity": { "name": "Widget", "children": [
            { "source.rdb": { "@table": "widgets" } },
            { "field.uuid":   { "name": "id", "@required": true } },
            { "field.string": { "name": "label", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "uuid" } }
          ]}}
        ]}}
        """);

        // 1. Eject — writes codegen/generators/EntityGenerator.cs, codegen/Codegen.csproj,
        //    codegen/Program.cs (this is real `dotnet meta eject entity` behavior).
        var eject = EjectCommand.Run(["entity"], _root, force: false);
        Assert.Equal(0, eject.ExitCode);
        Assert.True(File.Exists(CodegenCsproj));
        Assert.True(File.Exists(GeneratorCopy));

        // 2. Substitute PackageReference -> ProjectReference (see header comment).
        var codegenProjPath = Path.Combine(repoRoot, "server", "csharp", "MetaObjects.Codegen", "MetaObjects.Codegen.csproj");
        Assert.True(File.Exists(codegenProjPath), $"expected {codegenProjPath} to exist");
        var csprojText = File.ReadAllText(CodegenCsproj);
        Assert.Contains("<PackageReference Include=\"MetaObjects.Codegen\"", csprojText);
        var rewrittenCsproj = System.Text.RegularExpressions.Regex.Replace(
            csprojText,
            "<PackageReference Include=\"MetaObjects.Codegen\"[^/]*/>",
            $"<ProjectReference Include=\"{codegenProjPath}\" />");
        Assert.DoesNotContain("PackageReference", rewrittenCsproj);
        File.WriteAllText(CodegenCsproj, rewrittenCsproj);

        // 3. Edit the ejected copy — one line, injecting a marker into every emitted
        //    file's header, proving CUSTOM LOGIC (not just the unmodified reference)
        //    flows through a real compile into real output.
        var original = File.ReadAllText(GeneratorCopy);
        Assert.Contains("sb.AppendLine(\"// <auto-generated/>\");", original);
        var edited = original.Replace(
            "sb.AppendLine(\"// <auto-generated/>\");",
            "sb.AppendLine(\"// <auto-generated/>\");\n        sb.AppendLine(\"// EJECTED-E2E-MARKER\");");
        Assert.NotEqual(original, edited);
        File.WriteAllText(GeneratorCopy, edited);

        // 4. `dotnet run --project codegen -- gen ...` — a REAL compile of the edited copy.
        var (genExit, genOutput) = RunCodegenProject("gen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated");
        Assert.True(genExit == 0, $"gen failed (exit {genExit}):\n{genOutput}");

        var generated = Directory.GetFiles(OutDir, "*.cs", SearchOption.AllDirectories);
        Assert.NotEmpty(generated);
        Assert.Contains(generated, f => File.ReadAllText(f).Contains("EJECTED-E2E-MARKER"));

        // 5. `dotnet run --project codegen -- verify --codegen ...` — the committed output
        //    (produced by the SAME edited copy) must read as in sync with a fresh regen.
        var (verifyExit, verifyOutput) = RunCodegenProject(
            "verify", "--codegen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated");
        Assert.True(verifyExit == 0, $"verify --codegen failed (exit {verifyExit}):\n{verifyOutput}");
        Assert.Contains("OK", verifyOutput);
    }
}
