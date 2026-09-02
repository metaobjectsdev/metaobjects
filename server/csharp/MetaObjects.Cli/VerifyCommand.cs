// `dotnet meta verify` — the build-time template drift gate (FR-004 Plan #3, T6;
// extended to template.output by FR6, ADR-0010).
//
// Loads metadata from a directory; for each template node derives the
// @payloadRef view-object's field tree, resolves every renderable body ref via a
// filesystem provider, and runs the engine's Verify on each (template variable ↔
// payload field drift, unresolved partials, and — prompts only — missing output
// tags). The body refs are subtype-/kind-aware, mirroring the gen-time
// render-helper so verify and gen agree (#193):
//
//   template.prompt                    — @textRef (WITH @requiredSlots/@requiredTags).
//   template.output document (default) — @textRef.
//   template.output @kind=email        — @subjectRef + @htmlBodyRef + optional @textBodyRef.
//
// Runs at the last fixed point before serve, never on the request path.

using System.Text.Json;
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

    /// <summary>
    /// Actionable hint (#96 / ADR-0023) printed when a strict load rejects an
    /// undeclared own <c>@attr</c> (<c>ERR_UNKNOWN_ATTR</c>) — names the three exits.
    /// </summary>
    public const string UNKNOWN_ATTR_HINT =
        "verify loads strict by default (ADR-0023): an unregistered or typo'd @attr is " +
        "ERR_UNKNOWN_ATTR. To fix: register the attr on a metadata provider, OR move " +
        "arbitrary author-supplied properties into an `attr.properties` bag, OR run " +
        "'dotnet meta verify --lax' to keep the legacy open-attr load.";

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
        /// <summary>
        /// When set, the ALREADY-RESOLVED (and <c>_pending</c>-draft-excluded) file list
        /// the CLI's <c>.metaobjects/config.json</c> ladder path computed
        /// (<c>Program.cs</c>'s <c>ResolveMetadataDirOrExit</c>) — both subverb gates load
        /// from this via <c>MetaDataLoader.FromUris</c> instead of re-walking
        /// <see cref="MetadataDir"/> via <c>FromDirectory</c>, which would both duplicate
        /// the walk already done to resolve it AND silently lose the exclusion
        /// (<c>FromDirectory</c>'s own default is to include <c>_pending</c>). Null when
        /// <see cref="MetadataDir"/> came from an explicit CLI argument instead.
        /// </summary>
        public IReadOnlyList<string>? MetadataFiles { get; init; }
        /// <summary>Templates root for the <c>--templates</c> gate (<c>--templates &lt;root&gt;</c>).</summary>
        public string? TemplatesRoot { get; init; }
        /// <summary>The committed output dir for the <c>--codegen</c> gate (<c>--out &lt;dir&gt;</c>).</summary>
        public string? OutDir { get; init; }
        /// <summary>Code-gen namespace (only affects the temp regen; default mirrors `gen`).</summary>
        public string Namespace { get; init; } = "Generated";
        /// <summary>True when the user explicitly passed <c>--namespace</c>. When false and
        /// <c>--codegen</c> runs, the namespace is inferred from the committed output so a
        /// regen matches output generated with any namespace (avoids spurious drift).</summary>
        public bool NamespaceExplicit { get; init; }
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

        /// <summary>
        /// Strict metadata load (ADR-0023 / #96). Default <c>true</c>: an undeclared or
        /// typo'd own <c>@attr</c> is <c>ERR_UNKNOWN_ATTR</c> and verify fails — matching
        /// Java's force-strict Maven goal and the strict TS/Python verify CLIs. <c>--lax</c>
        /// sets this <c>false</c> to restore the legacy open-attr load. Only <c>verify</c>
        /// defaults strict; <c>gen</c>/<c>docs</c>/<c>agent-docs</c> stay lax.
        /// </summary>
        public bool Strict { get; init; } = true;

        /// <summary>
        /// The <c>--column-naming</c> strategy the committed <c>--out</c> was produced
        /// with (default <see cref="ColumnNamingStrategy.Literal"/>, matching <c>gen</c>'s
        /// default). Only consumed by the <c>--codegen</c> gate's own regen — see
        /// <see cref="RunCodegenDrift"/>. A regen defaulting to <c>Literal</c> while the
        /// committed output was produced with, say, <c>gen --column-naming snake_case</c>
        /// convicts every <c>&lt;Entity&gt;Names.g.cs</c> physical-column constant as
        /// drift on an otherwise-clean project — the gate must be told which strategy to
        /// regenerate under, exactly like <c>--namespace</c> above.
        /// </summary>
        public ColumnNamingStrategy ColumnNaming { get; init; } = ColumnNamingStrategy.Literal;

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
            templatesOutcome = Run(LoadMetadata(opts), opts.TemplatesRoot ?? "");
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
    /// Loads <paramref name="opts"/>'s metadata once, the same way for both subverb
    /// gates: via the pre-resolved <see cref="Options.MetadataFiles"/> (config-ladder
    /// path — <c>MetaDataLoader.FromUris</c>, no re-walk, <c>_pending</c> already
    /// excluded) when present, else <c>FromDirectory(opts.MetadataDir)</c> (an
    /// explicit CLI argument — the legacy, unfiltered directory load).
    /// </summary>
    private static LoadResult LoadMetadata(Options opts) => opts.MetadataFiles is { } files
        ? MetaDataLoader.FromUris(files.Select(f => new Uri(f)).ToList(), opts.Strict)
        : MetaDataLoader.FromDirectory(opts.MetadataDir, strict: opts.Strict);

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

        var load = LoadMetadata(opts);
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
            var resolved = GeneratorRegistry
                .Resolve(names, new GeneratorBuildContext(opts.TemplateRoot))
                .ToList();
            // The declarative template generators, resolved by the SAME rule `gen` uses.
            // Without this, verify regenerated only the built-in suite and then convicted
            // every spec-emitted file as "committed but a fresh regen would not emit it" —
            // on a tree `gen` had just produced, with a remedy that loops. `verify` takes
            // no --template-spec flag, so discovery is the whole mechanism here.
            resolved.AddRange(GenCommand.TemplateSpecGenerators(
                GenCommand.ProjectRootFor(opts.MetadataDir), null, opts.TemplateRoot));
            generators = resolved;
        }
        catch (Exception ex) when (ex is ArgumentException or IOException
                                      or UnauthorizedAccessException or JsonException)
        {
            return new Codegen.CodegenDrift.Result { Clean = false, Error = $"verify --codegen: {ex.Message}" };
        }

        // The C# namespace is embedded in every generated file (`namespace {ns};`).
        // If the user did NOT pass --namespace, infer it from the committed output so
        // the regen matches output produced with any namespace (otherwise every file
        // would spuriously drift). An explicit --namespace always wins (back-compat /
        // override); inference falling back to null leaves the default in place.
        var ns = opts.Namespace;
        if (!opts.NamespaceExplicit)
            ns = Codegen.CodegenDrift.InferNamespace(opts.OutDir) ?? opts.Namespace;

        // C1 — same presence gate `gen` computes (GeneratorRegistry.IncludesNames over
        // the SAME resolved `names` list above), or a regen under a `--generators`
        // selection that excludes `names` would reference `<Entity>Names.*` while `gen`
        // itself emits the literal for that identical selection — spurious drift in one
        // direction, a false-clean pass in the other.
        var config = new GenConfig
        {
            OutDir = opts.OutDir, Namespace = ns,
            IncludeNames = GeneratorRegistry.IncludesNames(names),
            // Must match the strategy `gen` produced --out with, or the `names`
            // generator's physical-column constants regenerate under the wrong
            // strategy and every one reports spurious drift (see Options.ColumnNaming).
            ColumnNamingStrategy = opts.ColumnNaming,
        };
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

    /// <summary>Append a non-blank string attr value to a ref list.</summary>
    private static void AddIfPresent(List<string> refs, object? attr)
    {
        if (attr is string s && s.Length > 0) refs.Add(s);
    }

    public static Outcome Run(string metadataDir, string templatesRoot, bool strict = true)
        => Run(MetaDataLoader.FromDirectory(metadataDir, strict: strict), templatesRoot);

    /// <summary>
    /// Same as the <c>metadataDir</c> overload above, but starting from an
    /// ALREADY-LOADED <paramref name="load"/> — see <see cref="LoadMetadata"/> /
    /// <see cref="GenCommand"/>'s identical overload for why.
    /// </summary>
    public static Outcome Run(LoadResult load, string templatesRoot)
    {
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();

        var provider = new FilesystemProvider(templatesRoot);
        var errors = new List<Drift>();
        var warnings = new List<Drift>();
        var unresolved = new List<string>();

        foreach (var tmpl in load.Root.OwnChildren().Where(c => c.Type == TYPE_TEMPLATE))
        {
            // ADR-0039: @payloadRef may be inherited via an abstract template (templates
            // CAN extend) → resolving Attr, not OwnAttr. Missing is a load error already.
            if (tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) is not string payloadRef)
                continue;

            var isOutput = tmpl.SubType == TEMPLATE_SUBTYPE_OUTPUT;
            var kind = isOutput ? KIND_OUTPUT : KIND_PROMPT;

            // Both subtypes: @payloadRef must resolve to a loaded object.value (=>
            // non-empty derived field tree). Catches a renamed VO before codegen.
            // ADR-0042/#228: a bare @payloadRef resolves in the template's OWN package FIRST —
            // never whichever same-short-named object.value another package happens to declare
            // (the loader validates @payloadRef package-locally too; verify must agree).
            var referrerPkg = global::MetaObjects.NamingRefs.EffectivePackage(tmpl);
            var fields = PayloadCodegen.BuildPayloadFieldTree(load.Root, payloadRef, referrerPkg);
            if (fields.Count == 0)
            {
                errors.Add(new Drift(tmpl.Name, kind, ERR_PAYLOAD_REF_UNRESOLVED, payloadRef));
                continue;
            }

            // Collect every renderable body ref, mirroring the gen-time render-helper
            // gate so verify and gen agree (#193):
            //   template.prompt                    → @textRef (WITH required slots/tags).
            //   template.output document (default) → @textRef.
            //   template.output @kind=email        → @subjectRef + @htmlBodyRef + optional @textBodyRef.
            var refs = new List<string>();
            IReadOnlyList<string> requiredSlots = [];
            IReadOnlyList<string> requiredTags = [];
            if (isOutput)
            {
                var outKind = ((tmpl.Attr(TEMPLATE_ATTR_KIND) as string) ?? TEMPLATE_KIND_DEFAULT).ToLowerInvariant();
                if (outKind == TEMPLATE_KIND_EMAIL)
                {
                    AddIfPresent(refs, tmpl.Attr(TEMPLATE_ATTR_SUBJECT_REF));
                    AddIfPresent(refs, tmpl.Attr(TEMPLATE_ATTR_HTML_BODY_REF));
                    AddIfPresent(refs, tmpl.Attr(TEMPLATE_ATTR_TEXT_BODY_REF));
                }
                else
                {
                    AddIfPresent(refs, tmpl.Attr(TEMPLATE_ATTR_TEXT_REF));
                }
            }
            else
            {
                AddIfPresent(refs, tmpl.Attr(TEMPLATE_ATTR_TEXT_REF));
                // Slot/tag requirements are a template.prompt concept; the email/document
                // gate does NOT apply them per part (they would false-flag a slot as
                // unused in each part). So only the prompt path carries them.
                requiredSlots = AsStringList(tmpl.Attr(TEMPLATE_ATTR_REQUIRED_SLOTS));
                requiredTags = AsStringList(tmpl.Attr(TEMPLATE_ATTR_REQUIRED_TAGS));
            }

            // No renderable body ref present — a loader-schema concern, not verify's
            // (a well-formed output always carries one; document→@textRef, email→subject+html).
            if (refs.Count == 0) continue;

            var verifyOptions = new VerifyOptions
            {
                Provider = provider,
                RequiredSlots = requiredSlots,
                RequiredTags = requiredTags,
            };
            foreach (var reference in refs)
            {
                var text = provider.Resolve(reference);
                if (text is null)
                {
                    unresolved.Add($"template \"{tmpl.Name}\": ref \"{reference}\" did not resolve under {templatesRoot}");
                    continue;
                }
                foreach (var e in Verify.Check(text, fields, verifyOptions))
                {
                    var drift = new Drift(tmpl.Name, kind, e.Code, e.Path);
                    if (e.Code == Verify.ERR_REQUIRED_SLOT_UNUSED) warnings.Add(drift);
                    else errors.Add(drift);
                }
            }
        }

        return new Outcome(loadErrors, errors, warnings, unresolved);
    }
}
