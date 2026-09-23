// The "one implementation, not two" pipeline ADR-0034 Amendment 3 / the eject design
// doc's C# section asks for: `dotnet meta gen`'s run logic (build GenConfig, call
// CodegenRunner.Run, translate its exceptions into a clean Outcome) lifted out of
// MetaObjects.Cli.GenCommand into a public API here, so an ejected `codegen/Program.cs`
// — which references ONLY this package, never MetaObjects.Cli — can call the exact same
// pipeline the built-in CLI runs, with its own compile-time-bound IGenerator list in
// place of a name-resolved one.
//
// MetaObjects.Cli.GenCommand.Run is refactored to CALL RunGen below rather than
// reimplement it: it resolves stable NAMES to generator instances (a CLI-only concern —
// an ejected Program.cs has no names, only `new`-built instances) and then hands the
// resolved list here.

using System.Text.Json;
using MetaObjects.Codegen.TemplateCodegen;
using MetaObjects.Loader;
using MetaObjects.Render;

namespace MetaObjects.Codegen;

public static class CodegenCli
{
    // ------------------------------------------------------------------------
    // SP-1 declarative template-spec resolution — moved here from
    // MetaObjects.Cli.GenCommand (which now forwards to these) for the same "one
    // implementation" reason as RunGen: an ejected codegen/Program.cs needs to discover
    // a project's template-spec.json exactly as `dotnet meta gen` does, and
    // MetaObjects.Codegen cannot depend on MetaObjects.Cli.
    // ------------------------------------------------------------------------

    /// <summary>The conventional declarative-template-spec file name (SP-1 §4).</summary>
    public const string TemplateSpecFileName = "template-spec.json";

    /// <summary>
    /// The template-spec to use, or <c>null</c> for "no template generators". An explicit
    /// path always wins (and is used verbatim); otherwise <c>&lt;projectRoot&gt;/
    /// template-spec.json</c> is used IF it exists. EVERY path that builds a generator
    /// list must call this — <c>gen</c> and <c>verify --codegen</c> resolving the spec
    /// differently is exactly how verify used to regenerate without the template
    /// generators and report their committed output as stale.
    /// </summary>
    public static string? TemplateSpecPathFor(string? projectRoot, string? explicitPath)
    {
        if (!string.IsNullOrEmpty(explicitPath)) return explicitPath;
        if (string.IsNullOrEmpty(projectRoot)) return null;
        var candidate = Path.Combine(projectRoot, TemplateSpecFileName);
        return File.Exists(candidate) ? candidate : null;
    }

    /// <summary>The declarative Mustache generators for this project — empty when there
    /// is no spec at all.</summary>
    public static IReadOnlyList<IGenerator> TemplateSpecGenerators(
        string? projectRoot, string? explicitPath, string? templateRoot)
    {
        var specPath = TemplateSpecPathFor(projectRoot, explicitPath);
        if (specPath is null) return [];
        using var doc = JsonDocument.Parse(File.ReadAllText(specPath));
        var spec = TemplateSpec.Parse(doc.RootElement);
        var provider = new FilesystemProvider(templateRoot ?? DefaultTemplateRoot());
        return TemplateSpec.ToGenerators(spec, provider).ToList();
    }

    /// <summary>The canonical directory name for authored template bodies.</summary>
    public const string DefaultPromptsDir = "prompts";

    /// <summary>The name this port defaulted to before 1.0.5, kept as the FALLBACK.</summary>
    public const string LegacyTemplatesDir = "templates";

    /// <summary>
    /// The template root to use when the caller named none: <c>prompts</c> when that
    /// directory exists, else <c>templates</c>. A FALLBACK, never a flip — a project
    /// whose bodies are already in <c>templates/</c> behaves exactly as it did.
    /// </summary>
    public static string DefaultTemplateRoot(string? baseDir = null) =>
        Directory.Exists(Path.Combine(baseDir ?? Directory.GetCurrentDirectory(), DefaultPromptsDir))
            ? DefaultPromptsDir
            : LegacyTemplatesDir;

    /// <summary>The outcome of a gen run: pure data, no console I/O.</summary>
    public sealed record GenOutcome(IReadOnlyList<string> LoadErrors, CodegenRunner.RunResult? Result)
    {
        public bool Ok => LoadErrors.Count == 0 && Result is not null;
    }

    /// <summary>
    /// The project a metadata directory belongs to: its PARENT, i.e. the directory
    /// holding <c>metaobjects/</c>. Anchoring tool state on
    /// <c>Directory.GetCurrentDirectory()</c> instead would scatter a stray
    /// <c>.metaobjects/</c> into whatever directory the process happens to sit in.
    /// </summary>
    public static string ProjectRootFor(string metadataDir) =>
        Path.GetDirectoryName(Path.GetFullPath(metadataDir)) ?? Directory.GetCurrentDirectory();

    /// <summary>
    /// Load metadata from <paramref name="metadataDir"/> and run <paramref
    /// name="generators"/> against it. See the <see cref="LoadResult"/> overload for the
    /// full contract; this one is the convenience an ejected <c>codegen/Program.cs</c>
    /// calls directly.
    /// </summary>
    public static GenOutcome RunGen(
        string metadataDir, string outDir, string ns, bool emitAbstractShapes,
        IReadOnlyList<IGenerator> generators,
        ColumnNamingStrategy columnNaming = ColumnNamingStrategy.Literal, string baseline = "default")
        => RunGen(MetaDataLoader.FromDirectory(metadataDir), outDir, ns, emitAbstractShapes, generators,
            ProjectRootFor(metadataDir), columnNaming, baseline);

    /// <summary>
    /// Build a <see cref="GenConfig"/> from the given knobs and run <paramref
    /// name="generators"/> against <paramref name="load"/>'s model via <see
    /// cref="CodegenRunner.Run"/> — the hash-manifest / overwrite-policy / merge pipeline,
    /// unchanged. A load that did not succeed, or a generator that throws a render or
    /// codegen error, surfaces as a populated <see cref="GenOutcome.LoadErrors"/> rather
    /// than a throw.
    /// </summary>
    /// <param name="generators">
    /// The resolved generator instances to run — an adopter's own <c>new</c>-built list
    /// (an ejected <c>codegen/Program.cs</c>), or the CLI's name-resolved list
    /// (<c>MetaObjects.Cli.GenCommand</c>, via <see cref="GeneratorRegistry"/>). This API
    /// does no name resolution of its own: selecting BY STABLE NAME is a CLI-only
    /// concern, since an ejected project binds its generators at compile time.
    /// </param>
    /// <param name="projectRoot">
    /// Anchors <c>.metaobjects/.gen-state/</c> and the manifest's relative keys. Defaults
    /// to the current directory for a caller that names no project (mirrors
    /// <c>GenConfig.ProjectRoot</c>'s own default).
    /// </param>
    public static GenOutcome RunGen(
        LoadResult load, string outDir, string ns, bool emitAbstractShapes,
        IReadOnlyList<IGenerator> generators, string? projectRoot = null,
        ColumnNamingStrategy columnNaming = ColumnNamingStrategy.Literal, string baseline = "default")
    {
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
        if (loadErrors.Count > 0) return new GenOutcome(loadErrors, null);

        var root = projectRoot ?? Directory.GetCurrentDirectory();
        var config = new GenConfig
        {
            OutDir = outDir,
            Namespace = ns,
            EmitAbstractShapes = emitAbstractShapes,
            // The hash manifest lives beside the project's other tool state. Supplying it
            // is what gives real hand-edit detection; without it CodegenRunner falls back
            // to the legacy <auto-generated/>-marker rule. COMMIT .gen-state/.hashes.json.
            GenStateDir = Path.Combine(root, ".metaobjects", ".gen-state"),
            ProjectRoot = root,
            ColumnNamingStrategy = columnNaming,
            Baseline = baseline,
            // C1 — the presence gate: is the `names` generator (NamesGenerator.Name ==
            // "names") actually part of THIS resolved list? Checked by NAME, not by
            // `is NamesGenerator`, so an OWNED copy of NamesGenerator — a different CLR
            // type, in a different assembly, once ejected — still satisfies the gate.
            IncludeNames = generators.Any(g => g.Name == "names"),
        };

        CodegenRunner.RunResult result;
        try
        {
            result = CodegenRunner.Run(config, load.Root, generators);
        }
        catch (RenderException ex)
        {
            // A bad template ref / wrong --template-root surfaces as a clean error, not a stack trace.
            return new GenOutcome([$"template render failed: {ex.Message}"], null);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // An output-pattern error or a duplicate output-path collision surfaces lazily
            // during the walk — a clean error, not a stack trace.
            return new GenOutcome([$"codegen failed: {ex.Message}"], null);
        }
        return new GenOutcome(loadErrors, result);
    }

    // ------------------------------------------------------------------------
    // The ejected codegen/Program.cs entry point (ADR-0034 Amendment 3 / the eject
    // design doc's C# section, "Hand-off"): `dotnet meta gen` and `dotnet meta verify
    // --codegen` run `dotnet run --project codegen -- <forwarded args>` and return ITS
    // exit code once codegen/Codegen.csproj exists (see MetaObjects.Cli.Program). This
    // is the far end of that hand-off — it mirrors the CLI's own `gen <dir> --out
    // <dir> ...` / `verify --codegen <dir> --out <dir> ...` argument surface exactly, so
    // the forwarding is transparent, but is scoped to what an ejected project can do on
    // its own: codegen (`gen`) and the codegen-drift gate ONLY. Template/db drift stay
    // with `dotnet meta verify` — an ejected project has no template-spec/prompt-drift
    // machinery of its own to run, and cross-referencing back into MetaObjects.Cli would
    // invert the dependency direction (Cli depends on Codegen, never the reverse).
    // ------------------------------------------------------------------------

    /// <summary>
    /// The forwarded-args entry point an ejected <c>codegen/Program.cs</c> calls:
    /// <c>CodegenCli.Run(args, generators)</c>. Dispatches on <c>args[0]</c> (<c>"gen"</c>
    /// or <c>"verify"</c>), prints to the console, and returns the process exit code.
    /// </summary>
    public static int Run(string[] args, IReadOnlyList<IGenerator> generators)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine(
                "usage: gen <metadataDir> --out <dir> [--namespace <ns>] [--emit-abstract-shapes]\n" +
                "           [--column-naming literal|snake_case|kebab-case] [--baseline default|adopt]\n" +
                "           [--template-root <dir>] [--template-spec <json>]\n" +
                "     | verify --codegen <metadataDir> --out <dir> [--namespace <ns>]\n" +
                "           [--column-naming literal|snake_case|kebab-case]");
            return 2;
        }
        return args[0] switch
        {
            "gen" => RunGenArgs(args[1..], generators),
            "verify" => RunVerifyArgs(args[1..], generators),
            _ => Unknown(args[0]),
        };
    }

    private static int Unknown(string cmd)
    {
        Console.Error.WriteLine($"codegen (owned): unknown command \"{cmd}\" — expected \"gen\" or \"verify\".");
        return 2;
    }

    private static bool TryParseColumnNaming(string raw, out ColumnNamingStrategy strategy)
    {
        switch (raw)
        {
            case "literal": strategy = ColumnNamingStrategy.Literal; return true;
            case "snake_case": strategy = ColumnNamingStrategy.SnakeCase; return true;
            case "kebab-case": strategy = ColumnNamingStrategy.KebabCase; return true;
            default: strategy = ColumnNamingStrategy.Literal; return false;
        }
    }

    private static int RunGenArgs(string[] rest, IReadOnlyList<IGenerator> generators)
    {
        string? metadataDir = null, outDir = null, templateRoot = null, templateSpecPath = null, columnNamingRaw = null;
        string ns = "Generated";
        bool emitAbstractShapes = false;
        string baseline = "default";
        for (int i = 0; i < rest.Length; i++)
        {
            if (rest[i] == "--out" && i + 1 < rest.Length) outDir = rest[++i];
            else if (rest[i] == "--namespace" && i + 1 < rest.Length) ns = rest[++i];
            else if (rest[i] == "--emit-abstract-shapes") emitAbstractShapes = true;
            else if (rest[i] == "--column-naming" && i + 1 < rest.Length) columnNamingRaw = rest[++i];
            else if (rest[i] == "--baseline" && i + 1 < rest.Length) baseline = rest[++i];
            else if (rest[i] == "--template-root" && i + 1 < rest.Length) templateRoot = rest[++i];
            else if (rest[i] == "--template-spec" && i + 1 < rest.Length) templateSpecPath = rest[++i];
            // --generators names a STABLE-NAME selection — meaningless here, since this
            // project's suite is the compile-time `generators` list Program.cs built with
            // `new`. Consumed (not applied) so a forwarded `dotnet meta gen --generators
            // a,b` does not misparse as a positional / unknown flag.
            else if (rest[i] == "--generators" && i + 1 < rest.Length) i++;
            else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
        }

        var columnNaming = ColumnNamingStrategy.Literal;
        if (columnNamingRaw is not null && !TryParseColumnNaming(columnNamingRaw, out columnNaming))
        {
            Console.Error.WriteLine($"error: unknown --column-naming \"{columnNamingRaw}\"");
            return 2;
        }
        if (metadataDir is null || outDir is null)
        {
            Console.Error.WriteLine("usage: gen <metadataDir> --out <dir> [--namespace <ns>] [...]");
            return 2;
        }

        var projectRoot = ProjectRootFor(metadataDir);
        var load = MetaDataLoader.FromDirectory(metadataDir);
        var allGenerators = new List<IGenerator>(generators);
        try
        {
            allGenerators.AddRange(TemplateSpecGenerators(projectRoot, templateSpecPath, templateRoot));
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"  load error: {ex.Message}");
            Console.Error.WriteLine("codegen (owned): FAILED");
            return 1;
        }

        var outcome = RunGen(load, outDir, ns, emitAbstractShapes, allGenerators, projectRoot, columnNaming, baseline);
        if (!outcome.Ok)
        {
            foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
            Console.Error.WriteLine("codegen (owned) gen: FAILED (metadata did not load cleanly)");
            return 1;
        }
        foreach (var f in outcome.Result!.Files) Console.WriteLine($"  {f.Status}: {f.Path}");
        foreach (var w in outcome.Result!.Warnings) Console.Error.WriteLine($"  warning: {w}");
        var writtenCount = outcome.Result!.Files.Count(f => f.Status == "written");
        Console.WriteLine($"codegen (owned) gen: {writtenCount} file(s) written");

        var refusedCount = outcome.Result!.Files.Count(f => f.Status == "refused");
        if (refusedCount > 0)
        {
            Console.Error.WriteLine(
                $"codegen (owned) gen: FAILED — {refusedCount} file(s) refused (see the warnings above)");
            return 1;
        }
        return 0;
    }

    private static int RunVerifyArgs(string[] rest, IReadOnlyList<IGenerator> generators)
    {
        string? metadataDir = null, outDir = null, columnNamingRaw = null;
        string ns = "Generated";
        bool nsExplicit = false, codegen = false;
        for (int i = 0; i < rest.Length; i++)
        {
            if (rest[i] == "--codegen") codegen = true;
            else if (rest[i] == "--out" && i + 1 < rest.Length) outDir = rest[++i];
            else if (rest[i] == "--namespace" && i + 1 < rest.Length) { ns = rest[++i]; nsExplicit = true; }
            else if (rest[i] == "--column-naming" && i + 1 < rest.Length) columnNamingRaw = rest[++i];
            else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
        }

        if (!codegen)
        {
            Console.Error.WriteLine(
                "codegen (owned) verify: this owned runner only handles `verify --codegen` — " +
                "template/db drift stay with `dotnet meta verify` (they do not depend on which " +
                "generators you ejected).");
            return 2;
        }

        var columnNaming = ColumnNamingStrategy.Literal;
        if (columnNamingRaw is not null && !TryParseColumnNaming(columnNamingRaw, out columnNaming))
        {
            Console.Error.WriteLine($"error: unknown --column-naming \"{columnNamingRaw}\"");
            return 2;
        }
        if (metadataDir is null || outDir is null)
        {
            Console.Error.WriteLine("usage: verify --codegen <metadataDir> --out <dir> [--namespace <ns>]");
            return 2;
        }

        var load = MetaDataLoader.FromDirectory(metadataDir);
        if (load.Errors.Count > 0)
        {
            foreach (var e in load.Errors) Console.Error.WriteLine($"  load error: {e.Code}");
            Console.Error.WriteLine("codegen (owned) verify --codegen: FAILED (metadata did not load cleanly)");
            return 1;
        }

        // Same inference rule `dotnet meta verify --codegen` uses: an explicit
        // --namespace always wins; otherwise infer from the committed output so a regen
        // matches output produced with any namespace (avoids spurious drift).
        var effectiveNs = nsExplicit ? ns : (CodegenDrift.InferNamespace(outDir) ?? ns);
        var config = new GenConfig
        {
            OutDir = outDir,
            Namespace = effectiveNs,
            ColumnNamingStrategy = columnNaming,
            IncludeNames = generators.Any(g => g.Name == "names"),
        };
        var result = CodegenDrift.Compute(config, load.Root, generators);
        if (result.Error is not null)
        {
            Console.Error.WriteLine($"  {result.Error}");
            return 2;
        }
        if (result.Clean)
        {
            Console.WriteLine("codegen (owned) verify --codegen: OK (generated output is in sync)");
            return 0;
        }
        Console.Error.WriteLine($"codegen (owned) verify --codegen: drift ({result.DriftedFiles.Count} file(s) differ from a fresh regen):");
        foreach (var line in result.Lines) Console.Error.WriteLine($"  {line}");
        return 1;
    }
}
