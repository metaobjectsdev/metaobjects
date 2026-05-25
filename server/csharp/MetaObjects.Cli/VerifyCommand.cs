// `meta verify` — the build-time prompt drift gate (FR-004 Plan #3, T6).
//
// Loads metadata from a directory; for each template node resolves its @textRef
// text via a filesystem provider, derives the @payloadRef view-object's field
// tree from the loaded metadata, and runs the engine's verify() — reporting drift
// (a template variable the payload doesn't declare, an unresolved partial) so CI
// fails before a renamed field can silently break a prompt. Runs at the last
// fixed point before serve, never on the request path.

using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Render;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Cli;

/// <summary>The verify command's pure logic — no console I/O, so it is testable.</summary>
public static class VerifyCommand
{
    public sealed record Drift(string Template, string Code, string Path);

    public sealed record Outcome(
        IReadOnlyList<string> LoadErrors,
        IReadOnlyList<Drift> Errors,
        IReadOnlyList<Drift> Warnings,
        IReadOnlyList<string> UnresolvedText)
    {
        /// <summary>Clean iff no load errors, no drift errors, and every @textRef resolved.</summary>
        public bool Ok => LoadErrors.Count == 0 && Errors.Count == 0 && UnresolvedText.Count == 0;
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
            // Missing @textRef / @payloadRef are already load errors (Pass 9 + schema).
            if (tmpl.OwnAttr(TEMPLATE_ATTR_TEXT_REF) is not string textRef ||
                tmpl.OwnAttr(TEMPLATE_ATTR_PAYLOAD_REF) is not string payloadRef)
                continue;

            var text = provider.Resolve(textRef);
            if (text is null)
            {
                unresolved.Add($"template \"{tmpl.Name}\": @textRef \"{textRef}\" did not resolve under {templatesRoot}");
                continue;
            }

            var fields = PayloadCodegen.BuildPayloadFieldTree(load.Root, payloadRef);
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
                var drift = new Drift(tmpl.Name, e.Code, e.Path);
                if (e.Code == Verify.ERR_REQUIRED_SLOT_UNUSED) warnings.Add(drift);
                else errors.Add(drift);
            }
        }

        return new Outcome(loadErrors, errors, warnings, unresolved);
    }
}
