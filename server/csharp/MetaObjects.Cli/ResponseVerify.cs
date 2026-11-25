// What `dotnet meta verify --templates` checks about a prompt's REPLY (`@responseRef`).
//
// Behavioral contract: server/typescript/packages/cli/src/lib/response-verify.ts, pinned cross-port by
// fixtures/response-verify-conformance/cases.json. The loader already refuses a `@responseRef` that names
// nothing, so this gate checks what loading cannot:
//   - the reply type has a field tree a parser can read (ERR_RESPONSE_UNRESOLVED, an error);
//   - for an `@responseFormat: xml` prompt, every `@requiredTags` tag names the reply type or one of its
//     fields (ERR_RESPONSE_TAG_UNDECLARED, a warning).

using MetaObjects.Codegen;
using MetaObjects.Meta;
using MetaObjects.Render;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Cli;

public static class ResponseVerify
{
    /// <summary>A responding prompt's <c>@responseRef</c> names no loaded value shape with fields.</summary>
    public const string ERR_RESPONSE_UNRESOLVED = "ERR_RESPONSE_UNRESOLVED";
    /// <summary>An xml prompt's <c>@requiredTags</c> tag names neither the reply type nor a reply field (warning).</summary>
    public const string ERR_RESPONSE_TAG_UNDECLARED = "ERR_RESPONSE_TAG_UNDECLARED";

    /// <summary>One reply finding. <see cref="Path"/> is the <c>@responseRef</c> value or the offending tag.</summary>
    public sealed record Finding(string Code, string Path, bool IsError);

    /// <summary>
    /// The reply findings for one template. Empty for anything that is not a <c>template.prompt</c>
    /// carrying <c>@responseRef</c> — a prompt that does not elicit a typed reply has nothing here.
    /// </summary>
    public static IReadOnlyList<Finding> Findings(MetaData tmpl)
    {
        if (tmpl.Type != TYPE_TEMPLATE || tmpl.SubType != TEMPLATE_SUBTYPE_PROMPT) return [];
        // ADR-0039: effective attrs — a prompt may inherit @responseRef / @responseFormat / @requiredTags.
        if (tmpl.Attr(TEMPLATE_ATTR_RESPONSE_REF) is not string responseRef) return [];

        var reply = global::MetaObjects.NamingRefs.RefTarget(tmpl, TEMPLATE_ATTR_RESPONSE_REF);
        var tree = reply is null ? [] : PayloadFieldTree.Build(reply);
        if (reply is null || tree.Count == 0)
            return [new Finding(ERR_RESPONSE_UNRESOLVED, responseRef, IsError: true)];

        if (tmpl.Attr(TEMPLATE_ATTR_RESPONSE_FORMAT) is not string format
            || !string.Equals(format, RESPONSE_FORMAT_XML, StringComparison.OrdinalIgnoreCase)) return [];
        if (tmpl.Attr(TEMPLATE_ATTR_REQUIRED_TAGS) is not { } tagsAttr) return [];
        var tags = tagsAttr switch
        {
            IReadOnlyList<string> ss => ss.ToList(),
            IReadOnlyList<object?> os => os.OfType<string>().ToList(),
            _ => [],
        };
        var known = new HashSet<string>(StringComparer.Ordinal) { ShortName(reply.Name) };
        FieldNames(tree, known);
        return tags.Where(t => !known.Contains(t))
            .Select(t => new Finding(ERR_RESPONSE_TAG_UNDECLARED, t, IsError: false)).ToList();
    }

    private static void FieldNames(IReadOnlyList<PayloadField> tree, HashSet<string> into)
    {
        foreach (var f in tree)
        {
            into.Add(f.Name);
            if (f.Fields is not null) FieldNames(f.Fields, into);
        }
    }

    private static string ShortName(string name)
    {
        var i = name.LastIndexOf("::", StringComparison.Ordinal);
        return i == -1 ? name : name[(i + 2)..];
    }
}
