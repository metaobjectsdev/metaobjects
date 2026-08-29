// `dotnet meta gen` — generate idiomatic C# (EF Core) code from metadata.
//
// Loads metadata from a directory and runs the codegen generator set, writing
// files under the @generated-header guard. Generated today: EF Core entity
// classes + a DbContext. Routes / projections / migrations layer on next.

using System.IO;
using System.Text.Json;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Codegen.TemplateCodegen;
using MetaObjects.Loader;
using MetaObjects.Render;

namespace MetaObjects.Cli;

/// <summary>The gen command's pure logic (no console I/O), so it is testable.</summary>
public static class GenCommand
{
    public sealed record Outcome(IReadOnlyList<string> LoadErrors, CodegenRunner.RunResult? Result)
    {
        public bool Ok => LoadErrors.Count == 0 && Result is not null;
    }

    /// <summary>
    /// The default C# namespace generated code lands in when <c>--namespace</c> is omitted.
    /// Shared by <c>dotnet meta gen</c> and <c>dotnet meta docs</c> so the documented
    /// <c>using &lt;ns&gt;;</c> import lines match what an adopter writes against generated code.
    /// </summary>
    public const string DefaultNamespace = "Generated";

    /// <summary>
    /// The default generator suite's stable names (ADR-0021 D3). Brought to parity
    /// with the Python default (entity / router / filter-allowlist / payload /
    /// output-parser / output-prompt / extractor): the C# suite is
    /// <c>entity</c>, <c>db-context</c>, <c>routes</c>, <c>filter-allowlist</c>,
    /// <c>payload</c>, <c>output-parser</c>, <c>output-prompt</c>, <c>extractor</c>.
    /// The <c>render-helper</c> generator is intentionally NOT in the default suite —
    /// it requires <c>--template-root</c> for its build-time drift gate (matching the
    /// Python default, which also excludes the render helper). <c>template</c> /
    /// <c>callable</c> stay opt-in (config-only / FR-015 niche). Every default name is
    /// a registered generator, selectable individually via <c>--generators</c>.
    /// </summary>
    public static readonly IReadOnlyList<string> DefaultGeneratorNames =
        ["entity", "db-context", "routes", "filter-allowlist", "payload", "output-parser", "output-prompt", "extractor"];

    /// <summary>The default generator set, built from the registry by stable name.</summary>
    public static IReadOnlyList<IGenerator> DefaultGenerators() =>
        GeneratorRegistry.Resolve(DefaultGeneratorNames);

    public static Outcome Run(string metadataDir, string outDir, string ns, bool emitAbstractShapes = false) =>
        Run(metadataDir, outDir, ns, emitAbstractShapes, generatorNames: null, templateRoot: null);

    /// <summary>
    /// Run codegen selecting generators by stable name. When
    /// <paramref name="generatorNames"/> is null/empty the default suite runs
    /// (back-compat). An unknown name (or a render-helper selected without a
    /// <paramref name="templateRoot"/>) surfaces as a load-style error in the
    /// returned <see cref="Outcome"/> rather than throwing.
    ///
    /// <para>SP-1: <paramref name="templateSpecPath"/> points at a JSON template-spec
    /// (the cross-port declarative Mustache surface). Its generators are appended to
    /// the suite, resolving templates under <paramref name="templateRoot"/>. NOTE:
    /// template output participates in the standard <c>@generated</c>-marker overwrite
    /// policy — to be regenerable on a second run, a template should emit the
    /// <c>@generated</c> header itself (the template author's responsibility).</para>
    /// </summary>
    public static Outcome Run(
        string metadataDir, string outDir, string ns, bool emitAbstractShapes,
        IReadOnlyList<string>? generatorNames, string? templateRoot, string? templateSpecPath = null,
        ColumnNamingStrategy columnNaming = ColumnNamingStrategy.Literal)
        => Run(MetaDataLoader.FromDirectory(metadataDir), outDir, ns, emitAbstractShapes,
            generatorNames, templateRoot, templateSpecPath, ProjectRootFor(metadataDir), columnNaming);

    /// <summary>
    /// The project a metadata directory belongs to: its PARENT, i.e. the directory
    /// holding <c>metaobjects/</c>. Same rule as the Python port's
    /// <c>gen_state_dir_for</c>, and for the same reason — anchoring tool state on
    /// <c>Directory.GetCurrentDirectory()</c> scatters a stray <c>.metaobjects/</c>
    /// into whatever directory the process happens to sit in, and leaves the real
    /// project with no record of what was written.
    /// </summary>
    public static string ProjectRootFor(string metadataDir) =>
        Path.GetDirectoryName(Path.GetFullPath(metadataDir)) ?? Directory.GetCurrentDirectory();

    /// <summary>
    /// Same as the <c>metadataDir</c> overload above, but starting from an
    /// ALREADY-LOADED <paramref name="load"/> — used by the CLI's
    /// <c>.metaobjects/config.json</c> ladder path (<c>Program.cs</c>'s
    /// <c>ResolveMetadataDirOrExit</c>), which resolves AND loads the declared
    /// source set itself via <see cref="MetaDataLoader.FromUris(System.Collections.Generic.IReadOnlyList{Uri})"/>
    /// (honoring the <c>_pending</c>-draft exclusion <c>SourceResolver</c> applies).
    /// Calling <see cref="MetaDataLoader.FromDirectory(string, DirectorySource.Options?, bool)"/>
    /// again here would re-walk the directory tree a second time AND silently lose
    /// that exclusion (<c>FromDirectory</c>'s own default is to include <c>_pending</c>).
    /// </summary>
    public static Outcome Run(
        LoadResult load, string outDir, string ns, bool emitAbstractShapes,
        IReadOnlyList<string>? generatorNames, string? templateRoot, string? templateSpecPath = null,
        string? projectRoot = null,
        ColumnNamingStrategy columnNaming = ColumnNamingStrategy.Literal)
    {
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
        if (loadErrors.Count > 0)
            return new Outcome(loadErrors, null);

        var names = generatorNames is { Count: > 0 } ? generatorNames : DefaultGeneratorNames;
        List<IGenerator> generators;
        try
        {
            generators = GeneratorRegistry.Resolve(names, new GeneratorBuildContext(templateRoot)).ToList();
            if (!string.IsNullOrEmpty(templateSpecPath))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(templateSpecPath));
                var spec = TemplateSpec.Parse(doc.RootElement);
                var provider = new FilesystemProvider(templateRoot ?? "templates");
                generators.AddRange(TemplateSpec.ToGenerators(spec, provider));
            }
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException)
        {
            return new Outcome([ex.Message], null);
        }

        // The hash manifest lives beside the project's other tool state, matching the TS
        // and Python layout. Supplying it here is what gives a real `dotnet meta gen`
        // hand-edit detection: without it the write path falls back to the legacy
        // <auto-generated/>-marker rule, which cannot tell an edited generated file from a
        // pristine one (an edited file keeps its marker). COMMIT `.gen-state/.hashes.json`.
        //
        // `projectRoot` is the PROJECT, never the process's cwd — see ProjectRootFor.
        // It falls back to cwd only for a caller that passes an already-loaded model and
        // names no project, which is the one case where there is nothing better to use.
        var genStateDir = Path.Combine(
            projectRoot ?? Directory.GetCurrentDirectory(), ".metaobjects", ".gen-state");
        var config = new GenConfig
        {
            OutDir = outDir,
            Namespace = ns,
            EmitAbstractShapes = emitAbstractShapes,
            GenStateDir = genStateDir,
            // How a field with no explicit `@column` becomes a column name. Defaults to
            // Literal (EF's property=column convention) — this port's historical
            // behaviour — and is selected per project with `--column-naming`.
            ColumnNamingStrategy = columnNaming,
        };
        CodegenRunner.RunResult result;
        try
        {
            result = CodegenRunner.Run(config, load.Root, generators);
        }
        catch (RenderException ex)
        {
            // A bad template ref / wrong --template-root surfaces as a clean error, not a stack trace.
            return new Outcome([$"template render failed: {ex.Message}"], null);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // An output-pattern error (unknown placeholder, or {name}/{Name} under a
            // perPackage/perModel scope) or a duplicate output-path collision surfaces
            // lazily during the walk — a clean error, not a stack trace.
            return new Outcome([$"codegen failed: {ex.Message}"], null);
        }
        return new Outcome(loadErrors, result);
    }

    /// <summary>
    /// The lines `dotnet meta gen --list` prints: one `&lt;stable-name&gt; — &lt;description&gt;`
    /// per registered generator, native first. Pure (no console I/O) for testing.
    /// </summary>
    public static IReadOnlyList<string> ListLines() =>
        GeneratorRegistry.List()
            .Select(e => $"  {e.Name} — {e.Description}" + (e.Note is not null ? $" [{e.Note}]" : ""))
            .ToList();
}
