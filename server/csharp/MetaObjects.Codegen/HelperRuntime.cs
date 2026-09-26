// ADR-0034 Amendment 3 — the HELPER RUNTIME an ejected generator's output depends on.
//
// The packaged generated routes import `MetaObjects.Codegen.Runtime` for the filter
// parser, the EF Core filter dispatch, the value-object validator and the constraint-error
// mapping. Those are not core: their only callers are generated route files, which are
// helpers. An adopter who ejects the routes generator therefore has to own them too, or a
// defect in one of them still means waiting for a MetaObjects release. So `dotnet meta
// eject routes` also copies their SOURCE into codegen/runtime/, under the namespace
// `Codegen.Runtime` (folder and namespace line up the way codegen/generators/ and
// `Codegen.Generators` do), and the ejected generator emits `using Codegen.Runtime;`.
//
// WHAT STAYS IN THE PACKAGE (core, never copied):
//   - ExtractObject — the reply parser the output-parser/extractor modules delegate to.
//   - M2MResolver   — metadata-driven M:N traversal (runtime metadata access); no
//                     generated file calls it.
// Every file under Runtime/ is classified as one or the other (HelperRuntimeTests fails
// on an unclassified file), and the helper set is CLOSED: it compiles on its own against
// ASP.NET Core + EF Core, with no MetaObjects assembly referenced.
//
// The files ship embedded (the same AOT-safe pattern EjectableGenerators uses — the tool
// has no source tree on disk), byte-identity-gated against Runtime/<file>.

namespace MetaObjects.Codegen;

public static class HelperRuntime
{
    /// <summary>The namespace the packaged helper runtime lives in.</summary>
    public const string PackagedNamespace = "MetaObjects.Codegen.Runtime";

    /// <summary>The namespace an owned copy lives in, matching its folder
    /// (<see cref="OwnedDirectory"/>), the way <c>codegen/generators/</c> is
    /// <c>Codegen.Generators</c>.</summary>
    public const string OwnedNamespace = "Codegen.Runtime";

    /// <summary>Where eject writes the owned copy, relative to the project root.</summary>
    public const string OwnedDirectory = "codegen/runtime";

    /// <summary>Logical-resource-name prefix of the embedded copies (MSBuild's default:
    /// RootNamespace + folder).</summary>
    public const string ResourcePrefix = "MetaObjects.Codegen.Runtime.";

    /// <summary>
    /// The one line a generator declares when its OUTPUT imports the helper runtime. Its
    /// presence is what makes eject copy the runtime alongside the generator, and it is the
    /// line eject rewrites (<see cref="RewriteGeneratorForEject"/>) so the owned copy's
    /// output imports <see cref="OwnedNamespace"/> instead.
    /// </summary>
    public const string GeneratorMarkerLine =
        "private const string HelperRuntimeNamespace = \"" + PackagedNamespace + "\";";

    private const string OwnedMarkerLine =
        "private const string HelperRuntimeNamespace = \"" + OwnedNamespace + "\";";

    /// <summary>
    /// The helper files, in the order eject reports them. Each is referenced by generated
    /// routes except <c>Iso8601TimestampConverter.cs</c>, which the host registers to give
    /// those routes the api contract's timestamp spelling — it serves the same wire, so
    /// the adopter owns it with them.
    /// </summary>
    public static readonly IReadOnlyList<string> Files =
    [
        "FilterParser.cs",
        "FilterParseResult.cs",
        "FilterPredicate.cs",
        "EfCoreFilterDispatch.cs",
        "ValueObjectValidator.cs",
        "ConstraintErrors.cs",
        "Iso8601TimestampConverter.cs",
    ];

    /// <summary>Runtime/ files that are CORE and never copied (see the header).</summary>
    public static readonly IReadOnlyList<string> CoreFiles = ["ExtractObject.cs", "M2MResolver.cs"];

    /// <summary>True iff a generator's source declares <see cref="GeneratorMarkerLine"/>,
    /// i.e. its output imports the helper runtime.</summary>
    public static bool UsedBy(string generatorSource) =>
        generatorSource.Contains(GeneratorMarkerLine, StringComparison.Ordinal);

    /// <summary>Point an ejected generator's output at the owned runtime copy. A no-op for
    /// a generator whose output does not use the helper runtime.</summary>
    public static string RewriteGeneratorForEject(string generatorSource) =>
        generatorSource.Replace(GeneratorMarkerLine, OwnedMarkerLine, StringComparison.Ordinal);

    /// <summary>The embedded packaged source of a helper runtime file.</summary>
    public static string ReadSourceFile(string fileName)
    {
        var resource = ResourcePrefix + fileName;
        using var stream = typeof(HelperRuntime).Assembly.GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException(
                $"embedded resource missing: {resource} — add <EmbeddedResource " +
                $"Include=\"Runtime/{fileName}\" /> to MetaObjects.Codegen.csproj.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private const string PackagedNamespaceDecl = "namespace " + PackagedNamespace + ";";

    /// <summary>
    /// The one edit eject makes to a helper runtime file: its namespace, from
    /// <see cref="PackagedNamespace"/> to <see cref="OwnedNamespace"/>. Everything else is
    /// verbatim. Renaming is what keeps the copy from colliding with the package's types
    /// in an app that still references <c>MetaObjects.Codegen</c> (CS0433).
    /// </summary>
    public static string RewriteForEject(string source)
    {
        var idx = source.IndexOf(PackagedNamespaceDecl, StringComparison.Ordinal);
        if (idx < 0)
            throw new InvalidOperationException(
                "helper runtime source has no \"" + PackagedNamespaceDecl + "\" line to rewrite. " +
                "This is a packaging defect, not a user error.");
        return source[..idx] + "namespace " + OwnedNamespace + ";" + source[(idx + PackagedNamespaceDecl.Length)..];
    }

    /// <summary>What eject writes for <paramref name="fileName"/>: the embedded source,
    /// rewritten.</summary>
    public static string OwnedReference(string fileName) => RewriteForEject(ReadSourceFile(fileName));
}
