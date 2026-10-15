// ADR-0034 Amendment 3 / docs/superpowers/specs/2026-09-22-eject-in-every-port-design.md
// (C# section) — the embedded-resource surface `dotnet meta eject` reads from.
//
// The tool ships COMPILED: there is no source tree on disk beside `dotnet-meta` for an
// eject command to copy from. So every ejectable generator's own .cs file, and the emitter
// files its registry entry hands over with it (Companions), are embedded as assembly
// resources (MetaObjects.Codegen.csproj's EmbeddedResource item group — the same AOT-safe
// pattern MetaObjects/MetaObjects.csproj already uses for spec/metamodel/*.json), and this
// class is the one place that reads them. A byte-identity test
// (MetaObjects.Codegen.Tests/EjectableGeneratorsTests) asserts every embedded copy matches
// its source file, so they cannot drift.

using System.Reflection;

namespace MetaObjects.Codegen;

public static class EjectableGenerators
{
    /// <summary>
    /// The logical-resource-name prefix every ejectable generator's embedded copy is
    /// stored under — MSBuild's default naming (RootNamespace + folder path, dots for
    /// separators; RootNamespace is <c>MetaObjects.Codegen</c> for this assembly).
    /// </summary>
    public const string ResourcePrefix = "MetaObjects.Codegen.Generators.";

    /// <summary>The namespace every ejected copy is rewritten into (<see cref="RewriteForEject"/>):
    /// an owned generator is listed in <c>codegen/Generators.cs</c> as
    /// <c>Codegen.Generators.&lt;Name&gt;</c>.</summary>
    public const string OwnedNamespace = "Codegen.Generators";

    /// <summary>The expression that lists the OWNED copy of <paramref name="entry"/> in
    /// <c>codegen/Generators.cs</c>: <see cref="GeneratorRegistry.ListEntry"/> with the packaged
    /// namespace swapped for <see cref="OwnedNamespace"/>, since eject keeps the class name.</summary>
    public static string OwnedListEntry(GeneratorRegistryEntry entry) =>
        GeneratorRegistry.ListEntry(entry).Replace("MetaObjects.Codegen.Generators.", OwnedNamespace + ".", StringComparison.Ordinal);

    /// <summary>
    /// Every ejectable registry entry (<see cref="GeneratorRegistryEntry.SourceFileName"/>
    /// is set) — Native-tier order, matching <see cref="GeneratorRegistry.List"/>. The
    /// <c>template</c> primitive is excluded: it has no emit logic of its own to own.
    /// </summary>
    public static IReadOnlyList<GeneratorRegistryEntry> Entries() =>
        GeneratorRegistry.List().Where(e => e.SourceFileName is not null).ToList();

    /// <summary>The embedded source for the ejectable entry named <paramref name="name"/>
    /// (a stable registry id, e.g. <c>"entity"</c>), or <c>null</c> when <paramref
    /// name="name"/> is unknown or not ejectable.</summary>
    public static string? ReadSource(string name) =>
        GeneratorRegistry.Get(name) is { SourceFileName: { } file } ? ReadSourceFile(file) : null;

    /// <summary>
    /// The embedded source text for a <c>Generators/&lt;fileName&gt;</c> source file.
    /// Throws if the resource is missing — a packaging defect (a new ejectable entry
    /// whose <c>&lt;EmbeddedResource&gt;</c> item was never added), never a user input
    /// error, since every caller resolves <paramref name="fileName"/> from the registry
    /// first.
    /// </summary>
    public static string ReadSourceFile(string fileName)
    {
        var resource = ResourcePrefix + fileName;
        var asm = typeof(EjectableGenerators).Assembly;
        using var stream = asm.GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException(
                $"embedded resource missing: {resource} — add <EmbeddedResource " +
                $"Include=\"Generators/{fileName}\" /> to MetaObjects.Codegen.csproj.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    /// <summary>The package directories whose sources eject hands over, each a namespace
    /// <c>MetaObjects.Codegen.&lt;Dir&gt;</c> in the package. Every handed-over file lands in the one
    /// owned namespace <c>Codegen.Generators</c>, beside the generators (<see cref="OwnedRelativePath"/>):
    /// an owned generator and the emitters it was handed then see each other as members of the
    /// namespace they are in, which wins over the package's types of the same name that the
    /// <c>using</c> directives bring in.</summary>
    public static readonly IReadOnlyList<string> SourceDirectories = ["Generators", "Docs", "ApiDocs"];

    /// <summary>The package-relative paths eject writes for <paramref name="entry"/>: its own
    /// source first, then its <see cref="GeneratorRegistryEntry.Companions"/>. Empty for a
    /// generator that is not ejectable.</summary>
    public static IReadOnlyList<string> SourcePaths(GeneratorRegistryEntry entry) =>
        entry.SourceFileName is { } file ? ["Generators/" + file, .. entry.Companions] : [];

    /// <summary>Every package-relative source path any ejectable entry hands over, once each.</summary>
    public static IReadOnlyList<string> AllSourcePaths() =>
        Entries().SelectMany(SourcePaths).Distinct(StringComparer.Ordinal).ToList();

    /// <summary>The embedded copy's logical resource name — MSBuild's default for
    /// <c>&lt;dir&gt;/&lt;file&gt;</c> under RootNamespace <c>MetaObjects.Codegen</c>.</summary>
    public static string ResourceName(string sourcePath) =>
        "MetaObjects.Codegen." + sourcePath.Replace('/', '.');

    /// <summary>Where an owned copy of <paramref name="sourcePath"/> lands, relative to the
    /// project root: <c>codegen/generators/&lt;file&gt;</c>, whichever package directory it came from.</summary>
    public static string OwnedRelativePath(string sourcePath) =>
        "codegen/generators/" + sourcePath[(sourcePath.LastIndexOf('/') + 1)..];

    /// <summary>The embedded packaged source at <paramref name="sourcePath"/>. Throws if
    /// the resource is missing — a packaging defect, never a user error: every caller takes
    /// the path from the registry.</summary>
    public static string ReadSourcePath(string sourcePath)
    {
        var resource = ResourceName(sourcePath);
        using var stream = typeof(EjectableGenerators).Assembly.GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException(
                $"embedded resource missing: {resource} — add <EmbeddedResource " +
                $"Include=\"{sourcePath}\" /> to MetaObjects.Codegen.csproj.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    // The namespace line every ejectable source declares: `namespace MetaObjects.Codegen.<Dir>;`
    // (verified by RewriteForEject_runs_clean_on_every_real_ejectable_source).
    private static readonly System.Text.RegularExpressions.Regex PackagedNamespaceDecl = new(
        @"^namespace MetaObjects\.Codegen\.(?<dir>Generators|Docs|ApiDocs);",
        System.Text.RegularExpressions.RegexOptions.Multiline | System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>
    /// The edits <c>dotnet meta eject</c> makes to an embedded source before writing it into an
    /// adopter's repo: rename its namespace from the packaged <c>MetaObjects.Codegen.&lt;Dir&gt;</c>
    /// to <c>Codegen.Generators</c> (the adopter's own <c>codegen/</c> project — matching its
    /// directory, <c>codegen/generators/</c>), adding the THREE <c>using</c> directives that
    /// namespace's enclosing-namespace lookup used to supply for free: code in
    /// <c>MetaObjects.Codegen.Generators</c> resolves an unqualified <c>GenConfig</c> /
    /// <c>IGenerator</c> / <c>ValueObjectNames</c> / <c>FindInbound</c> / <c>NamingRefs</c> / …
    /// via C#'s enclosing-namespace fallback (a name unresolved in <c>A.B.C</c> is looked up in
    /// <c>A.B</c>, then <c>A</c>, then globally — so <c>MetaObjects.Codegen.Generators</c> reaches
    /// <c>MetaObjects.Codegen</c> AND top-level <c>MetaObjects</c> unqualified);
    /// <c>Codegen.Generators</c> is an unrelated tree and gets none of that fallback, so the copy
    /// needs all three directives spelled out (each only when the source does not already say it).
    /// A <c>using MetaObjects.Codegen.Docs;</c> or <c>using MetaObjects.Codegen.ApiDocs;</c> is
    /// dropped: what it named is in the copy's own namespace now.
    /// <para>
    /// The SECOND edit applies only to a generator whose output imports the helper
    /// runtime (<see cref="HelperRuntime.UsedBy"/> — today, routes): its
    /// <c>HelperRuntimeNamespace</c> constant moves from <c>MetaObjects.Codegen.Runtime</c>
    /// to <c>Codegen.Runtime</c>, the owned copy eject writes beside it
    /// (<see cref="HelperRuntime"/>). Every other line is untouched.
    /// </para>
    /// <para>
    /// WHY A RENAME AT ALL. An ejected copy compiles into the ADOPTER's own assembly
    /// (<c>codegen/Codegen.csproj</c>), which also references the packaged
    /// <c>MetaObjects.Codegen</c> assembly (for whichever generators the adopter did NOT
    /// eject). If the copy kept the packaged namespace, both assemblies would declare a
    /// type named <c>MetaObjects.Codegen.Generators.&lt;Name&gt;</c>, and the unqualified
    /// use <c>codegen/Program.cs</c> needs — <c>new EntityGenerator()</c> — would be
    /// CS0433: "the type exists in both assemblies". Renaming the copy's namespace is
    /// the only way for one Program.cs to reference BOTH the packaged generators and an
    /// owned copy without that collision.
    /// </para>
    /// </summary>
    public static string RewriteForEject(string source)
    {
        var match = PackagedNamespaceDecl.Match(source);
        if (!match.Success)
            throw new InvalidOperationException(
                "ejectable source has no \"namespace MetaObjects.Codegen.<Generators|Docs|ApiDocs>;\" " +
                "line to rewrite — cannot eject it safely. This is a packaging defect, " +
                "not a user error: every embedded source must declare one of those namespace lines.");
        var usings = new[] { "MetaObjects", "MetaObjects.Codegen", "MetaObjects.Codegen.Generators" }
            .Where(ns => !source.Contains($"using {ns};", StringComparison.Ordinal))
            .Select(ns => $"using {ns};\n");
        var replacement = string.Concat(usings) + $"\nnamespace {OwnedNamespace};";
        var rewritten = source[..match.Index] + replacement + source[(match.Index + match.Length)..];
        rewritten = DroppedUsings.Replace(rewritten, "");
        return HelperRuntime.RewriteGeneratorForEject(rewritten);
    }

    private static readonly System.Text.RegularExpressions.Regex DroppedUsings = new(
        @"^using MetaObjects\.Codegen\.(Docs|ApiDocs);\r?\n",
        System.Text.RegularExpressions.RegexOptions.Multiline | System.Text.RegularExpressions.RegexOptions.Compiled);
}
