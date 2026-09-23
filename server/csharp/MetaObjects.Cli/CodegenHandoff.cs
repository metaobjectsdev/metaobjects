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
