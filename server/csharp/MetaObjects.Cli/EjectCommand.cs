// `dotnet meta eject <name>...` — ADR-0034 Amendment 3 / the eject design doc's C#
// section. Copies a reference generator's embedded source into the adopter's own
// codegen/generators/ to own, and — on first use — scaffolds the codegen/ console
// project (Codegen.csproj + Program.cs) that `dotnet meta gen` / `dotnet meta verify
// --codegen` hand off to (see Program.cs's RunGen/RunVerify). Mirrors the TypeScript
// `meta eject` / Python `metaobjects eject` contract:
//   - the copy is verbatim, module the ONE edit RewriteForEject makes (the namespace
//     rename forced by ejecting into a COMPILED adopter assembly — see its doc comment);
//   - an existing copy is NEVER overwritten without --force;
//   - every name is validated BEFORE anything is written (a partial eject — some names
//     copied, one refused — is worse than refusing the whole call);
//   - the scaffold (Codegen.csproj / Program.cs) is written ONLY when missing, and is
//     NEVER touched again by a later eject, --force included: once it exists it is the
//     adopter's owned config, exactly like metaobjects.config.ts on the TS side, and
//     eject REPORTS what to wire rather than editing it.

using System.Reflection;
using MetaObjects.Codegen;

namespace MetaObjects.Cli;

public static class EjectCommand
{
    public sealed record Outcome(int ExitCode, IReadOnlyList<string> Out, IReadOnlyList<string> Err)
    {
        public static Outcome Usage(string message) => new(2, [], [message]);
    }

    /// <summary>Every ejectable stable name, in registry order.</summary>
    public static IReadOnlyList<string> EjectableNames() =>
        EjectableGenerators.Entries().Select(e => e.Name).ToList();

    private const string CsprojContent =
        """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <OutputType>Exe</OutputType>
            <TargetFramework>net8.0</TargetFramework>
            <ImplicitUsings>enable</ImplicitUsings>
            <Nullable>enable</Nullable>
          </PropertyGroup>
          <ItemGroup>
            <PackageReference Include="MetaObjects.Codegen" Version="{VERSION}" />
          </ItemGroup>
        </Project>

        """;

    /// <summary>The MetaObjects.Cli tool's own version — the version `dotnet meta eject`
    /// pins the scaffolded Codegen.csproj's <c>MetaObjects.Codegen</c> PackageReference
    /// to, per the eject design doc's C# section ("at the tool's own version").</summary>
    public static string ToolVersion()
    {
        var asm = typeof(EjectCommand).Assembly;
        return PackageVersion(
            asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
            asm.GetName().Version);
    }

    /// <summary>The NuGet version a tool build was published as: the informational version
    /// minus its <c>+sha</c> build metadata, so a release candidate keeps its <c>-rc.N</c>
    /// suffix. The bare assembly version drops that suffix and would pin a package that is
    /// not published yet; it is only the fallback when no informational version exists.</summary>
    public static string PackageVersion(string? informational, Version? assembly)
    {
        if (!string.IsNullOrEmpty(informational))
        {
            var plus = informational.IndexOf('+');
            return plus < 0 ? informational : informational[..plus];
        }
        return assembly?.ToString(3) ?? "1.0.0";
    }

    private static string ProgramCsContent(IEnumerable<string> classNames)
    {
        var news = string.Join("\n", classNames.Select(c => $"    new {c}(),"));
        return
            "// Your owned codegen entry point (ADR-0034 scaffold-and-own). `dotnet meta " +
            "eject` created\n" +
            "// this file once; nothing regenerates it. `dotnet meta gen` / `dotnet meta " +
            "verify --codegen`\n" +
            "// hand off here automatically because codegen/Codegen.csproj exists — see " +
            "MetaObjects.Codegen.\n" +
            "// CodegenCli.Run for what it does with the forwarded arguments.\n" +
            "//\n" +
            "// Add a `new <Name>Generator()` for every generator you eject (`dotnet meta " +
            "eject <name>`);\n" +
            "// remove one to stop running it. This list is yours to edit — eject never " +
            "touches it again.\n" +
            "using Codegen.Generators;\n" +
            "using MetaObjects.Codegen;\n" +
            "\n" +
            "IReadOnlyList<IGenerator> generators =\n" +
            "[\n" +
            news + "\n" +
            "];\n" +
            "\n" +
            "return CodegenCli.Run(args, generators);\n";
    }

    /// <summary>The C# class name a stable registry name's ejected file declares —
    /// derived from its SourceFileName (<c>EntityGenerator.cs</c> → <c>EntityGenerator</c>),
    /// never re-derived from the stable name (which would drift from the real class the
    /// moment the two spellings diverge, e.g. "db-context" → DbContextGenerator).</summary>
    private static string ClassNameFor(GeneratorRegistryEntry entry) =>
        Path.GetFileNameWithoutExtension(entry.SourceFileName!);

    /// <summary>
    /// Eject <paramref name="names"/> into <paramref name="root"/>/codegen/. Every name
    /// is validated before anything is written. Returns exit 2 (usage) for no names or
    /// an unknown/non-ejectable name, exit 1 when an existing copy would be overwritten
    /// without <paramref name="force"/>, else 0.
    /// </summary>
    public static Outcome Run(IReadOnlyList<string> names, string root, bool force)
    {
        if (names.Count == 0)
            return Outcome.Usage(
                "dotnet meta eject requires at least one generator name. " +
                $"Ejectable: {string.Join(", ", EjectableNames())}. " +
                "Run `dotnet meta gen --list` to see them with ownership status.");

        var known = EjectableGenerators.Entries().ToDictionary(e => e.Name, e => e, StringComparer.Ordinal);
        var unknown = names.Where(n => !known.ContainsKey(n)).ToList();
        if (unknown.Count > 0)
            return Outcome.Usage(
                $"unknown or non-ejectable generator(s): {string.Join(", ", unknown)}. " +
                $"Nothing was ejected. Ejectable: {string.Join(", ", EjectableNames())}.");

        var generatorsDir = Path.Combine(root, "codegen", "generators");

        // All names checked BEFORE any write — see the ADR-0034 Amendment 3 doc comment
        // above. A partial eject (half copied, one refused) is worse than refusing the
        // whole call: the adopter cannot tell what state the repo is in.
        var alreadyOwned = names.Where(n => File.Exists(Path.Combine(generatorsDir, known[n].SourceFileName!))).ToList();
        if (alreadyOwned.Count > 0 && !force)
        {
            var paths = alreadyOwned.Select(n => $"codegen/generators/{known[n].SourceFileName}");
            return new Outcome(1, [], [
                $"already owned: {string.Join(", ", paths)}. Eject never overwrites your copy; " +
                "pass --force to replace it (and discard any edits) with the reference.",
            ]);
        }

        Directory.CreateDirectory(generatorsDir);
        var outLines = new List<string>();
        foreach (var name in names)
        {
            var entry = known[name];
            var file = entry.SourceFileName!;
            var rewritten = EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSource(name)!);
            var dest = Path.Combine(generatorsDir, file);
            var status = File.Exists(dest) ? "replaced" : "created";
            File.WriteAllText(dest, rewritten);
            outLines.Add($"ejected \"{name}\" -> codegen/generators/{file} [{status}]");
        }
        outLines.Add("");
        outLines.Add(
            "The copies are yours: edit them freely. `dotnet meta gen --list` reports how far " +
            "an owned copy has drifted from the reference.");

        var codegenDir = Path.Combine(root, "codegen");
        var csprojPath = Path.Combine(codegenDir, "Codegen.csproj");
        var programPath = Path.Combine(codegenDir, "Program.cs");
        if (!File.Exists(csprojPath) && !File.Exists(programPath))
        {
            File.WriteAllText(csprojPath, CsprojContent.Replace("{VERSION}", ToolVersion()));
            File.WriteAllText(programPath, ProgramCsContent(names.Select(n => ClassNameFor(known[n]))));
            outLines.Add("");
            outLines.Add(
                "First use — also wrote codegen/Codegen.csproj and codegen/Program.cs, wiring the " +
                $"generator(s) you just ejected ({string.Join(", ", names.Select(n => $"new {ClassNameFor(known[n])}()"))}). " +
                "From here, `dotnet meta gen` and `dotnet meta verify --codegen` hand off to " +
                "`dotnet run --project codegen` automatically.");
        }
        else
        {
            outLines.Add("");
            outLines.Add(
                "codegen/Program.cs already exists and is yours — eject never edits it. Add:");
            foreach (var name in names)
                outLines.Add($"  new {ClassNameFor(known[name])}(),");
            outLines.Add("to the `generators` list there (and remove the packaged import if this " +
                          "replaces a generator you ran unejected before).");
        }

        return new Outcome(0, outLines, []);
    }
}
