// `meta verify` — the build-time template drift gate (FR-004 Plan #3, T6;
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
