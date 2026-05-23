// template.* subtype vocabulary + reserved attribute names (FR-004, R1).
//
// `template` is the fourth-pillar base type: a renderable text artifact bound to
// a typed payload. Two subtypes (by audience/structure, NOT by format):
//   - prompt: LLM-targeted; carries the prompt-overlay attrs and is the home for
//     future structured-prompt (role/turn/tool) divergence.
//   - output: every other rendered artifact (email, export, docs, config).
//
// Format is the @format ATTRIBUTE (closed set below), never a subtype — the
// render engine keys its escaper off @format, so a new format costs one escaper
// + one enum value, not a new subtype + cross-language port.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/template/template-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Template;

/// <summary>
/// Template concern constants — the template subtypes (prompt, output) plus the
/// universal base, the reserved attr keys (generic + prompt-overlay), and the
/// closed @format value set.
/// </summary>
public static class TemplateConstants
{
    public const string TEMPLATE_SUBTYPE_PROMPT = "prompt";
    public const string TEMPLATE_SUBTYPE_OUTPUT = "output";

    public static readonly string[] TEMPLATE_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        TEMPLATE_SUBTYPE_PROMPT,
        TEMPLATE_SUBTYPE_OUTPUT,
    ];

    // Generic reserved attrs (both subtypes). The "@" is applied at wire time.
    public const string TEMPLATE_ATTR_PAYLOAD_REF = "payloadRef";
    public const string TEMPLATE_ATTR_TEXT_REF    = "textRef";
    public const string TEMPLATE_ATTR_FORMAT      = "format";
    public const string TEMPLATE_ATTR_MAX_CHARS   = "maxChars";
    public const string TEMPLATE_ATTR_OWNER       = "owner";
    public const string TEMPLATE_ATTR_SINCE       = "since";

    // Prompt-overlay attrs (template.prompt only).
    public const string TEMPLATE_ATTR_MAX_TOKENS     = "maxTokens";
    public const string TEMPLATE_ATTR_REQUIRED_SLOTS = "requiredSlots";
    public const string TEMPLATE_ATTR_MODEL          = "model";

    /// <summary>Default @format when omitted.</summary>
    public const string TEMPLATE_FORMAT_DEFAULT = "text";

    // Closed format set — escaping/whitespace behavior is keyed off this in the
    // render engine's escaper registry (FR-004 R7).
    public static readonly string[] TEMPLATE_FORMATS =
    [
        "text",
        "html",
        "xml",
        "csv",
        "json",
        "markdown",
        "spreadsheet",
    ];
}
