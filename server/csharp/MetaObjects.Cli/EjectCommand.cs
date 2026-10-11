// `dotnet meta eject <name>...` — ADR-0034 Amendment 3 / the eject design doc's C#
// section. Copies a reference generator's embedded source into the adopter's own
// codegen/generators/ to own, and — on first use — scaffolds the codegen/ console
// project (Codegen.csproj + Program.cs) that `dotnet meta gen` / `dotnet meta verify
// --codegen` hand off to (see Program.cs's RunGen/RunVerify). Mirrors the TypeScript
// `meta eject` / Python `metaobjects eject` contract:
//   - the copy is verbatim, modulo the namespace edits RewriteForEject makes (the rename
//     forced by ejecting into a COMPILED adopter assembly — see its doc comment);
//   - a generator whose OUTPUT imports the helper runtime (routes) brings that runtime's
//     source with it, into codegen/runtime/ (see MetaObjects.Codegen.HelperRuntime), so
//     the adopter owns every line their generated routes call;
//   - a generator that writes part of its output through an emitter (the registry entry's
//     Companions: the prompt tier's field mapping and format-spec writer, the entity tier's
//     enum, navigation and doc-comment writers, the api reference's page builder) brings
//     that emitter's source with it, beside it under codegen/, so the copy is the generator
//     and not a shell around the package's;
//   - an existing copy is NEVER overwritten without --force;
//   - every name is validated BEFORE anything is written (a partial eject — some names
//     copied, one refused — is worse than refusing the whole call);
//   - the scaffold (Codegen.csproj / Program.cs) is written ONLY when missing, and is
//     NEVER touched again by a later eject, --force included: once it exists it is the
//     adopter's owned config, exactly like metaobjects.config.ts on the TS side, and
//     eject REPORTS what to wire rather than editing it;
//   - the sources eject writes are the TOOL's version's, and an existing Codegen.csproj may pin
//     an older MetaObjects.Codegen they do not compile against, so eject WARNS when the pin is
//     older than the tool and names the line to change (it still never edits the file).

using System.Numerics;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
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
          <!-- runtime/ is the helper runtime your GENERATED code compiles with (your app
               project includes it); it is not part of this codegen tool. -->
          <ItemGroup>
            <Compile Remove="runtime/**" />
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

    private const string PinnedPackage = "MetaObjects.Codegen";

    // semver.org's grammar for the versions NuGet publishes this package under: three numeric
    // parts, an optional pre-release, optional build metadata (which never orders).
    private static readonly Regex SemanticVersion = new(
        @"^(?<major>[0-9]+)\.(?<minor>[0-9]+)\.(?<patch>[0-9]+)(?:-(?<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$",
        RegexOptions.Compiled);

    /// <summary>
    /// True when <paramref name="pinned"/> precedes <paramref name="required"/> as semantic
    /// versions (semver.org §11, so a pre-release precedes its release: <c>1.1.0-rc.1</c> is
    /// older than <c>1.1.0</c>). False when either is not a plain semantic version — an MSBuild
    /// property, a range, a floating version — because nothing can be said about such a pin.
    /// </summary>
    public static bool IsOlderVersion(string pinned, string required)
    {
        var a = SemanticVersion.Match(pinned);
        var b = SemanticVersion.Match(required);
        if (!a.Success || !b.Success) return false;

        foreach (var part in (string[])["major", "minor", "patch"])
        {
            var order = BigInteger.Parse(a.Groups[part].Value).CompareTo(BigInteger.Parse(b.Groups[part].Value));
            if (order != 0) return order < 0;
        }
        var (preA, preB) = (a.Groups["pre"], b.Groups["pre"]);
        if (!preA.Success || !preB.Success) return preA.Success && !preB.Success;

        var (idsA, idsB) = (preA.Value.Split('.'), preB.Value.Split('.'));
        for (var i = 0; i < Math.Min(idsA.Length, idsB.Length); i++)
        {
            var numericA = idsA[i].All(char.IsAsciiDigit);
            var numericB = idsB[i].All(char.IsAsciiDigit);
            var order = numericA && numericB
                ? BigInteger.Parse(idsA[i]).CompareTo(BigInteger.Parse(idsB[i]))
                : numericA != numericB ? (numericA ? -1 : 1) : string.CompareOrdinal(idsA[i], idsB[i]);
            if (order != 0) return order < 0;
        }
        return idsA.Length < idsB.Length;
    }

    /// <summary>The version <paramref name="csprojPath"/> pins <c>MetaObjects.Codegen</c> to and the
    /// 1-based line that carries it, or <c>null</c> when the file is not readable XML or has no such
    /// PackageReference with a version.</summary>
    private static (string Version, int Line)? PinnedCodegenVersion(string csprojPath)
    {
        XDocument doc;
        try { doc = XDocument.Load(csprojPath, LoadOptions.SetLineInfo); }
        catch (Exception e) when (e is XmlException or IOException or UnauthorizedAccessException) { return null; }

        var reference = doc.Descendants().FirstOrDefault(e =>
            e.Name.LocalName == "PackageReference" &&
            string.Equals((string?)e.Attribute("Include"), PinnedPackage, StringComparison.OrdinalIgnoreCase));
        XObject? version = reference?.Attribute("Version") as XObject
            ?? reference?.Elements().FirstOrDefault(e => e.Name.LocalName == "Version");
        return version switch
        {
            XAttribute a => (a.Value.Trim(), ((IXmlLineInfo)a).LineNumber),
            XElement e => (e.Value.Trim(), ((IXmlLineInfo)e).LineNumber),
            _ => null,
        };
    }

    /// <summary>What eject says when the owned project pins a package older than the sources it was
    /// just handed: empty when the pin is this tool's version or newer, or cannot be read.</summary>
    private static IReadOnlyList<string> OlderPinWarning(string csprojPath)
    {
        var tool = ToolVersion();
        if (PinnedCodegenVersion(csprojPath) is not { } pin || !IsOlderVersion(pin.Version, tool)) return [];
        return
        [
            "",
            $"warning: codegen/Codegen.csproj pins {PinnedPackage} {pin.Version}, older than the {tool} this " +
            $"eject wrote its sources from. Those sources are written against the {tool} package API, so the " +
            $"owned project will not compile until the pin is {tool} or later. Eject never edits that file: " +
            $"change line {pin.Line} of codegen/Codegen.csproj to",
            $"  <PackageReference Include=\"{PinnedPackage}\" Version=\"{tool}\" />",
        ];
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
        outLines.AddRange(EjectCompanions(root, names.Select(n => known[n]).ToList(), force));
        var runtimeUsers = names.Where(n => HelperRuntime.UsedBy(EjectableGenerators.ReadSource(n)!)).ToList();
        if (runtimeUsers.Count > 0)
            outLines.AddRange(EjectRuntime(root, runtimeUsers, force));

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
            if (File.Exists(csprojPath)) outLines.AddRange(OlderPinWarning(csprojPath));
        }

        return new Outcome(0, outLines, []);
    }

    /// <summary>
    /// Copy the emitters the ejected <paramref name="entries"/> write their output through
    /// (<see cref="GeneratorRegistryEntry.Companions"/>) next to the generators, each once however
    /// many of them call it. A file that already exists is the adopter's and is kept — possibly
    /// edited, possibly shared with a generator ejected earlier — unless <paramref name="force"/>,
    /// which replaces it with the reference exactly as it replaces the generator copy.
    /// </summary>
    private static List<string> EjectCompanions(string root, IReadOnlyList<GeneratorRegistryEntry> entries, bool force)
    {
        var companions = entries.SelectMany(e => e.Companions).Distinct(StringComparer.Ordinal).ToList();
        var lines = new List<string>();
        if (companions.Count == 0) return lines;

        lines.Add("");
        lines.Add(
            $"{string.Join(", ", entries.Where(e => e.Companions.Count > 0).Select(e => $"\"{e.Name}\""))} " +
            "write their output through emitters; copied their source so you own that too:");
        foreach (var sourcePath in companions)
        {
            var relative = EjectableGenerators.OwnedRelativePath(sourcePath);
            var dest = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            string status;
            if (!File.Exists(dest)) status = "created";
            else if (force) status = "replaced";
            else
            {
                lines.Add($"  {relative} [kept — already yours]");
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.WriteAllText(dest, EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSourcePath(sourcePath)));
            lines.Add($"  {relative} [{status}]");
        }
        return lines;
    }

    /// <summary>
    /// Copy the helper runtime (<see cref="HelperRuntime"/>) into codegen/runtime/ for the
    /// ejected generator(s) <paramref name="users"/> whose output imports it. A file that
    /// already exists is the adopter's and is kept — possibly edited, possibly shared with a
    /// generator ejected earlier — unless <paramref name="force"/>, which replaces it with
    /// the reference exactly as it replaces the generator copy.
    /// </summary>
    private static List<string> EjectRuntime(string root, IReadOnlyList<string> users, bool force)
    {
        var dir = Path.Combine(root, HelperRuntime.OwnedDirectory);
        Directory.CreateDirectory(dir);
        var lines = new List<string>
        {
            "",
            $"{string.Join(", ", users.Select(u => $"\"{u}\""))} output imports the helper runtime; " +
            $"copied its source so you own it too (namespace {HelperRuntime.OwnedNamespace}):",
        };
        foreach (var file in HelperRuntime.Files)
        {
            var dest = Path.Combine(dir, file);
            string status;
            if (!File.Exists(dest)) status = "created";
            else if (force) status = "replaced";
            else
            {
                lines.Add($"  {HelperRuntime.OwnedDirectory}/{file} [kept — already yours]");
                continue;
            }
            File.WriteAllText(dest, HelperRuntime.OwnedReference(file));
            lines.Add($"  {HelperRuntime.OwnedDirectory}/{file} [{status}]");
        }
        lines.Add(
            $"Compile {HelperRuntime.OwnedDirectory}/ into the project that compiles your generated " +
            "code, e.g. in its .csproj:");
        lines.Add($"  <Compile Include=\"<path-to-project-root>/{HelperRuntime.OwnedDirectory}/**/*.cs\" />");
        lines.Add(
            $"and register the timestamp converter from `{HelperRuntime.OwnedNamespace}` rather than " +
            $"`{HelperRuntime.PackagedNamespace}`. The generated routes then need no MetaObjects.Codegen " +
            "reference. codegen/Codegen.csproj must not compile runtime/ " +
            "(`<Compile Remove=\"runtime/**\" />`; a scaffold written by this version already has it).");
        return lines;
    }
}
