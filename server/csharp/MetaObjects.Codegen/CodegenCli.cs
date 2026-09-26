// The "one implementation, not two" pipeline ADR-0034 Amendment 3 / the eject design
// doc's C# section asks for: `dotnet meta gen`'s run logic (build GenConfig, call
// CodegenRunner.Run, translate its exceptions into a clean Outcome) lifted out of
// MetaObjects.Cli.GenCommand into a public API here, so an ejected `codegen/Program.cs`
// — which references ONLY this package, never MetaObjects.Cli — can call the exact same
// pipeline the built-in CLI runs, with its own compile-time-bound IGenerator list in
// place of a name-resolved one.
//
// MetaObjects.Cli.GenCommand.Run CALLS RunGen below rather than reimplementing it: it
// resolves stable NAMES to generator instances and hands the resolved list here. An
// ejected Program.cs binds its owned generators with `new`; ComposeGenerators fills the
// rest of its `--generators` selection from the registry.

using System.Text.Json;
using MetaObjects.Codegen.TemplateCodegen;
using MetaObjects.Config;
using MetaObjects.Source;
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
    /// <summary>The prefixes <see cref="RunGen(LoadResult, string, string, bool, IReadOnlyList{IGenerator}, string?, ColumnNamingStrategy, string)"/>
    /// puts on a GENERATOR's failure, as opposed to a metadata load error.</summary>
    public const string GeneratorFailedPrefix = "codegen failed: ";
    public const string RenderFailedPrefix = "template render failed: ";

    /// <summary>True when an entry of <see cref="GenOutcome.LoadErrors"/> is a generator that
    /// threw, not metadata that failed to load.</summary>
    public static bool IsGeneratorFailure(string entry) =>
        entry.StartsWith(GeneratorFailedPrefix, StringComparison.Ordinal) ||
        entry.StartsWith(RenderFailedPrefix, StringComparison.Ordinal);

    /// <summary>
    /// Print a failed outcome to stderr, naming the right culprit. A generator of the
    /// adopter's own that throws used to be reported as "load error … metadata did not load
    /// cleanly", which sends its author to the metadata instead of to the line that threw.
    /// </summary>
    public static void ReportFailure(GenOutcome outcome, string command)
    {
        var generatorFailed = outcome.LoadErrors.Any(IsGeneratorFailure);
        foreach (var e in outcome.LoadErrors)
            Console.Error.WriteLine(IsGeneratorFailure(e) ? $"  error: {e}" : $"  load error: {e}");
        Console.Error.WriteLine(generatorFailed
            ? $"{command}: FAILED (a generator threw — see the error above)"
            : $"{command}: FAILED (metadata did not load cleanly)");
    }

    /// <summary>Trailing advice after <c>gen</c>'s unknown-attribute warnings. <c>gen</c> has
    /// no strict flag of its own; <c>verify</c> is the strict door (ADR-0023).</summary>
    public const string UnknownAttrGenAdvice =
        "gen loads leniently and generated anyway, but `dotnet meta verify` rejects this metadata " +
        "(ADR-0023): fix or remove the attribute - a typo'd one (`isAbstrakt`, `requird`) silently " +
        "changes what is generated.";

    /// <summary>
    /// The ADR-0023 unknown-attribute findings a STRICT load of <paramref name="meta"/>
    /// raises, formatted for a lenient <c>gen</c> to print as warnings: code + message
    /// (naming the attribute and the node), then the file and JSON path. <c>gen</c> used to
    /// accept a typo'd attribute without a word while <c>verify</c> rejected the same file.
    /// Advisory only; empty for a clean model.
    /// </summary>
    public static IReadOnlyList<string> UnknownAttrWarnings(ResolvedMetadata meta)
    {
        LoadResult strictLoad;
        try { strictLoad = meta.Load(strict: true); }
        catch (Exception ex) when (ex is MetaModelException or IOException) { return []; }
        return [.. strictLoad.Errors
            .Where(e => e.Code == ErrorCode.ERR_UNKNOWN_ATTR)
            .Select(FormatUnknownAttr)];
    }

    /// <summary>Print <see cref="UnknownAttrWarnings"/> to stderr, then the advice once.</summary>
    public static void WarnUnknownAttrs(ResolvedMetadata meta)
    {
        var warnings = UnknownAttrWarnings(meta);
        if (warnings.Count == 0) return;
        foreach (var w in warnings) Console.Error.WriteLine($"warning: {w}");
        Console.Error.WriteLine($"warning: {UnknownAttrGenAdvice}");
    }

    private static string FormatUnknownAttr(MetaError e)
    {
        var (files, jsonPath) = e.Envelope switch
        {
            JsonSource j => (j.Files, j.JsonPath),
            YamlSource y => (y.Files, y.JsonPath),
            _ => (e.Source is { Length: > 0 } src ? (IReadOnlyList<string>)[src] : [], e.Path),
        };
        var where = string.Join(" ", new[]
        {
            files.Count > 0 ? string.Join(", ", files) : null,
            string.IsNullOrEmpty(jsonPath) ? null : $"at {jsonPath}",
        }.Where(p => p is not null));
        var head = $"{e.Code}: {e.Message}";
        return where.Length > 0 ? $"{head}\n  in {where}" : head;
    }

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
    public static string ProjectRootFor(string metadataDir) => MetadataLocation.ProjectRootFor(metadataDir);

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
        => RunGen(MetadataLocation.Resolve(metadataDir, Directory.GetCurrentDirectory()).Load(), outDir, ns,
            emitAbstractShapes, generators, ProjectRootFor(metadataDir), columnNaming, baseline);

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
    /// (<c>MetaObjects.Cli.GenCommand</c>, via <see cref="GeneratorRegistry"/>), or the two
    /// composed by <see cref="ComposeGenerators"/>. This overload resolves no names.
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
            return new GenOutcome([$"{RenderFailedPrefix}{ex.Message}"], null);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // An output-pattern error or a duplicate output-path collision surfaces lazily
            // during the walk — a clean error, not a stack trace.
            return new GenOutcome([$"{GeneratorFailedPrefix}{ex.Message}"], null);
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
                "usage: gen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>]\n" +
                "           [--emit-abstract-shapes] [--column-naming literal|snake_case|kebab-case]\n" +
                "           [--baseline default|adopt] [--template-root <dir>] [--template-spec <json>]\n" +
                "     | verify --codegen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>]\n" +
                "           [--column-naming literal|snake_case|kebab-case] [--template-root <dir>] [--lax]");
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

    /// <summary>
    /// The suite an owned project runs: the <c>--generators</c> selection, in its order,
    /// with each generator the project owns taking the packaged one's place, then any owned
    /// generator the selection did not name. With no selection, just <paramref name="owned"/>.
    /// An owned copy is matched by its <c>IGenerator.Name</c>, which eject leaves unchanged;
    /// that is not always the stable selection name (<c>entity</c> builds
    /// <c>entity-generator</c>), so each selected name is resolved first and compared by
    /// the packaged instance's <c>Name</c>.
    /// Ejecting one generator must not drop the others a project selects: before this, an
    /// owned runner ignored <c>--generators</c> and regenerated only its own copies.
    /// Throws <see cref="ArgumentException"/> for an unknown name.
    /// </summary>
    public static IReadOnlyList<IGenerator> ComposeGenerators(
        IReadOnlyList<IGenerator> owned, IReadOnlyList<string>? selection, string templateRoot)
    {
        if (selection is not { Count: > 0 }) return owned;
        var ctx = new GeneratorBuildContext(templateRoot);
        var suite = new List<IGenerator>();
        var replaced = new HashSet<IGenerator>(ReferenceEqualityComparer.Instance);
        foreach (var packaged in GeneratorRegistry.Resolve(selection, ctx))
        {
            var mine = owned.FirstOrDefault(g => g.Name == packaged.Name);
            if (mine is not null) replaced.Add(mine);
            suite.Add(mine ?? packaged);
        }
        suite.AddRange(owned.Where(g => !replaced.Contains(g)));
        return suite;
    }

    /// <summary>The flags both owned commands share, parsed once.</summary>
    private sealed class OwnedArgs
    {
        public string? MetadataDir, OutDir, TemplateRoot, TemplateSpecPath, ColumnNamingRaw, GeneratorsCsv;
        public string Namespace = "Generated";
        public string Baseline = "default";
        public bool NamespaceExplicit, EmitAbstractShapes, Codegen, Lax;

        public IReadOnlyList<string>? Selection => GeneratorsCsv
            ?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        public static OwnedArgs Parse(string[] rest)
        {
            var a = new OwnedArgs();
            for (int i = 0; i < rest.Length; i++)
            {
                if (rest[i] == "--out" && i + 1 < rest.Length) a.OutDir = rest[++i];
                else if (rest[i] == "--namespace" && i + 1 < rest.Length) { a.Namespace = rest[++i]; a.NamespaceExplicit = true; }
                else if (rest[i] == "--emit-abstract-shapes") a.EmitAbstractShapes = true;
                else if (rest[i] == "--column-naming" && i + 1 < rest.Length) a.ColumnNamingRaw = rest[++i];
                else if (rest[i] == "--baseline" && i + 1 < rest.Length) a.Baseline = rest[++i];
                else if (rest[i] == "--template-root" && i + 1 < rest.Length) a.TemplateRoot = rest[++i];
                else if (rest[i] == "--template-spec" && i + 1 < rest.Length) a.TemplateSpecPath = rest[++i];
                else if (rest[i] == "--generators" && i + 1 < rest.Length) a.GeneratorsCsv = rest[++i];
                else if (rest[i] == "--codegen") a.Codegen = true;
                else if (rest[i] == "--lax") a.Lax = true;
                else if (!rest[i].StartsWith('-')) a.MetadataDir ??= rest[i];
            }
            return a;
        }
    }

    /// <summary>Resolve the metadata location through the same ladder as <c>dotnet meta</c>,
    /// or print why not. <c>null</c> means the caller exits 2.</summary>
    private static ResolvedMetadata? ResolveOrReport(string? metadataDir)
    {
        try
        {
            return MetadataLocation.Resolve(metadataDir, Directory.GetCurrentDirectory());
        }
        catch (MetaModelException e)
        {
            Console.Error.WriteLine($"error: {e.Code}: {e.Message}");
        }
        catch (MetadataLocationException e)
        {
            Console.Error.WriteLine($"error: {e.Message}");
        }
        return null;
    }

    private static int RunGenArgs(string[] rest, IReadOnlyList<IGenerator> owned)
    {
        var a = OwnedArgs.Parse(rest);
        var columnNaming = ColumnNamingStrategy.Literal;
        if (a.ColumnNamingRaw is not null && !TryParseColumnNaming(a.ColumnNamingRaw, out columnNaming))
        {
            Console.Error.WriteLine($"error: unknown --column-naming \"{a.ColumnNamingRaw}\"");
            return 2;
        }
        if (a.OutDir is null)
        {
            Console.Error.WriteLine("usage: gen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>] [...]");
            return 2;
        }
        if (ResolveOrReport(a.MetadataDir) is not { } meta) return 2;

        var projectRoot = a.MetadataDir is not null ? ProjectRootFor(a.MetadataDir) : Directory.GetCurrentDirectory();
        var templateRoot = a.TemplateRoot ?? DefaultTemplateRoot();
        List<IGenerator> suite;
        try
        {
            suite = [.. ComposeGenerators(owned, a.Selection, templateRoot)];
            suite.AddRange(TemplateSpecGenerators(projectRoot, a.TemplateSpecPath, a.TemplateRoot));
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException)
        {
            Console.Error.WriteLine($"  error: {ex.Message}");
            Console.Error.WriteLine("codegen (owned) gen: FAILED");
            return 1;
        }

        WarnUnknownAttrs(meta);
        var outcome = RunGen(meta.Load(), a.OutDir, a.Namespace, a.EmitAbstractShapes, suite, projectRoot, columnNaming, a.Baseline);
        if (!outcome.Ok)
        {
            ReportFailure(outcome, "codegen (owned) gen");
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

    private static int RunVerifyArgs(string[] rest, IReadOnlyList<IGenerator> owned)
    {
        var a = OwnedArgs.Parse(rest);
        if (!a.Codegen)
        {
            Console.Error.WriteLine(
                "codegen (owned) verify: this owned runner only handles `verify --codegen` — " +
                "template/db drift stay with `dotnet meta verify` (they do not depend on which " +
                "generators you ejected).");
            return 2;
        }

        var columnNaming = ColumnNamingStrategy.Literal;
        if (a.ColumnNamingRaw is not null && !TryParseColumnNaming(a.ColumnNamingRaw, out columnNaming))
        {
            Console.Error.WriteLine($"error: unknown --column-naming \"{a.ColumnNamingRaw}\"");
            return 2;
        }
        if (a.OutDir is null)
        {
            Console.Error.WriteLine("usage: verify --codegen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>]");
            return 2;
        }
        if (ResolveOrReport(a.MetadataDir) is not { } meta) return 2;

        // Strict unless --lax, as `dotnet meta verify` is (ADR-0023).
        var load = meta.Load(strict: !a.Lax);
        if (load.Errors.Count > 0)
        {
            foreach (var e in load.Errors) Console.Error.WriteLine($"  load error: {e.Code}: {e.Message}");
            Console.Error.WriteLine("codegen (owned) verify --codegen: FAILED (metadata did not load cleanly)");
            return 1;
        }

        // The same suite `gen` builds, template-spec generators included: verify must
        // regenerate what gen wrote, or it convicts gen's own output as drift.
        var projectRoot = a.MetadataDir is not null ? ProjectRootFor(a.MetadataDir) : Directory.GetCurrentDirectory();
        var templateRoot = a.TemplateRoot ?? DefaultTemplateRoot();
        List<IGenerator> suite;
        try
        {
            suite = [.. ComposeGenerators(owned, a.Selection, templateRoot)];
            suite.AddRange(TemplateSpecGenerators(projectRoot, null, templateRoot));
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException)
        {
            Console.Error.WriteLine($"  error: {ex.Message}");
            return 2;
        }

        // Same inference rule `dotnet meta verify --codegen` uses: an explicit
        // --namespace always wins; otherwise infer from the committed output so a regen
        // matches output produced with any namespace (avoids spurious drift).
        var effectiveNs = a.NamespaceExplicit ? a.Namespace : (CodegenDrift.InferNamespace(a.OutDir) ?? a.Namespace);
        var config = new GenConfig
        {
            OutDir = a.OutDir,
            Namespace = effectiveNs,
            ColumnNamingStrategy = columnNaming,
            IncludeNames = suite.Any(g => g.Name == "names"),
        };
        var result = CodegenDrift.Compute(config, load.Root, suite);
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
