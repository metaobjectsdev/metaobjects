// shared-model — publishes a project's shared model (FR-023): a flattened, canonical-JSON artifact
// <name>.metaobjects.json plus the manifest metaobjects.pkg.json that pins it, for a consumer's
// `meta deps sync`. The consumer's `meta deps check` / `dotnet meta verify --deps` then compares the two.
//
// This file decides what belongs to the PUBLISHING PROJECT: which of its source files may contribute
// (Files), which nodes are published (Include / Exclude, plus Requirements to add the selected
// requirement.* nodes) and which version is recorded (Version, else the
// project's <Version>). Everything a consumer checks is MetaObjects.Config.SharedModel's, in the package:
// what is selected, that the selection is closed, the document's bytes, the hash over them and the
// manifest's shape and file names. It is a reference helper (ADR-0034 Amendment 3): `dotnet meta eject
// shared-model` copies this one file into your project, and the artifact bytes stay in the package, because
// a copy that changed them would publish a model a consumer's sync refuses, or accepts and cannot load.
//
// OPTIONS are public init properties, set where the generator is declared in codegen/Generators.cs:
//
//     new SharedModelGenerator
//     {
//         ModelName = "acme-common",
//         Include = ["acme::common::**"],
//         Files = ["metaobjects/meta.common.json"],
//         OutDir = "shared",
//     }
//
// Writes nothing and says why (an exception naming the option to change) when the selection is empty, is
// not closed over `extends` and reference attributes, or needs vocabulary outside the library's.

using System.Xml.Linq;
using MetaObjects.Config;
using MetaObjects.Meta;

namespace MetaObjects.Codegen.Generators;

/// <summary>Publishes a shared model: the artifact and the manifest that pins it (FR-023).</summary>
public class SharedModelGenerator : IGenerator
{
    public string Name => "shared-model";

    /// <summary>Where the artifact and the manifest are written. Give it a directory that holds nothing else:
    /// <c>verify --codegen</c> compares the whole tree. <c>null</c> writes under the run's <c>--out</c>.</summary>
    public string? OutDir { get; init; }

    /// <summary>The dependency key a consumer syncs under. The artifact is <c>&lt;ModelName&gt;.metaobjects.json</c>.
    /// Required.</summary>
    public string? ModelName { get; init; }

    /// <summary>Scope patterns naming what to publish, such as <c>acme::common::**</c> (the grammar of
    /// <c>scope</c>). Required: an empty list would publish everything by accident.</summary>
    public IReadOnlyList<string> Include { get; init; } = [];

    /// <summary>Scope patterns removed from <see cref="Include"/>.</summary>
    public IReadOnlyList<string> Exclude { get; init; } = [];

    /// <summary>The metadata files that may contribute, relative to the project root. Required. They load
    /// standalone: a node in a file not named here cannot be published, and one the selection refers to
    /// must be in a named file.</summary>
    public IReadOnlyList<string> Files { get; init; } = [];

    /// <summary>The version recorded in the manifest. Default: the <c>&lt;Version&gt;</c> of the project (read
    /// from its project file, else the nearest <c>Directory.Build.props</c>).</summary>
    public string? Version { get; init; }

    /// <summary>Your own vocabulary providers, so attributes they register load here as they did for the
    /// project's main load. The artifact must still load WITHOUT them: a consumer does not have them.</summary>
    public IReadOnlyList<IMetaDataTypeProvider>? Providers { get; init; }

    /// <summary>Publish the selected <c>requirement.*</c> nodes too, so a consumer can inherit them. Default
    /// false: shapes only. <c>template.*</c> is never published.</summary>
    public bool Requirements { get; init; }

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var name = Required(ModelName, nameof(ModelName), "the dependency key a consumer will sync under");
        if (Include.Count == 0) throw Missing(nameof(Include), "the scope patterns to publish, such as acme::common::**");
        if (Files.Count == 0) throw Missing(nameof(Files), "the metadata files that may contribute");

        var projectRoot = ctx.Config.InputRoot ?? ctx.Config.ProjectRoot ?? Directory.GetCurrentDirectory();
        var model = SharedModel.Build(new SharedModelInput(
            name,
            Files.Select(f => Path.GetFullPath(f, projectRoot)).ToList(),
            Include, Exclude, Providers, Requirements));

        // Resolved after the selection has passed every check, so a model that cannot be published says
        // so before a missing version does.
        var version = Version?.Trim() is { Length: > 0 } explicitVersion
            ? explicitVersion
            : ProjectVersion(projectRoot)
              ?? throw new InvalidOperationException(
                  $"shared-model \"{name}\": no version available - set Version on the generator, or give the " +
                  $"project a <Version> in its project file or Directory.Build.props (looked from {projectRoot}).");

        var files = SharedModel.Render(model, version);
        return [new EmittedFile(files.ArtifactPath, files.Artifact), new EmittedFile(files.ManifestPath, files.Manifest)];
    }

    private static string Required(string? value, string option, string what) =>
        string.IsNullOrWhiteSpace(value) ? throw Missing(option, what) : value.Trim();

    private static InvalidOperationException Missing(string option, string what) =>
        new($"shared-model: set {option} on the generator ({what}): new SharedModelGenerator {{ {option} = ... }}");

    /// <summary>The <c>&lt;Version&gt;</c> the project builds with: the project file in the root, then
    /// <c>Directory.Build.props</c> in the root or the nearest directory above it. <c>null</c> when none declares one,
    /// or when the one that does is an MSBuild expression (<c>$(...)</c>) this generator does not evaluate.</summary>
    private static string? ProjectVersion(string projectRoot)
    {
        var declared = DeclaredVersion(projectRoot);
        return declared is null || declared.Contains("$(", StringComparison.Ordinal) ? null : declared;
    }

    private static string? DeclaredVersion(string projectRoot)
    {
        foreach (var project in Directory.EnumerateFiles(projectRoot, "*.csproj").Order(StringComparer.Ordinal))
            if (VersionIn(project) is { } own) return own;
        for (var dir = new DirectoryInfo(projectRoot); dir is not null; dir = dir.Parent)
            if (VersionIn(Path.Combine(dir.FullName, "Directory.Build.props")) is { } inherited) return inherited;
        return null;
    }

    private static string? VersionIn(string file)
    {
        if (!File.Exists(file)) return null;
        // The MSBuild property: <Version> directly under an unconditional <PropertyGroup>, never a
        // <PackageReference>'s <Version> child.
        var version = XDocument.Load(file).Root?.Elements()
            .Where(g => g.Name.LocalName == "PropertyGroup" && g.Attribute("Condition") is null)
            .SelectMany(g => g.Elements())
            .FirstOrDefault(e => e.Name.LocalName == "Version" && e.Attribute("Condition") is null)?.Value.Trim();
        return string.IsNullOrEmpty(version) ? null : version;
    }
}
