using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// Since ADR-0034 Amendment 9, <c>dotnet meta gen</c> and <c>dotnet meta verify --codegen</c>
/// hand every run to the project's codegen project, whose <c>Program.cs</c> calls
/// <see cref="CodegenCli.Run"/> with the list in <c>codegen/Generators.cs</c>. Building a real
/// codegen project per test is minutes of <c>dotnet run</c> (EjectEndToEndTests does it once), so
/// these tests call that same entry point in process with the list the project would declare, from
/// the directory the CLI would have run in.
/// <para>
/// The working directory and the console are process-wide, so every test that uses this runs in
/// <see cref="OwnedRunnerCollection"/>, which xunit runs alone.
/// </para>
/// </summary>
internal static class OwnedRunner
{
    private static readonly object Gate = new();

    /// <summary>The list a project declares, built from registry names as its Generators.cs would.</summary>
    internal static IReadOnlyList<IGenerator> Declared(string workingDir, params string[] registryNames) =>
        GeneratorRegistry.Resolve(registryNames,
            new GeneratorBuildContext(Path.Combine(workingDir, CodegenCli.DefaultTemplateRoot(workingDir))));

    /// <summary>Run <c>CodegenCli.Run(args, declared)</c> from <paramref name="workingDir"/>, capturing
    /// stdout and stderr.</summary>
    internal static (int ExitCode, string Stdout, string Stderr) Run(
        string workingDir, IReadOnlyList<IGenerator> declared, params string[] args)
    {
        lock (Gate)
        {
            var (cwd, stdout, stderr) = (Directory.GetCurrentDirectory(), Console.Out, Console.Error);
            var (outWriter, errWriter) = (new StringWriter(), new StringWriter());
            try
            {
                Directory.SetCurrentDirectory(workingDir);
                Console.SetOut(outWriter);
                Console.SetError(errWriter);
                var exit = CodegenCli.Run(args, declared);
                return (exit, outWriter.ToString(), errWriter.ToString());
            }
            finally
            {
                Console.SetOut(stdout);
                Console.SetError(stderr);
                Directory.SetCurrentDirectory(cwd);
            }
        }
    }

    /// <summary>As <see cref="Run(string, IReadOnlyList{IGenerator}, string[])"/>, the list given by registry names.</summary>
    internal static (int ExitCode, string Stdout, string Stderr) Run(
        string workingDir, string[] registryNames, params string[] args) =>
        Run(workingDir, Declared(workingDir, registryNames), args);
}

/// <summary>Tests that change the working directory or the console run alone.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class OwnedRunnerCollection
{
    public const string Name = "owned runner (process-wide cwd and console)";
}
