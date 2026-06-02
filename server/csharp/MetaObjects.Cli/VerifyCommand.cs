// `dotnet meta verify` — the build-time template drift gate (FR-004 Plan #3, T6;
// extended to template.output by FR6, ADR-0010).
//
// Loads metadata from a directory; for each template node derives the
// @payloadRef view-object's field tree and dispatches on subtype:
//
//   template.prompt — resolves @textRef via a filesystem provider and runs the
//                     engine's Verify (template variable ↔ payload field drift,
//                     unresolved partials, missing output tags).
//   template.output — payload-VO resolution check only (the generator derives
//                     the parser schema from the same VO, so any field-tree
//                     drift surfaces here as well as at gen time).
//
// Runs at the last fixed point before serve, never on the request path.

using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Render;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Cli;

/// <summary>The verify command's pure logic — no console I/O, so it is testable.</summary>
public static class VerifyCommand
{
    /// <summary><c>Kind</c> distinguishes prompt vs. output drift findings (ADR-0010).</summary>
    public sealed record Drift(string Template, string Kind, string Code, string Path);

    public sealed record Outcome(
        IReadOnlyList<string> LoadErrors,
        IReadOnlyList<Drift> Errors,
        IReadOnlyList<Drift> Warnings,
        IReadOnlyList<string> UnresolvedText)
    {
        /// <summary>Clean iff no load errors, no drift errors, and every @textRef resolved.</summary>
        public bool Ok => LoadErrors.Count == 0 && Errors.Count == 0 && UnresolvedText.Count == 0;
    }

    /// <summary>Drift-finding kind constant — set on every <see cref="Drift"/>.</summary>
    public const string KIND_PROMPT = "prompt";
    /// <summary>Drift-finding kind constant — set on every <see cref="Drift"/>.</summary>
    public const string KIND_OUTPUT = "output";

    /// <summary>A drift error code emitted when a template's @payloadRef does not resolve
    /// to a loaded object.value. Both subtypes raise this; the codegen would otherwise
    /// fail at gen time, but verify catches it at the build-time fixed point.</summary>
    public const string ERR_PAYLOAD_REF_UNRESOLVED = "ERR_PAYLOAD_REF_UNRESOLVED";

    // ------------------------------------------------------------------------
    // ADR-0021 D2 — explicit verify subverbs (--templates / --codegen / --db).
    // ------------------------------------------------------------------------

    /// <summary>The message printed when <c>--db</c> is requested in the C# port.</summary>
    public const string DB_NOT_SUPPORTED =
        "verify --db: schema drift is not supported in the C# port; schema verify is the " +
        "migrate engine (the TypeScript `meta verify --db`). Use 'dotnet meta verify --codegen' " +
        "for generated-output drift, or '--templates' for template/prompt drift.";

    /// <summary>The one-line note bare <c>verify</c> prints advertising the subverbs.</summary>
    public const string SUBVERB_NOTE =
        "dotnet meta verify — running --templates (default). Explicit subverbs: " +
        "--templates (prompt drift), --codegen (regen-vs-committed drift); " +
        "--db is not supported in the C# port.";

    /// <summary>Parsed verify subverb selection + inputs (no console I/O).</summary>
    public sealed record Options
    {
        /// <summary>Metadata directory (positional arg).</summary>
        public required string MetadataDir { get; init; }
        /// <summary>Templates root for the <c>--templates</c> gate (<c>--templates &lt;root&gt;</c>).</summary>
        public string? TemplatesRoot { get; init; }
        /// <summary>The committed output dir for the <c>--codegen</c> gate (<c>--out &lt;dir&gt;</c>).</summary>
        public string? OutDir { get; init; }
        /// <summary>Code-gen namespace (only affects the temp regen; default mirrors `gen`).</summary>
        public string Namespace { get; init; } = "Generated";
        /// <summary>Optional generator selection for the <c>--codegen</c> regen (else the default suite).</summary>
        public IReadOnlyList<string>? Generators { get; init; }
        /// <summary>Template root for render-helper/template generators in the codegen regen.</summary>
        public string? TemplateRoot { get; init; }

        /// <summary><c>--templates</c> requested.</summary>
        public bool Templates { get; init; }
        /// <summary><c>--codegen</c> requested.</summary>
        public bool Codegen { get; init; }
        /// <summary><c>--db</c> requested (rejected in C#).</summary>
        public bool Db { get; init; }

        /// <summary>True when no explicit subverb flag was passed (bare verify).</summary>
        public bool NoExplicitSubverb => !Templates && !Codegen && !Db;
    }

    /// <summary>The aggregate outcome of a subverb dispatch (pure; no console I/O).</summary>
    public sealed record SubverbResult
    {
        /// <summary>Aggregate exit code: max across selected modes (non-zero on ANY drift).</summary>
        public int ExitCode { get; init; }
        /// <summary>True when the templates gate ran (selected, or the bare-verify default).</summary>
        public bool RanTemplates { get; init; }
        /// <summary>True when the codegen gate ran.</summary>
        public bool RanCodegen { get; init; }
        /// <summary>True when bare-verify defaulted to templates and the subverb note applies.</summary>
        public bool EmittedDefaultNote { get; init; }
        /// <summary>The templates-gate outcome (null when not run).</summary>
        public Outcome? Templates { get; init; }
        /// <summary>The codegen-gate outcome (null when not run).</summary>
        public Codegen.CodegenDrift.Result? Codegen { get; init; }
        /// <summary>Set when <c>--db</c> was requested (rejection message).</summary>
        public string? DbRejectionMessage { get; init; }
    }

    /// <summary>
    /// Dispatch the requested verify subverbs and aggregate the exit code (ADR-0021 D2).
    /// Each selected mode runs; the overall exit is the MAX (non-zero on any drift).
    /// A bare <c>verify</c> (no explicit flag) defaults to <c>--templates</c> (back-compat)
    /// and flags <see cref="SubverbResult.EmittedDefaultNote"/> so the caller prints the
    /// subverb note. <c>--db</c> is rejected with exit 2 (schema verify = the migrate engine).
    /// Pure logic — no console I/O — so it is testable.
    /// </summary>
    public static SubverbResult RunSubverbs(Options opts)
    {
        // Bare verify defaults to templates (back-compat) + a one-line subverb note.
        var defaulted = opts.NoExplicitSubverb;
        var runTemplates = opts.Templates || defaulted;
        var runCodegen = opts.Codegen;

        int exit = 0;

        Outcome? templatesOutcome = null;
        if (runTemplates)
        {
            templatesOutcome = Run(opts.MetadataDir, opts.TemplatesRoot ?? "");
            if (!templatesOutcome.Ok) exit = Math.Max(exit, 1);
        }

        Codegen.CodegenDrift.Result? codegenResult = null;
        if (runCodegen)
        {
            codegenResult = RunCodegenDrift(opts);
            // error (nothing to diff against) → exit 2; drift → exit 1; clean → 0.
            int codegenExit = codegenResult.Error is not null ? 2 : (codegenResult.Clean ? 0 : 1);
            exit = Math.Max(exit, codegenExit);
        }

        string? dbMsg = null;
        if (opts.Db)
        {
            dbMsg = DB_NOT_SUPPORTED;
            exit = Math.Max(exit, 2);
        }

        return new SubverbResult
        {
            ExitCode = exit,
            RanTemplates = runTemplates,
            RanCodegen = runCodegen,
            EmittedDefaultNote = defaulted,
            Templates = templatesOutcome,
            Codegen = codegenResult,
            DbRejectionMessage = dbMsg,
        };
    }

    /// <summary>
    /// Run the codegen-drift gate: load metadata, resolve the generator suite (default
    /// or the <c>--generators</c> selection), and diff a fresh regen against the
    /// committed <c>--out</c> dir. Loader / unknown-generator problems surface as a
    /// drift <see cref="Codegen.CodegenDrift.Result.Error"/> (exit 2), never a throw.
    /// </summary>
    private static Codegen.CodegenDrift.Result RunCodegenDrift(Options opts)
    {
        if (opts.OutDir is null)
            return new Codegen.CodegenDrift.Result
            {
                Clean = false,
                Error = "verify --codegen: no --out <dir> given — cannot locate the committed " +
                        "generated output to diff against.",
            };

        var load = MetaDataLoader.FromDirectory(opts.MetadataDir);
        if (load.Errors.Count > 0)
            return new Codegen.CodegenDrift.Result
            {
                Clean = false,
                Error = "verify --codegen: metadata did not load cleanly (" +
                        string.Join(", ", load.Errors.Select(e => e.Code.ToString())) + ").",
            };

        var names = opts.Generators is { Count: > 0 }
            ? opts.Generators
            : GenCommand.DefaultGeneratorNames;
        IReadOnlyList<IGenerator> generators;
        try
        {
            generators = GeneratorRegistry.Resolve(names, new GeneratorBuildContext(opts.TemplateRoot));
        }
        catch (ArgumentException ex)
        {
            return new Codegen.CodegenDrift.Result { Clean = false, Error = $"verify --codegen: {ex.Message}" };
        }

        var config = new GenConfig { OutDir = opts.OutDir, Namespace = opts.Namespace };
        return Codegen.CodegenDrift.Compute(config, load.Root, generators);
    }

    /// <summary>Coerce a string-array attr (array, or a single string) into a string list.</summary>
    private static IReadOnlyList<string> AsStringList(object? attr) => attr switch
    {
        IReadOnlyList<string> ss => ss.ToList(),
        IReadOnlyList<object?> os => os.OfType<string>().ToList(),
        string s => [s],
        _ => [],
    };

    public static Outcome Run(string metadataDir, string templatesRoot)
    {
        var load = MetaDataLoader.FromDirectory(metadataDir);
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();

        var provider = new FilesystemProvider(templatesRoot);
        var errors = new List<Drift>();
        var warnings = new List<Drift>();
        var unresolved = new List<string>();

        foreach (var tmpl in load.Root.OwnChildren().Where(c => c.Type == TYPE_TEMPLATE))
        {
            // Missing @payloadRef is already a load error (template schema requires it).
            if (tmpl.OwnAttr(TEMPLATE_ATTR_PAYLOAD_REF) is not string payloadRef)
                continue;

            var kind = tmpl.SubType == TEMPLATE_SUBTYPE_OUTPUT ? KIND_OUTPUT : KIND_PROMPT;

            // Both subtypes: @payloadRef must resolve to a loaded object.value (=>
            // non-empty derived field tree). Catches a renamed VO before codegen.
            var fields = PayloadCodegen.BuildPayloadFieldTree(load.Root, payloadRef);
            if (fields.Count == 0)
            {
                errors.Add(new Drift(tmpl.Name, kind, ERR_PAYLOAD_REF_UNRESOLVED, payloadRef));
                continue;
            }

            if (tmpl.SubType == TEMPLATE_SUBTYPE_OUTPUT)
            {
                // Output's parser schema is derived from the same VO that drives prompt
                // rendering — payload-VO resolution above covers FR6's drift contract.
                // No @textRef walk: output templates may not carry one (the parser is
                // schema-driven), and the generator surfaces gen-time issues directly.
                continue;
            }

            // template.prompt branch — existing Mustache + tag/slot checks.
            if (tmpl.OwnAttr(TEMPLATE_ATTR_TEXT_REF) is not string textRef)
                continue;

            var text = provider.Resolve(textRef);
            if (text is null)
            {
                unresolved.Add($"template \"{tmpl.Name}\": @textRef \"{textRef}\" did not resolve under {templatesRoot}");
                continue;
            }

            var requiredSlots = AsStringList(tmpl.OwnAttr(TEMPLATE_ATTR_REQUIRED_SLOTS));
            var requiredTags = AsStringList(tmpl.OwnAttr(TEMPLATE_ATTR_REQUIRED_TAGS));

            var verifyOptions = new VerifyOptions
            {
                Provider = provider,
                RequiredSlots = requiredSlots,
                RequiredTags = requiredTags,
            };
            foreach (var e in Verify.Check(text, fields, verifyOptions))
            {
                var drift = new Drift(tmpl.Name, kind, e.Code, e.Path);
                if (e.Code == Verify.ERR_REQUIRED_SLOT_UNUSED) warnings.Add(drift);
                else errors.Add(drift);
            }
        }

        return new Outcome(loadErrors, errors, warnings, unresolved);
    }
}
