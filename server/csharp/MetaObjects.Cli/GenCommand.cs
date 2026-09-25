// `dotnet meta gen` — generate idiomatic C# (EF Core) code from metadata.
//
// Loads metadata from a directory and runs the codegen generator set, writing
// files under the @generated-header guard. Generated today: EF Core entity
// classes + a DbContext. Routes / projections / migrations layer on next.

using System.IO;
using System.Text.Json;
using MetaObjects.Codegen;
using MetaObjects.Loader;

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
    /// The error a run with no generator selection reports.
    /// </summary>
    /// <remarks>
    /// <para>There is no default suite. This port used to run NINE generators for a
    /// caller who named none — entity, names, db-context, routes, filter-allowlist,
    /// payload, output-parser, output-prompt, extractor — which is a shape nobody chose.
    /// Java has never had a default set and has been right all along; TypeScript and
    /// Python dropped theirs in the same change.</para>
    /// <para>Deciding WHICH code an application needs belongs to whoever is building it
    /// — increasingly an LLM working in the repo, which is well able to make that call
    /// given a truthful catalog and is badly served by a default that pre-empts it.
    /// <c>--list</c> is that catalog.</para>
    /// </remarks>
    public const string NoGeneratorsSelected =
        "gen: no generators selected. Nothing is generated until you choose it — " +
        "pass --generators <a,b,c>. See the catalog: dotnet meta gen --list";

    /// <summary>
    /// Run codegen selecting generators by stable name. There is no default suite:
    /// a null or empty <paramref name="generatorNames"/> with no template spec either
    /// generates nothing and reports <see cref="NoGeneratorsSelected"/> — ADR-0034
    /// Amendment 2 made codegen opt-in. A template spec alone is a selection.
    /// An unknown name (or a render-helper selected without a
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
        ColumnNamingStrategy columnNaming = ColumnNamingStrategy.Literal,
        string baseline = "default")
        => Run(MetaDataLoader.FromDirectory(metadataDir), outDir, ns, emitAbstractShapes,
            generatorNames, templateRoot, templateSpecPath, ProjectRootFor(metadataDir), columnNaming,
            baseline);

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

    // ------------------------------------------------------------------------
    // SP-1 declarative template-spec resolution. The implementation now lives in
    // MetaObjects.Codegen.CodegenCli (ADR-0034 Amendment 3 / the eject design doc's C#
    // section) — an ejected codegen/Program.cs needs to discover a project's
    // template-spec.json exactly as `dotnet meta gen` does, and MetaObjects.Codegen
    // cannot depend on MetaObjects.Cli. These forward to it so this port keeps ONE
    // implementation, not two, while this class's own public surface (and the tests
    // pinned to it) stays put.
    // ------------------------------------------------------------------------

    /// <summary>See <see cref="MetaObjects.Codegen.CodegenCli.TemplateSpecFileName"/>.</summary>
    public const string TemplateSpecFileName = MetaObjects.Codegen.CodegenCli.TemplateSpecFileName;

    /// <summary>See <see cref="MetaObjects.Codegen.CodegenCli.TemplateSpecPathFor"/>.</summary>
    public static string? TemplateSpecPathFor(string? projectRoot, string? explicitPath) =>
        MetaObjects.Codegen.CodegenCli.TemplateSpecPathFor(projectRoot, explicitPath);

    /// <summary>See <see cref="MetaObjects.Codegen.CodegenCli.TemplateSpecGenerators"/>.</summary>
    public static IReadOnlyList<IGenerator> TemplateSpecGenerators(
        string? projectRoot, string? explicitPath, string? templateRoot) =>
        MetaObjects.Codegen.CodegenCli.TemplateSpecGenerators(projectRoot, explicitPath, templateRoot);

    /// <summary>See <see cref="MetaObjects.Codegen.CodegenCli.DefaultPromptsDir"/>.</summary>
    public const string DefaultPromptsDir = MetaObjects.Codegen.CodegenCli.DefaultPromptsDir;

    /// <summary>See <see cref="MetaObjects.Codegen.CodegenCli.LegacyTemplatesDir"/>.</summary>
    public const string LegacyTemplatesDir = MetaObjects.Codegen.CodegenCli.LegacyTemplatesDir;

    /// <summary>See <see cref="MetaObjects.Codegen.CodegenCli.DefaultTemplateRoot"/>.</summary>
    public static string DefaultTemplateRoot(string? baseDir = null) =>
        MetaObjects.Codegen.CodegenCli.DefaultTemplateRoot(baseDir);

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
        ColumnNamingStrategy columnNaming = ColumnNamingStrategy.Literal,
        string baseline = "default")
    {
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
        if (loadErrors.Count > 0)
            return new Outcome(loadErrors, null);

        var names = generatorNames ?? [];
        List<IGenerator> generators;
        try
        {
            // The SAME default the template-spec pass below uses: `render-helper` needs an
            // on-disk root for its build-time drift gate, and with none supplied the
            // registry falls back to a temp dir — a drift error naming an unresolved ref
            // rather than the directory nobody named. Give it the resolved default so the
            // two passes of one command look in one place.
            generators = GeneratorRegistry
                .Resolve(names, new GeneratorBuildContext(templateRoot ?? DefaultTemplateRoot()))
                .ToList();
            // Explicit flag, else the conventional <projectRoot>/template-spec.json.
            // Resolved through the SAME helper verify uses — that shared call is the fix.
            generators.AddRange(TemplateSpecGenerators(projectRoot, templateSpecPath, templateRoot));
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException)
        {
            return new Outcome([ex.Message], null);
        }

        // No default suite — see NoGeneratorsSelected. A caller that selects nothing gets a
        // usage error and an empty out dir, never a shape this CLI picked. A template spec
        // (flag or the conventional template-spec.json) IS a selection, so this runs after
        // spec resolution: it used to run before, and refused a spec-only project.
        if (generators.Count == 0)
            return new Outcome([NoGeneratorsSelected], null);

        // Build-config + CodegenRunner.Run + hash-manifest / overwrite-policy / merge, and
        // the RenderException / ArgumentException-to-clean-error translation, all live in
        // ONE place now (ADR-0034 Amendment 3 / the eject design doc's C# section):
        // MetaObjects.Codegen.CodegenCli.RunGen. It is the exact pipeline an ejected
        // `codegen/Program.cs` calls too, with its owned generators composed into the same
        // selection (CodegenCli.ComposeGenerators) — one implementation, not two.
        var apiOutcome = MetaObjects.Codegen.CodegenCli.RunGen(
            load, outDir, ns, emitAbstractShapes, generators, projectRoot, columnNaming, baseline);
        return new Outcome(apiOutcome.LoadErrors, apiOutcome.Result);
    }

    /// <summary>
    /// The heading `dotnet meta gen --list` prints above the entries. ADR-0034 Amendment 3:
    /// generators are reference helpers you own with `dotnet meta eject` — mirrors the
    /// Python port's header now that this port has eject too.
    /// </summary>
    public const string ListHeader =
        "Reference generators — each is a helper, not a guarantee: `dotnet meta eject <name>`\n" +
        "copies it into codegen/generators/ and the copy is yours to change. What MetaObjects\n" +
        "guarantees (verify, render) is not a generator and is not listed.\n" +
        "Select with --generators <name,...>:";

    /// <summary>
    /// The lines `dotnet meta gen --list` prints: one `&lt;stable-name&gt; — &lt;description&gt;`
    /// per registered generator, native first, marked `[owned — identical]` / `[owned —
    /// DIFFERS: N behind, M of your own]` when <paramref name="cwd"/> already has an
    /// ejected copy (<see cref="OwnedCopy.Status"/>). Pure (no console I/O) for testing.
    /// </summary>
    public static IReadOnlyList<string> ListLines(string cwd) =>
        GeneratorRegistry.List()
            .Select(e =>
            {
                var owned = OwnedCopy.Status(cwd, e);
                var ownedMark = owned is not null ? $" [owned — {owned}]" : "";
                var requires = e.Requires.Count > 0 ? $" (requires: {string.Join(", ", e.Requires)})" : "";
                return $"  {e.Name} — {e.Description}" + requires + (e.Note is not null ? $" [{e.Note}]" : "") + ownedMark;
            })
            .ToList();
}
