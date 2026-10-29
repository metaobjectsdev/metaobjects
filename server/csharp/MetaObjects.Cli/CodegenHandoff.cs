// ADR-0034 Amendment 9: the project's generator list is codegen/Generators.cs, compiled by
// the codegen/ console project that `dotnet meta init` (or a first `dotnet meta eject`)
// scaffolds. `dotnet meta gen` and `dotnet meta verify --codegen` always run that list:
// they run `dotnet run --project codegen -- <forwarded args>` and return its exit code.
// A project with no codegen/Generators.cs has no list, and the CLI refuses rather than
// generating something it chose. The subprocess inherits this process's console, so its
// own output (MetaObjects.Codegen.CodegenCli.Run's) is what the user sees.

using System.Diagnostics;

namespace MetaObjects.Cli;

public static class CodegenHandoff
{
    /// <summary>True iff <paramref name="projectRoot"/> has a codegen project to hand off to.
    /// Split out from <see cref="TryRun"/> so the DECISION is testable without spawning a process.</summary>
    public static bool HasOwnedCodegen(string projectRoot) =>
        File.Exists(Path.Combine(projectRoot, "codegen", "Codegen.csproj"));

    /// <summary>True iff <paramref name="projectRoot"/> declares its generator list,
    /// <c>codegen/Generators.cs</c>.</summary>
    public static bool HasGeneratorList(string projectRoot) =>
        File.Exists(Path.Combine(projectRoot, "codegen", "Generators.cs"));

    /// <summary>True iff <paramref name="projectRoot"/> has a <c>codegen/Program.cs</c> that does not run
    /// <c>Generators.All</c>: a 1.0 entry point, which declares its own list and ignores codegen/Generators.cs.</summary>
    public static bool ProgramIgnoresList(string projectRoot)
    {
        var program = Path.Combine(projectRoot, "codegen", "Program.cs");
        return File.Exists(program) && !MetaObjects.Codegen.CSharpSource.ReferencesMember(File.ReadAllText(program), "Generators", "All");
    }

    /// <summary>
    /// When <paramref name="projectRoot"/> has an ejected codegen project, run `dotnet
    /// run --project codegen -- &lt;args&gt;` (inheriting this process's console) and set
    /// <paramref name="exitCode"/> to its exit code, returning <c>true</c>. Returns
    /// <c>false</c> (and 0) with nothing run when there is no owned codegen project.
    /// </summary>
    public static bool TryRun(string projectRoot, string[] args, out int exitCode)
    {
        if (!HasOwnedCodegen(projectRoot))
        {
            exitCode = 0;
            return false;
        }

        Console.WriteLine(
            "dotnet meta: running the generator list in codegen/Generators.cs — " +
            $"`dotnet run --project codegen -- {string.Join(' ', args)}`.");

        var psi = new ProcessStartInfo("dotnet") { WorkingDirectory = Directory.GetCurrentDirectory() };
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("--project");
        psi.ArgumentList.Add(Path.Combine(projectRoot, "codegen"));
        psi.ArgumentList.Add("--");
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start `dotnet run` for the codegen hand-off");
        proc.WaitForExit();
        exitCode = proc.ExitCode;
        return true;
    }
}
