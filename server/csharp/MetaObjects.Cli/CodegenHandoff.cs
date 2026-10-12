// ADR-0034 Amendment 3 / the eject design doc's C# section, "Hand-off": once `dotnet
// meta eject` has scaffolded codegen/Codegen.csproj, that project's `new`-built
// generator list — not the packaged registry — is authoritative for codegen. `dotnet
// meta gen` and `dotnet meta verify --codegen` detect it and run `dotnet run --project
// codegen -- <forwarded args>` instead, returning its exit code. The subprocess inherits
// this process's console, so its own output (MetaObjects.Codegen.CodegenCli.Run's) is
// what the user sees — nothing here re-prints it.

using System.Diagnostics;

namespace MetaObjects.Cli;

public static class CodegenHandoff
{
    /// <summary>True iff <paramref name="projectRoot"/> has an ejected codegen project
    /// to hand off to. Split out from <see cref="TryRun"/> so the DECISION is testable
    /// without spawning a process.</summary>
    public static bool HasOwnedCodegen(string projectRoot) =>
        File.Exists(Path.Combine(projectRoot, "codegen", "Codegen.csproj"));

    /// <summary>True iff <paramref name="projectRoot"/> owns the api-docs generator: the ejected
    /// codegen project exists AND carries <c>codegen/generators/ApiDocsGenerator.cs</c>. That file is
    /// what `dotnet meta docs` hands off for — the project's own copy writes the reference. Its
    /// presence says a tool that can eject api-docs wrote it, NOT that the package
    /// <c>codegen/Codegen.csproj</c> pins knows the <c>docs</c> command: eject never edits that pin, so
    /// a project scaffolded by an older tool keeps the older one until its owner raises it, and
    /// <see cref="EjectCommand.Run"/> warns when it writes into such a project. A project with no such
    /// file never ejected api-docs, and <c>docs</c> stays with the packaged generator whatever it pins.</summary>
    public static bool HasOwnedDocs(string projectRoot) =>
        HasOwnedCodegen(projectRoot) &&
        MetaObjects.Codegen.GeneratorRegistry.Get("api-docs")?.SourceFileName is { } file &&
        File.Exists(Path.Combine(projectRoot, "codegen", "generators", file));

    /// <summary>
    /// When <paramref name="projectRoot"/> has an ejected codegen project, run `dotnet
    /// run --project codegen -- &lt;args&gt;` (inheriting this process's console) and set
    /// <paramref name="exitCode"/> to its exit code, returning <c>true</c>. Returns
    /// <c>false</c> (and 0) with nothing run when there is no owned codegen project.
    /// </summary>
    public static bool TryRun(string projectRoot, string[] args, out int exitCode)
    {
        // `docs` hands off only for a project that owns the api-docs generator.
        var handsOff = args is ["docs", ..] ? HasOwnedDocs(projectRoot) : HasOwnedCodegen(projectRoot);
        if (!handsOff)
        {
            exitCode = 0;
            return false;
        }

        Console.WriteLine(
            "dotnet meta: codegen/Codegen.csproj exists — handing off to " +
            $"`dotnet run --project codegen -- {string.Join(' ', args)}` (ADR-0034 eject).");

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
