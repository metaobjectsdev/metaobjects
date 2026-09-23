// ADR-0034 Amendment 3 / docs/superpowers/specs/2026-09-22-eject-in-every-port-design.md
// (C# section) — the embedded-resource surface `dotnet meta eject` reads from.
//
// The tool ships COMPILED: there is no source tree on disk beside `dotnet-meta` for an
// eject command to copy from. So every ejectable generator's own .cs file is embedded
// as an assembly resource (MetaObjects.Codegen.csproj's EmbeddedResource item group —
// the same AOT-safe pattern MetaObjects/MetaObjects.csproj already uses for
// spec/metamodel/*.json), and this class is the one place that reads them. A byte-
// identity test (MetaObjects.Codegen.Tests/EjectableGeneratorsTests) asserts every
// embedded copy matches its Generators/<file> source, so they cannot drift.

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

    // The exact line every ejectable generator source declares (verified by
    // RewriteForEject_runs_clean_on_every_real_ejectable_source).
    private const string PackagedNamespaceDecl = "namespace MetaObjects.Codegen.Generators;";

    /// <summary>
    /// The one edit <c>dotnet meta eject</c> makes to a generator's embedded source
    /// before writing it into an adopter's repo: rename its namespace from the packaged
    /// <c>MetaObjects.Codegen.Generators</c> to <c>Codegen.Generators</c> (the adopter's
    /// own <c>codegen/</c> project — matching its directory, <c>codegen/generators/</c>),
    /// adding the THREE <c>using</c> directives that namespace's enclosing-namespace
    /// lookup used to supply for free: code in <c>MetaObjects.Codegen.Generators</c>
    /// resolves an unqualified <c>GenConfig</c> / <c>IGenerator</c> / <c>ValueObjectNames</c>
    /// / <c>Fr010FieldMapping</c> / <c>NamingRefs</c> / … via C#'s enclosing-namespace
    /// fallback (a name unresolved in <c>A.B.C</c> is looked up in <c>A.B</c>, then
    /// <c>A</c>, then globally — so <c>MetaObjects.Codegen.Generators</c> reaches
    /// <c>MetaObjects.Codegen</c> AND top-level <c>MetaObjects</c> unqualified);
    /// <c>Codegen.Generators</c> is an unrelated tree and gets none of that fallback, so
    /// the copy needs all three directives spelled out. Every other line is untouched —
    /// this is the ONLY edit eject makes.
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
        var idx = source.IndexOf(PackagedNamespaceDecl, StringComparison.Ordinal);
        if (idx < 0)
            throw new InvalidOperationException(
                "ejectable generator source has no \"" + PackagedNamespaceDecl +
                "\" line to rewrite — cannot eject it safely. This is a packaging defect, " +
                "not a user error: every embedded generator source must declare that exact " +
                "namespace line.");
        const string replacement =
            "using MetaObjects;\n" +
            "using MetaObjects.Codegen;\n" +
            "using MetaObjects.Codegen.Generators;\n" +
            "\n" +
            "namespace Codegen.Generators;";
        return source[..idx] + replacement + source[(idx + PackagedNamespaceDecl.Length)..];
    }
}
