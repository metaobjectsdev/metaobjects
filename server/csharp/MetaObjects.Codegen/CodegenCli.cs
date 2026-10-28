// The "one implementation, not two" pipeline ADR-0034 Amendment 3 / the eject design
// doc's C# section asks for: `dotnet meta gen`'s run logic (build GenConfig, call
// CodegenRunner.Run, translate its exceptions into a clean Outcome) as a public API here,
// so the project's `codegen/Program.cs` — which references ONLY this package, never
// MetaObjects.Cli — runs the generator list it declares in `codegen/Generators.cs`.
//
// Since ADR-0034 Amendment 9 that is the ONLY way `dotnet meta gen` generates: the CLI
// hands every gen and `verify --codegen` to `dotnet run --project codegen`, which calls
// Run(args, Generators.All) below. `--generators` narrows that declared list and never adds
// to it. MetaObjects.Cli.GenCommand.Run, which resolves registry names, stays as a
// programmatic API.

using System.Text.Json;
using MetaObjects.Codegen.TemplateCodegen;
using MetaObjects.Config;
using MetaObjects.Source;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Render;

namespace MetaObjects.Codegen;

public static class CodegenCli
{
    // ------------------------------------------------------------------------
    // SP-1 declarative template-spec resolution for the programmatic, name-resolved path
    // (MetaObjects.Cli.GenCommand forwards to these). The gen command no longer uses it:
    // since ADR-0034 Amendment 9 a spec runs only as a TemplateSpecGenerator entry in
    // codegen/Generators.cs, and a conventional template-spec.json nothing declares is refused
    // (LegacyTemplateSpec).
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
    /// <summary>The prefixes <see cref="RunGen(LoadResult, string, string, bool, IReadOnlyList{IGenerator}, string?, string, bool?)"/>
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
    /// full contract; this one is the convenience a program of the project's own may call
    /// directly.
    /// </summary>
    public static GenOutcome RunGen(
        string metadataDir, string outDir, string ns, bool emitAbstractShapes,
        IReadOnlyList<IGenerator> generators, string baseline = "default")
        => RunGen(MetadataLocation.Resolve(metadataDir, Directory.GetCurrentDirectory()).Load(), outDir, ns,
            emitAbstractShapes, generators, ProjectRootFor(metadataDir), baseline);

    /// <summary>
    /// Build a <see cref="GenConfig"/> from the given knobs and run <paramref
    /// name="generators"/> against <paramref name="load"/>'s model via <see
    /// cref="CodegenRunner.Run"/> — the hash-manifest / overwrite-policy / merge pipeline,
    /// unchanged. A load that did not succeed, or a generator that throws a render or
    /// codegen error, surfaces as a populated <see cref="GenOutcome.LoadErrors"/> rather
    /// than a throw.
    /// </summary>
    /// <param name="generators">
    /// The resolved generator instances to run — the project's own <c>new</c>-built list
    /// (<c>codegen/Generators.cs</c>), narrowed by <see cref="SelectDeclared"/>, or a
    /// name-resolved list (<c>MetaObjects.Cli.GenCommand</c>, via <see cref="GeneratorRegistry"/>).
    /// This overload resolves no names.
    /// </param>
    /// <param name="includeNames">
    /// Whether the run's list includes the <c>names</c> generator, which decides how every other
    /// generator spells a physical name. A <c>--generators</c> narrowing passes its declared list's
    /// answer, so the entries it runs write what the whole list writes. <c>null</c> asks
    /// <paramref name="generators"/>.
    /// </param>
    /// <param name="projectRoot">
    /// Anchors <c>.metaobjects/.gen-state/</c> and the manifest's relative keys. Defaults
    /// to the current directory for a caller that names no project (mirrors
    /// <c>GenConfig.ProjectRoot</c>'s own default).
    /// </param>
    /// <param name="sweepOrphans">
    /// <paramref name="generators"/> is the project's WHOLE list, so a recorded file none of
    /// them emitted is stale output and is deleted when untouched (<see cref="GenConfig.SweepOrphans"/>).
    /// </param>
    public static GenOutcome RunGen(
        LoadResult load, string outDir, string ns, bool emitAbstractShapes,
        IReadOnlyList<IGenerator> generators, string? projectRoot = null,
        string baseline = "default",
        bool? includeNames = null,
        bool sweepOrphans = false)
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
            // ADR-0058 — one project setting, read from the loaded root rather than a CLI
            // flag or a per-project generator list: codegen and the runtime cannot disagree,
            // because neither is configured separately.
            ColumnNamingStrategy = load.Root.PhysicalNaming.Columns,
            Baseline = baseline,
            // C1 — the presence gate: is the `names` generator (NamesGenerator.Name ==
            // "names") actually part of THIS resolved list? Checked by NAME, not by
            // `is NamesGenerator`, so an OWNED copy of NamesGenerator — a different CLR
            // type, in a different assembly, once ejected — still satisfies the gate.
            IncludeNames = includeNames ?? generators.Any(g => g.Name == "names"),
            SweepOrphans = sweepOrphans,
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
    // The fixed lines of ADR-0034 Amendment 9. MetaObjects.Cli prints them too, so they live
    // here, in the one package both the CLI and a project's codegen/ reference.
    // ------------------------------------------------------------------------

    /// <summary>The project's generator list, relative to its root.</summary>
    public const string GeneratorListPath = "codegen/Generators.cs";

    /// <summary>The 1.1 docs migration guide, this port's section — the one pointer every fixed
    /// line below shares. The other ports name it once (TypeScript <c>docs-removed.ts</c>'s
    /// <c>DOCS_MIGRATION_GUIDE</c>, Python's <c>_MIGRATION_SECTION</c>, Java's
    /// <c>DocsMojo.MIGRATION</c>); moving the document is one edit here too, not a six-site grep.</summary>
    public const string DocsMigrationGuide =
        "https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/features/migrations/docs-are-generators.md, section \"C#\"";

    /// <summary>What <c>dotnet meta docs</c> prints, exit 2: the command was removed.</summary>
    public const string DocsCommandRemoved =
        "dotnet meta docs was removed in 1.1.0. `dotnet meta gen` writes documentation now: declare each docs " +
        "generator in codegen/Generators.cs. See " + DocsMigrationGuide + ".";

    /// <summary>The flags a 1.0 project passed to <c>gen</c> for documentation. Nothing reads them in 1.1.0;
    /// they are <see cref="Generators.ApiDocsGenerator"/>'s init properties now.</summary>
    public static readonly IReadOnlyList<string> LegacyDocsFlags = ["--project", "--model-base-url"];

    /// <summary>What a gen run given 1.0 docs flags prints before writing anything, exit 2.</summary>
    /// <param name="command">The command's own name: <c>dotnet meta gen</c>.</param>
    /// <param name="flags">The 1.0 flags found, in the order given.</param>
    public static string LegacyDocsConfiguration(string command, IEnumerable<string> flags) =>
        $"{command}: found 1.0 docs configuration ({string.Join(", ", flags)}). Nothing reads it any more, so this " +
        "run would write no documentation. Declare each docs generator in codegen/Generators.cs. See " +
        DocsMigrationGuide + ".";

    /// <summary>What a gen run in a project with no <c>codegen/Generators.cs</c> prints, exit 2.</summary>
    /// <param name="command">The command's own name: <c>dotnet meta gen</c> or <c>dotnet meta verify --codegen</c>.</param>
    public static string NoGeneratorList(string command) =>
        $"{command}: no codegen/Generators.cs. The generator list lives there in 1.1.0, documentation included; " +
        "`dotnet meta init` writes it. See " + DocsMigrationGuide + ".";

    /// <summary>What a gen or <c>verify --codegen</c> run prints, exit 2, when <c>codegen/Program.cs</c> does not
    /// run <c>Generators.All</c>: a 1.0 entry point declares its generators inline and would ignore the list.</summary>
    /// <param name="command">The command's own name: <c>dotnet meta gen</c> or <c>dotnet meta verify --codegen</c>.</param>
    public static string LegacyProgram(string command) =>
        $"{command}: codegen/Program.cs does not run Generators.All, so it would ignore the generator list in " +
        "codegen/Generators.cs. Replace it with the two-line entry `using MetaObjects.Codegen;` and " +
        "`return CodegenCli.Run(args, Generators.All);`. See " + DocsMigrationGuide + ".";

    /// <summary>What a gen run prints, exit 2, when it finds 1.0 template-spec configuration: a
    /// project-root <c>template-spec.json</c> no entry declares, or <c>--template-spec</c>. Through
    /// 1.0 the gen command read either; a spec now runs only as a <see cref="TemplateSpecGenerator"/>
    /// entry in the list.</summary>
    /// <param name="command">The command's own name.</param>
    /// <param name="what">What was found: <c>template-spec.json</c> or <c>--template-spec</c>.</param>
    public static string LegacyTemplateSpec(string command, string what) =>
        $"{command}: found 1.0 template-spec configuration ({what}). Nothing reads it any more, so this run " +
        "would not render its templates. Declare it in codegen/Generators.cs as " +
        "`new MetaObjects.Codegen.TemplateCodegen.TemplateSpecGenerator { Spec = \"template-spec.json\" }`. " +
        "See " + DocsMigrationGuide + ".";

    /// <summary>
    /// The 1.0 template-spec configuration a run would have read and no longer does, or <c>null</c>:
    /// <c>--template-spec</c> when given, else a <c>template-spec.json</c> at
    /// <paramref name="projectRoot"/> when no entry of <paramref name="declared"/> declares a spec.
    /// </summary>
    private static string? LegacyTemplateSpecFound(
        IReadOnlyList<IGenerator> declared, string? templateSpecFlag, string projectRoot)
    {
        if (templateSpecFlag is not null) return "--template-spec";
        if (declared.Any(g => Unwrapped(g) is TemplateSpecGenerator)) return null;
        return File.Exists(Path.Combine(projectRoot, TemplateSpecFileName)) ? TemplateSpecFileName : null;
    }

    private static IGenerator Unwrapped(IGenerator g) => g is HandEditsGenerator h ? h.Inner : g;

    /// <summary>Read every declared template spec once, so a missing or malformed file is a clean
    /// error before anything is written. <c>null</c> when they all read.</summary>
    private static string? CheckTemplateSpecs(IReadOnlyList<IGenerator> suite)
    {
        foreach (var spec in suite.Select(Unwrapped).OfType<TemplateSpecGenerator>())
        {
            try { _ = spec.Generators(); }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or JsonException)
            {
                return $"template spec {spec.Spec}: {ex.Message}";
            }
        }
        return null;
    }

    /// <summary>
    /// The entries of <paramref name="declared"/> a <c>--generators</c> selection names, in their
    /// declared order (ADR-0034 Amendment 9, rule 5). A selection never adds a generator the list
    /// does not declare: a name with no declared entry is refused, and <paramref name="error"/> says
    /// which. A name matches an entry whose <see cref="IGenerator.Name"/> it is, or whose name is the
    /// packaged generator's that the registry name builds (<c>entity</c> builds
    /// <c>entity-generator</c>), so an owned copy, which keeps the packaged name, answers to the
    /// registry name too. No selection returns <paramref name="declared"/> unchanged.
    /// </summary>
    public static IReadOnlyList<IGenerator> SelectDeclared(
        IReadOnlyList<IGenerator> declared, IReadOnlyList<string>? selection, string templateRoot, out string? error)
    {
        error = null;
        if (selection is null) return declared;
        if (selection.Count == 0)
        {
            error = "--generators names no generator.";
            return [];
        }
        var ctx = new GeneratorBuildContext(templateRoot);
        var picked = new HashSet<IGenerator>(ReferenceEqualityComparer.Instance);
        var undeclared = new List<string>();
        foreach (var name in selection)
        {
            var packagedName = GeneratorRegistry.Get(name)?.Factory(ctx).Name;
            var matches = declared.Where(g => g.Name == name || (packagedName is not null && g.Name == packagedName)).ToList();
            if (matches.Count == 0) undeclared.Add(name);
            foreach (var g in matches) picked.Add(g);
        }
        if (undeclared.Count > 0)
        {
            error =
                $"--generators names {string.Join(", ", undeclared.Select(n => $"\"{n}\""))}, which {GeneratorListPath} " +
                "does not declare. --generators only narrows the declared list; add the entry to " +
                $"{GeneratorListPath} to run it.";
            return [];
        }
        return [.. declared.Where(picked.Contains)];
    }

    /// <summary><paramref name="selected"/>, with the run's <paramref name="templateRoot"/> given to each
    /// template-spec entry that names none of its own.</summary>
    private static List<IGenerator> WithTemplateRoot(IReadOnlyList<IGenerator> selected, string templateRoot) =>
        [.. selected.Select(g => g switch
        {
            TemplateSpecGenerator { TemplateRoot: null } spec =>
                new TemplateSpecGenerator { Spec = spec.Spec, TemplateRoot = templateRoot, OutDir = spec.OutDir },
            HandEditsGenerator { Inner: TemplateSpecGenerator { TemplateRoot: null } } wrapped =>
                WithTemplateRoot([wrapped.Inner], templateRoot)[0].WithHandEdits(wrapped.HandEdits),
            _ => g,
        })];

    /// <summary>The registry names of the entries in <paramref name="generators"/> that a registry
    /// generator builds, for the advisory requires check.</summary>
    private static IReadOnlyList<string> RegistryNames(IReadOnlyList<IGenerator> generators, string templateRoot)
    {
        var ctx = new GeneratorBuildContext(templateRoot);
        var names = new List<string>();
        foreach (var entry in GeneratorRegistry.List())
        {
            string built;
            try { built = entry.Factory(ctx).Name; }
            catch (Exception ex) when (ex is ArgumentException or IOException or InvalidOperationException) { continue; }
            if (generators.Any(g => g.Name == built || g.Name == entry.Name)) names.Add(entry.Name);
        }
        return names;
    }

    // ------------------------------------------------------------------------
    // The codegen/Program.cs entry point (ADR-0034 Amendment 9): `dotnet meta gen` and
    // `dotnet meta verify --codegen` run `dotnet run --project codegen -- <forwarded args>`
    // and return ITS exit code. This is the far end of that hand-off. It takes the CLI's
    // `gen [<dir>] --out <dir> ...` / `verify --codegen [<dir>] --out <dir> ...` argument
    // surface, so the forwarding is transparent, and it owns the checks the CLI used to make
    // in process: flag refusal, the 1.0-shape refusal, the removed --column-naming flag
    // (ADR-0058) and --baseline values.
    // Template/db drift stay with `dotnet meta verify`; they do not depend on the list, and
    // cross-referencing back into MetaObjects.Cli would invert the dependency direction.
    // ------------------------------------------------------------------------

    /// <summary>
    /// The forwarded-args entry point <c>codegen/Program.cs</c> calls:
    /// <c>CodegenCli.Run(args, Generators.All)</c>. Dispatches on <c>args[0]</c> (<c>"gen"</c>
    /// or <c>"verify"</c>), prints to the console, and returns the process exit code.
    /// </summary>
    public static int Run(string[] args, IReadOnlyList<IGenerator> generators)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine(
                "usage: gen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>]\n" +
                "           [--emit-abstract-shapes] [--baseline default|adopt] [--template-root <dir>]\n" +
                "     | verify --codegen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>]\n" +
                "           [--template-root <dir>] [--lax]\n" +
                "   (column/table naming: \"naming\" in .metaobjects/config.json — ADR-0058)");
            return 2;
        }
        return args[0] switch
        {
            "gen" => RunGenArgs(args[1..], generators),
            "verify" => RunVerifyArgs(args[1..], generators),
            "docs" => Removed(),
            _ => Unknown(args[0]),
        };
    }

    private static int Removed()
    {
        Console.Error.WriteLine(DocsCommandRemoved);
        return 2;
    }

    private static int Unknown(string cmd)
    {
        Console.Error.WriteLine($"codegen: unknown command \"{cmd}\" — expected \"gen\" or \"verify\".");
        return 2;
    }

    /// <summary>The <c>--column-naming</c> spelling of <paramref name="strategy"/> — used only
    /// to format the ADR-0058 drift message below, never to parse a flag any more.</summary>
    public static string ColumnNamingFlag(ColumnNamingStrategy strategy) => strategy switch
    {
        ColumnNamingStrategy.SnakeCase => "snake_case",
        ColumnNamingStrategy.KebabCase => "kebab-case",
        _ => "literal",
    };

    /// <summary>
    /// ADR-0058 — the 1.1 physical-naming migration guide, named once so every refusal below
    /// points at the same place.
    /// </summary>
    public const string PhysicalNamingMigrationGuide =
        "https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/features/migrations/physical-naming.md";

    /// <summary>
    /// What <c>--column-naming &lt;value&gt;</c> prints, exit 2, on <c>dotnet meta gen</c> or
    /// <c>dotnet meta verify --codegen</c> (ADR-0058): column and table naming is one project
    /// setting now, read from <c>.metaobjects/config.json</c> by every port. <paramref
    /// name="value"/> is the value the user gave, so the message proposes their exact setting.
    /// </summary>
    public static string ColumnNamingFlagRemoved(string value) =>
        "--column-naming was removed in 1.1.0. Column and table naming is one project setting now, " +
        "read by every port: \"naming\" in .metaobjects/config.json, for example " +
        $"\"naming\": {{ \"columns\": \"{value}\" }}. Move it there and delete --column-naming. See " +
        PhysicalNamingMigrationGuide;

    /// <summary>
    /// The 1.0 composition of an owned list with a <c>--generators</c> selection, which ADDED
    /// packaged generators the list did not name.
    /// </summary>
    [Obsolete("A --generators selection only narrows the declared list since 1.1.0 (ADR-0034 Amendment 9). " +
              "Use SelectDeclared; this method is kept for 1.0 callers and is no longer used by Run.")]
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

    private static readonly string[] GenValueFlags =
        ["--out", "--namespace", "--generators", "--template-root", "--template-spec", "--column-naming", "--baseline"];
    private static readonly string[] GenBoolFlags = ["--emit-abstract-shapes"];
    private static readonly string[] VerifyValueFlags =
        ["--out", "--namespace", "--generators", "--template-root", "--column-naming"];
    private static readonly string[] VerifyBoolFlags = ["--codegen", "--lax"];

    /// <summary>The flags both commands share, parsed once.</summary>
    private sealed class OwnedArgs
    {
        public string? MetadataDir, OutDir, TemplateRoot, TemplateSpecPath, ColumnNamingRaw, GeneratorsCsv;
        public string Namespace = "Generated";
        public string Baseline = "default";
        public bool NamespaceExplicit, EmitAbstractShapes, Codegen, Lax;
        /// <summary>1.0 docs flags given (<see cref="LegacyDocsFlags"/>), in order.</summary>
        public List<string> LegacyDocs = [];
        /// <summary>The usage error the arguments earn, or <c>null</c>.</summary>
        public string? Refusal;

        public IReadOnlyList<string>? Selection => GeneratorsCsv
            ?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        public static OwnedArgs Parse(string[] rest, string command, string[] valueFlags, string[] boolFlags)
        {
            var a = new OwnedArgs();
            for (int i = 0; i < rest.Length; i++)
            {
                var flag = rest[i];
                // A 1.0 docs flag is recorded, with its value, and refused by the caller with the
                // amendment's line: it is not an unknown flag, it is configuration that moved.
                if (LegacyDocsFlags.Contains(flag))
                {
                    if (!a.LegacyDocs.Contains(flag)) a.LegacyDocs.Add(flag);
                    if (i + 1 < rest.Length && !rest[i + 1].StartsWith('-')) i++;
                    continue;
                }
                if (flag.StartsWith("--baseline=", StringComparison.Ordinal)) { a.Baseline = flag["--baseline=".Length..]; continue; }
                if (!flag.StartsWith('-')) { a.MetadataDir ??= flag; continue; }
                if (valueFlags.Contains(flag))
                {
                    if (i + 1 >= rest.Length)
                    {
                        a.Refusal ??= $"{command}: {flag} needs a value";
                        continue;
                    }
                    var value = rest[++i];
                    switch (flag)
                    {
                        case "--out": a.OutDir = value; break;
                        case "--namespace": a.Namespace = value; a.NamespaceExplicit = true; break;
                        case "--column-naming": a.ColumnNamingRaw = value; break;
                        case "--baseline": a.Baseline = value; break;
                        case "--template-root": a.TemplateRoot = value; break;
                        case "--template-spec": a.TemplateSpecPath = value; break;
                        case "--generators": a.GeneratorsCsv = value; break;
                    }
                }
                else if (boolFlags.Contains(flag))
                {
                    if (flag == "--emit-abstract-shapes") a.EmitAbstractShapes = true;
                    else if (flag == "--codegen") a.Codegen = true;
                    else if (flag == "--lax") a.Lax = true;
                }
                else
                {
                    // An unrecognised flag used to be dropped: a run with a typo'd flag
                    // generated and exited 0, as if the flag had been honoured.
                    var valid = valueFlags.Concat(boolFlags).Order(StringComparer.Ordinal);
                    a.Refusal ??= $"unknown flag {flag} for `{command}`. Valid flags: {string.Join(", ", valid)}";
                }
            }
            return a;
        }
    }

    /// <summary>The project's declared <c>csharp.outDir</c> into <paramref name="outDir"/>, null when
    /// it declares none or has no metadata collection yet (the caller then reports usage, which
    /// names the setting). Returns false, after printing the error, when the location or config is
    /// malformed, so the real cause is shown instead of a usage line.</summary>
    private static bool TryConfiguredOutDir(string? metadataDir, out string? outDir)
    {
        outDir = null;
        try
        {
            outDir = MetadataLocation.Resolve(metadataDir, Directory.GetCurrentDirectory()).OutDir;
            return true;
        }
        catch (MetaModelException e) when (e.Code == ErrorCode.ERR_COLLECTION_NOT_FOUND)
        {
            return true;
        }
        catch (Exception e) when (e is MetaModelException or MetadataLocationException)
        {
            return ResolveOrReport(metadataDir) is not null;
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

    private const string GenCommandName = "dotnet meta gen";
    private const string VerifyCommandName = "dotnet meta verify --codegen";

    private static int RunGenArgs(string[] rest, IReadOnlyList<IGenerator> declared)
    {
        var a = OwnedArgs.Parse(rest, GenCommandName, GenValueFlags, GenBoolFlags);
        if (a.Refusal is not null)
        {
            Console.Error.WriteLine(a.Refusal);
            return 2;
        }
        // Before anything is resolved or written: a run that still carries 1.0 docs flags would
        // otherwise pass while writing no documentation.
        if (a.LegacyDocs.Count > 0)
        {
            Console.Error.WriteLine(LegacyDocsConfiguration(GenCommandName, a.LegacyDocs));
            return 2;
        }

        // ADR-0058 — column and table naming is one project setting now, read from
        // .metaobjects/config.json by every port; the flag is refused rather than silently
        // dropped, since the old value may have been right for that adopter's database.
        if (a.ColumnNamingRaw is not null)
        {
            Console.Error.WriteLine(ColumnNamingFlagRemoved(a.ColumnNamingRaw));
            return 2;
        }
        // Same rule. `fresh` is deliberately NOT accepted — TypeScript implements it and this
        // port does not, and taking the value while refusing files anyway would be a
        // cross-port lie. The error says so rather than leaving the reader to infer it.
        if (a.Baseline is not ("default" or "adopt"))
        {
            Console.Error.WriteLine(
                $"error: unknown --baseline \"{a.Baseline}\"; this port implements 'default' and 'adopt'. " +
                "To discard a refused file's content here, delete the file and re-run — it is then " +
                "written as new. (TypeScript's '--baseline=fresh' does that in one step; it is not " +
                "implemented in this port.)");
            return 2;
        }
        // Usage-first: a missing --out is a plain usage error, and must win over the metadata
        // ladder's own possible ERR_COLLECTION_NOT_FOUND below.
        // An omitted --out falls back to the project's declared `csharp.outDir`, the same
        // directory `dotnet meta verify` diffs, so gen and verify cannot disagree.
        if (a.OutDir is null)
        {
            if (!TryConfiguredOutDir(a.MetadataDir, out var configuredOut)) return 2;
            a.OutDir = configuredOut;
        }
        if (a.OutDir is null)
        {
            Console.Error.WriteLine("usage: dotnet meta gen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>] [...]");
            Console.Error.WriteLine("  (or set \"csharp\": { \"outDir\": \"<dir>\" } in .metaobjects/config.json)");
            return 2;
        }
        if (ResolveOrReport(a.MetadataDir) is not { } meta) return 2;

        var projectRoot = a.MetadataDir is not null ? ProjectRootFor(a.MetadataDir) : Directory.GetCurrentDirectory();
        if (LegacyTemplateSpecFound(declared, a.TemplateSpecPath, projectRoot) is { } legacySpec)
        {
            Console.Error.WriteLine(LegacyTemplateSpec(GenCommandName, legacySpec));
            return 2;
        }
        var templateRoot = a.TemplateRoot ?? DefaultTemplateRoot();
        var selected = SelectDeclared(declared, a.Selection, templateRoot, out var selectError);
        if (selectError is not null)
        {
            Console.Error.WriteLine($"error: {selectError}");
            return 2;
        }
        var suite = WithTemplateRoot(selected, templateRoot);
        if (CheckTemplateSpecs(suite) is { } specError)
        {
            Console.Error.WriteLine($"  error: {specError}");
            Console.Error.WriteLine($"{GenCommandName}: FAILED");
            return 1;
        }

        // A list that is present and empty is not an error: it writes nothing and says so.
        if (suite.Count == 0)
        {
            Console.WriteLine($"{GenCommandName}: {GeneratorListPath} declares no generators; nothing written");
            return 0;
        }

        // Advisory, before the run: a generator declared without the ones its output
        // references still generates, but the result will not compile.
        foreach (var w in GeneratorRegistry.UnsatisfiedRequires(RegistryNames(declared, templateRoot)))
            Console.Error.WriteLine($"warning: {w}");

        // ADR-0023: gen loads leniently; name what `verify` would reject instead of staying silent.
        WarnUnknownAttrs(meta);
        var outcome = RunGen(meta.Load(), a.OutDir, a.Namespace, a.EmitAbstractShapes, suite, projectRoot, a.Baseline,
            includeNames: declared.Any(g => g.Name == "names"),
            // Only a run of the whole declared list can tell a stale file from one the
            // narrowing left out.
            sweepOrphans: a.Selection is not { Count: > 0 });
        if (!outcome.Ok)
        {
            ReportFailure(outcome, GenCommandName);
            return 1;
        }
        foreach (var f in outcome.Result!.Files) Console.WriteLine($"  {f.Status}: {f.Path}");
        foreach (var w in outcome.Result!.Warnings) Console.Error.WriteLine($"  warning: {w}");
        var writtenCount = outcome.Result!.Files.Count(f => f.Status == "written");
        var removedCount = outcome.Result!.Files.Count(f => f.Status == "removed");
        Console.WriteLine($"{GenCommandName}: {writtenCount} file(s) written" +
            (removedCount > 0 ? $", {removedCount} file(s) no generator emits any more removed" : ""));

        // A refusal is a FAILED gate, matching TypeScript's `meta gen` (exit 1): an adopter
        // wiring gen into CI as a drift gate must not be green while codegen refused to write.
        var refusedCount = outcome.Result!.Files.Count(f => f.Status == "refused");
        if (refusedCount > 0)
        {
            Console.Error.WriteLine(
                $"{GenCommandName}: FAILED — {refusedCount} file(s) refused (see the warnings above; " +
                "`--baseline=adopt` records what you have and writes nothing)");
            return 1;
        }
        return 0;
    }

    /// <summary>
    /// The other physical naming that reproduces the committed output exactly, or <c>null</c>.
    /// Tries every other combination of the two ADR-0058 rules: another column rule alone,
    /// then another table rule alone, then both together (<see cref="NamingCandidates"/>).
    /// Each probe regenerates from a FRESH load carrying the candidate: the table rule reaches
    /// codegen through the root, and a loaded tree caches what it resolved from it
    /// (<see cref="MetaObject.DbTable"/>), so re-pointing the already-generated root would
    /// keep the table names the first regen resolved.
    /// </summary>
    private static PhysicalNaming? MatchingNaming(
        GenConfig config, Func<MetaRoot> load, IReadOnlyList<IGenerator> suite, bool narrowed, PhysicalNaming used)
    {
        foreach (var candidate in NamingCandidates(used))
        {
            var root = load();
            root.PhysicalNaming = candidate;
            var probe = CodegenDrift.Compute(config with { ColumnNamingStrategy = candidate.Columns }, root, suite, narrowed);
            if (probe.Error is null && probe.Clean) return candidate;
        }
        return null;
    }

    /// <summary>
    /// Every naming other than <paramref name="used"/>, in the order verify probes them (the
    /// Python port probes the same order): the used table rule first, so a different column
    /// rule alone is tried before a different table rule; within each, the used column rule
    /// first, then snake_case, literal, kebab-case.
    /// </summary>
    private static IEnumerable<PhysicalNaming> NamingCandidates(PhysicalNaming used)
    {
        ColumnNamingStrategy[] columns =
            [ColumnNamingStrategy.SnakeCase, ColumnNamingStrategy.Literal, ColumnNamingStrategy.KebabCase];
        TableNamingRule[] tables = [TableNamingRule.SnakeCase, TableNamingRule.Literal];
        foreach (var t in tables.OrderBy(t => t == used.Tables ? 0 : 1))
            foreach (var c in columns.OrderBy(c => c == used.Columns ? 0 : 1))
                if (new PhysicalNaming(c, t) is var candidate && candidate != used)
                    yield return candidate;
    }

    /// <summary>The <c>naming.tables</c> spelling of <paramref name="rule"/> in
    /// <c>.metaobjects/config.json</c>, for the ADR-0058 drift message below.</summary>
    private static string TableNamingSpelling(TableNamingRule rule) =>
        rule == TableNamingRule.Literal ? "literal" : "snake_case";

    /// <summary>A naming as the <c>naming</c> block that declares it.</summary>
    private static string NamingBlock(PhysicalNaming naming) =>
        $"\"naming\": {{ \"columns\": \"{ColumnNamingFlag(naming.Columns)}\", " +
        $"\"tables\": \"{TableNamingSpelling(naming.Tables)}\" }}";

    /// <summary>What <c>verify --codegen</c> says, in place of "regenerate", when the committed output was
    /// generated with <paramref name="committed"/> and this run used <paramref name="used"/> — the rules
    /// ADR-0058 reads from <c>.metaobjects/config.json</c> (each defaults to <c>snake_case</c>). The
    /// Python port prints the same text.</summary>
    private static string NamingDiffers(PhysicalNaming committed, PhysicalNaming used) =>
        $"The committed output was generated with {NamingBlock(committed)}; this run used " +
        $"{NamingBlock(used)} (.metaobjects/config.json; each rule defaults to snake_case). Do not " +
        "regenerate: that rewrites column or table names to ones the database does not have. Declare " +
        $"{NamingBlock(committed)} in .metaobjects/config.json, and gen and verify --codegen both read it.";

    /// <summary>
    /// The other wire setting (ADR-0019 Amendment 2) that reproduces the committed output
    /// exactly, or <c>null</c>. Candidates are every combination of the two keys other than
    /// <paramref name="used"/>, native before string and native before emit before omit;
    /// <c>emit</c> is never offered, because in C# it generates what <c>native</c> does.
    /// </summary>
    private static WireFormat? MatchingWire(
        GenConfig config, Func<MetaRoot> load, IReadOnlyList<IGenerator> suite, bool narrowed, WireFormat used)
    {
        var generated = used.NullMembers == NullMemberForm.Emit ? used with { NullMembers = NullMemberForm.Native } : used;
        foreach (var decimals in new[] { DecimalWireForm.Native, DecimalWireForm.String })
            foreach (var nulls in new[] { NullMemberForm.Native, NullMemberForm.Omit })
            {
                var candidate = new WireFormat(decimals, nulls);
                if (candidate == generated) continue;
                var root = load();
                root.WireFormat = candidate;
                var probe = CodegenDrift.Compute(config, root, suite, narrowed);
                if (probe.Error is null && probe.Clean) return candidate;
            }
        return null;
    }

    /// <summary>What <c>verify --codegen</c> says, in place of "regenerate", when the committed output
    /// was generated with the wire setting <paramref name="committed"/> and this run used
    /// <paramref name="used"/>. The Python port prints the same text.</summary>
    private static string WireDiffers(WireFormat committed, WireFormat used) =>
        $"The committed output was generated with {committed.Block()}; this run used {used.Block()} " +
        "(.metaobjects/config.json; each key defaults to native). Do not regenerate: that changes the " +
        "JSON your API writes for decimals or for a value object's null members. Declare " +
        $"{committed.Block()} in .metaobjects/config.json, and gen and verify --codegen both read it.";

    private static int RunVerifyArgs(string[] rest, IReadOnlyList<IGenerator> declared)
    {
        var a = OwnedArgs.Parse(rest, VerifyCommandName, VerifyValueFlags, VerifyBoolFlags);
        if (a.Refusal is not null)
        {
            Console.Error.WriteLine(a.Refusal);
            return 2;
        }
        if (!a.Codegen)
        {
            Console.Error.WriteLine(
                "codegen verify: this runner only handles `verify --codegen` — template/db drift stay " +
                "with `dotnet meta verify` (they do not depend on the generator list).");
            return 2;
        }

        // ADR-0058 — see RunGenArgs's identical refusal.
        if (a.ColumnNamingRaw is not null)
        {
            Console.Error.WriteLine(ColumnNamingFlagRemoved(a.ColumnNamingRaw));
            return 2;
        }
        if (a.OutDir is null)
        {
            if (!TryConfiguredOutDir(a.MetadataDir, out var configuredOut)) return 2;
            a.OutDir = configuredOut;
        }
        if (a.OutDir is null)
        {
            Console.Error.WriteLine("usage: verify --codegen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>]");
            Console.Error.WriteLine("  (or set \"csharp\": { \"outDir\": \"<dir>\" } in .metaobjects/config.json)");
            return 2;
        }
        if (ResolveOrReport(a.MetadataDir) is not { } meta) return 2;

        // Strict unless --lax, as `dotnet meta verify` is (ADR-0023).
        var load = meta.Load(strict: !a.Lax);
        if (load.Errors.Count > 0)
        {
            foreach (var e in load.Errors) Console.Error.WriteLine($"  load error: {e.Code}: {e.Message}");
            Console.Error.WriteLine($"{VerifyCommandName}: FAILED (metadata did not load cleanly)");
            return 1;
        }

        // The same suite `gen` builds: verify must regenerate what gen wrote, or it convicts
        // gen's own output as drift.
        var projectRoot = a.MetadataDir is not null ? ProjectRootFor(a.MetadataDir) : Directory.GetCurrentDirectory();
        if (LegacyTemplateSpecFound(declared, null, projectRoot) is { } legacySpec)
        {
            Console.Error.WriteLine(LegacyTemplateSpec(VerifyCommandName, legacySpec));
            return 2;
        }
        var templateRoot = a.TemplateRoot ?? DefaultTemplateRoot();
        var selected = SelectDeclared(declared, a.Selection, templateRoot, out var selectError);
        if (selectError is not null)
        {
            Console.Error.WriteLine($"error: {selectError}");
            return 2;
        }
        var suite = WithTemplateRoot(selected, templateRoot);
        if (CheckTemplateSpecs(suite) is { } specError)
        {
            Console.Error.WriteLine($"  error: {specError}");
            return 2;
        }
        // An empty list writes nothing, so there is nothing to compare: gen made no directory.
        if (suite.Count == 0)
        {
            Console.WriteLine($"{VerifyCommandName}: {GeneratorListPath} declares no generators; nothing to check");
            return 0;
        }

        // Same inference rule `dotnet meta verify --codegen` has always used: an explicit
        // --namespace always wins; otherwise infer from the committed output so a regen
        // matches output produced with any namespace (avoids spurious drift).
        var effectiveNs = a.NamespaceExplicit ? a.Namespace : (CodegenDrift.InferNamespace(a.OutDir) ?? a.Namespace);
        // ADR-0058 — the loaded root carries the project's column rule; `gen` read it the
        // same way producing the committed output, so this regen agrees with it by
        // construction instead of needing a flag told to match.
        var columnNaming = load.Root.PhysicalNaming.Columns;
        var config = new GenConfig
        {
            OutDir = a.OutDir,
            Namespace = effectiveNs,
            ColumnNamingStrategy = columnNaming,
            IncludeNames = declared.Any(g => g.Name == "names"),
            // The manifest gen keeps: an extra file is classified by what gen recorded writing.
            GenStateDir = Path.Combine(projectRoot, ".metaobjects", ".gen-state"),
            ProjectRoot = projectRoot,
        };
        var result = CodegenDrift.Compute(config, load.Root, suite, narrowed: a.Selection is { Count: > 0 });
        if (result.Error is not null)
        {
            Console.Error.WriteLine($"  {result.Error}");
            return 2;
        }
        if (result.Clean)
        {
            Console.WriteLine($"{VerifyCommandName}: OK (generated output is in sync)");
            return 0;
        }
        Console.Error.WriteLine($"{VerifyCommandName}: drift ({result.DriftedFiles.Count} file(s) differ from a fresh regen):");
        foreach (var line in result.Lines) Console.Error.WriteLine($"  {line}");
        // The committed output may be right and this run's naming wrong: the naming reaches
        // every column and table name, so regenerating would commit the wrong names. When
        // another naming reproduces the committed tree exactly, say that instead of "regenerate".
        var naming = load.Root.PhysicalNaming;
        if (MatchingNaming(config, () => meta.Load(strict: !a.Lax).Root, suite, a.Selection is { Count: > 0 }, naming) is { } committed)
        {
            Console.Error.WriteLine(NamingDiffers(committed, naming));
            return 1;
        }
        // The same for the wire setting: it reaches every decimal property's converter and every
        // value object's null handling, so a regen under the wrong one changes the API's JSON.
        var wire = load.Root.WireFormat;
        if (MatchingWire(config, () => meta.Load(strict: !a.Lax).Root, suite, a.Selection is { Count: > 0 }, wire) is { } committedWire)
        {
            Console.Error.WriteLine(WireDiffers(committedWire, wire));
            return 1;
        }
        foreach (var line in CodegenDrift.Remedy(result)) Console.Error.WriteLine(line);
        return 1;
    }
}
