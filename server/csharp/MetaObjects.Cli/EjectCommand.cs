// `dotnet meta eject <name>...` — ADR-0034 Amendment 3 / the eject design doc's C#
// section. Copies a reference generator's embedded source into the adopter's own
// codegen/generators/ to own, and — when missing — scaffolds the codegen/ console
// project (Codegen.csproj + Program.cs + the generator list, Generators.cs) that `dotnet
// meta gen` / `dotnet meta verify --codegen` run (see Program.cs's RunGen/RunVerify). Mirrors the TypeScript
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
//   - the scaffold (Codegen.csproj / Program.cs / Generators.cs, see CodegenScaffold) is
//     written file by file, ONLY when missing, and is NEVER touched again by a later eject,
//     --force included: once it exists it is the adopter's owned config, exactly like
//     metaobjects.config.ts on the TS side, and eject REPORTS what to wire rather than editing it;
//   - the sources eject writes are the TOOL's version's, and an existing Codegen.csproj may pin
//     an older MetaObjects.Codegen they do not compile against, so eject WARNS when the pin is
//     older than the tool and names the line to change (it still never edits the file).

using System.Numerics;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using MetaObjects.AgentContext;
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
            return AgentContextScaffold.WithoutBuildMetadata(informational)!;
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
    /// PackageReference with a version. <c>Scaffolded</c> is true when that line is the whole
    /// reference in the form eject scaffolds: one element, <c>Include</c> and <c>Version</c>, no children.</summary>
    private static (string Version, int Line, bool Scaffolded)? PinnedCodegenVersion(string csprojPath)
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
            XAttribute a => (a.Value.Trim(), ((IXmlLineInfo)a).LineNumber,
                ((IXmlLineInfo)a).LineNumber == ((IXmlLineInfo)reference!).LineNumber
                && reference.Attributes().Count() == 2 && !reference.Nodes().Any()),
            XElement e => (e.Value.Trim(), ((IXmlLineInfo)e).LineNumber, false),
            _ => null,
        };
    }

    /// <summary>What eject and init say when the owned project pins a package older than the codegen/
    /// files they write: empty when the pin is this tool's version or newer, or cannot be read.</summary>
    /// <param name="command">The command reporting: <c>eject</c> or <c>init</c>.</param>
    internal static IReadOnlyList<string> OlderPinWarning(string csprojPath, string command)
    {
        var tool = ToolVersion();
        if (PinnedCodegenVersion(csprojPath) is not { } pin || !IsOlderVersion(pin.Version, tool)) return [];
        var warning =
            $"warning: codegen/Codegen.csproj pins {PinnedPackage} {pin.Version}, older than the {tool} this " +
            $"{command} writes codegen/ from. Those files are written against the {tool} package API, so the " +
            $"owned project will not compile, or will run the {pin.Version} codegen, until the pin is {tool} or " +
            $"later. {char.ToUpperInvariant(command[0])}{command[1..]} never edits that file: " +
            $"set the version on line {pin.Line} of codegen/Codegen.csproj to {tool}";
        return pin.Scaffolded
            ? ["", warning + ", so the line reads", $"  <PackageReference Include=\"{PinnedPackage}\" Version=\"{tool}\" />"]
            : ["", warning + "."];
    }

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

        // The codegen project (ADR-0034 Amendment 9): each of its three files is written only when
        // missing, the list with the generators just ejected. An existing file is the project's own.
        var csprojPath = Path.Combine(root, "codegen", "Codegen.csproj");
        var csprojExisted = File.Exists(csprojPath);
        var entries = names.Select(n => EjectableGenerators.OwnedListEntry(known[n])).ToList();
        var scaffolded = CodegenScaffold.WriteMissing(root, entries);
        if (scaffolded.Count > 0)
        {
            outLines.Add("");
            outLines.Add($"Also wrote {string.Join(", ", scaffolded)}.");
        }
        if (scaffolded.Contains("codegen/Generators.cs"))
        {
            outLines.Add(
                $"codegen/Generators.cs lists the generator(s) you just ejected ({string.Join(", ", entries)}). " +
                "`dotnet meta gen` and `dotnet meta verify --codegen` run that list.");
        }
        else
        {
            outLines.Add("");
            outLines.Add("codegen/Generators.cs already exists and is yours — eject never edits it. Add:");
            foreach (var entry in entries)
                outLines.Add($"  {entry},");
            outLines.Add("to the list there, in place of the packaged entry if it lists one " +
                          "(MetaObjects.Codegen.Generators.<Name>).");
        }
        if (csprojExisted) outLines.AddRange(OlderPinWarning(csprojPath, "eject"));

        return new Outcome(0, outLines, []);
    }

    /// <summary>
    /// <c>eject --undo</c>: drop owned generator copies that are identical to the shipped ones. With no
    /// <paramref name="names"/> every identical owned copy goes; with names only those, and a copy that
    /// DIFFERS is refused (exit 2, nothing removed) unless <paramref name="force"/>. Every name is
    /// validated before anything is deleted. Companion emitters go only when identical (or forced) and
    /// no remaining owned generator is handed them. The helper runtime counts toward a copy being
    /// identical, so it goes whole when no remaining owned generator's output imports it. It never edits
    /// codegen/Generators.cs or the project: it prints the edit that points each entry back at the
    /// shipped generator.
    /// </summary>
    public static Outcome Undo(IReadOnlyList<string> names, string root, bool force)
    {
        var all = EjectableGenerators.Entries();
        List<GeneratorRegistryEntry> targets;
        if (names.Count == 0)
        {
            targets = OwnedCopy.IdenticalCopies(root).ToList();
            if (targets.Count == 0)
            {
                var owned = all.Where(e => OwnedCopy.Status(root, e) is not null).ToList();
                return new Outcome(0, [owned.Count == 0
                    ? "no owned generator copies under codegen/generators/; nothing to undo."
                    : "no owned copy is identical to its shipped generator, so nothing was removed: " +
                      string.Join("; ", owned.Select(e => $"{e.Name} {OwnedCopy.UndoStatus(root, e)}")) + "."], []);
            }
        }
        else
        {
            var known = all.ToDictionary(e => e.Name, e => e, StringComparer.Ordinal);
            var unknown = names.Where(n => !known.ContainsKey(n)).ToList();
            if (unknown.Count > 0)
                return Outcome.Usage(
                    $"unknown or non-ejectable generator(s): {string.Join(", ", unknown)}. " +
                    $"Nothing was removed. Ejectable: {string.Join(", ", EjectableNames())}.");
            targets = names.Distinct(StringComparer.Ordinal).Select(n => known[n]).ToList();
            var notOwned = targets.Where(e => OwnedCopy.Status(root, e) is null).Select(e => e.Name).ToList();
            if (notOwned.Count > 0)
                return Outcome.Usage(
                    $"no owned copy of: {string.Join(", ", notOwned)} under codegen/generators/. Nothing was removed.");
            var differs = targets.Where(e => OwnedCopy.UndoStatus(root, e) != "identical").ToList();
            if (differs.Count > 0 && !force)
                return Outcome.Usage(
                    "not removed (nothing was changed): " +
                    string.Join("; ", differs.Select(e => $"{e.Name} {OwnedCopy.UndoStatus(root, e)}")) +
                    ". Undo drops only copies identical to the shipped generator; `dotnet meta gen --list` " +
                    "shows how each one differs. Pass --force to discard your edits.");
        }

        var generatorsDir = Path.Combine(root, "codegen", "generators");
        var gone = targets.Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        var remaining = all.Where(e => !gone.Contains(e.Name) && OwnedCopy.Status(root, e) is not null).ToList();
        var lines = new List<string>();

        foreach (var t in targets)
        {
            File.Delete(Path.Combine(generatorsDir, t.SourceFileName!));
            lines.Add($"removed codegen/generators/{t.SourceFileName} (\"{t.Name}\")");
        }
        foreach (var sourcePath in targets.SelectMany(t => t.Companions).Distinct(StringComparer.Ordinal))
        {
            var relative = EjectableGenerators.OwnedRelativePath(sourcePath);
            var path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(path)) continue;
            if (remaining.FirstOrDefault(e => e.Companions.Contains(sourcePath)) is { } user)
                lines.Add($"  kept {relative} — \"{user.Name}\" is still owned and uses it");
            else if (!force && OwnedCopy.Compare(File.ReadAllText(path),
                         EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSourcePath(sourcePath))).Verdict
                     != OwnedCopy.Verdict.Identical)
                lines.Add($"  kept {relative} — it differs from the shipped one, so it is yours");
            else
            {
                File.Delete(path);
                lines.Add($"  removed {relative}");
            }
        }

        var runtimeUsers = targets.Where(t => HelperRuntime.UsedBy(EjectableGenerators.ReadSource(t.Name)!)).ToList();
        var runtimeDir = Path.Combine(root, HelperRuntime.OwnedDirectory.Replace('/', Path.DirectorySeparatorChar));
        var runtimeRemoved = false;
        if (runtimeUsers.Count > 0 && Directory.Exists(runtimeDir))
        {
            if (remaining.FirstOrDefault(e => HelperRuntime.UsedBy(EjectableGenerators.ReadSource(e.Name)!)) is { } user)
                lines.Add($"  kept {HelperRuntime.OwnedDirectory}/ — \"{user.Name}\" is still owned and uses it");
            else
            {
                foreach (var file in HelperRuntime.Files)
                {
                    var path = Path.Combine(runtimeDir, file);
                    if (!File.Exists(path)) continue;
                    File.Delete(path);
                    lines.Add($"  removed {HelperRuntime.OwnedDirectory}/{file}");
                    runtimeRemoved = true;
                }
                if (!Directory.EnumerateFileSystemEntries(runtimeDir).Any()) Directory.Delete(runtimeDir);
            }
        }
        if (Directory.Exists(generatorsDir) && !Directory.EnumerateFileSystemEntries(generatorsDir).Any())
            Directory.Delete(generatorsDir);

        lines.Add("");
        lines.Add("codegen/Generators.cs is yours — undo never edits it. Point each entry back at the shipped " +
                  "generator (the project does not compile until you do):");
        foreach (var t in targets)
            lines.Add($"  replace  {EjectableGenerators.OwnedListEntry(t)}  with  {GeneratorRegistry.ListEntry(t)}");
        if (runtimeRemoved)
            lines.Add($"The helper runtime copy is gone: drop the `<Compile Include=\".../{HelperRuntime.OwnedDirectory}/**/*.cs\" />` " +
                      $"line from the project that compiled it, and register the timestamp converter from " +
                      $"`{HelperRuntime.PackagedNamespace}` again.");
        return new Outcome(0, lines, []);
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
