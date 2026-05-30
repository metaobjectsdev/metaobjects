// template.* subtype vocabulary + reserved attribute names (FR-004, R1; ADR-0011).
//
// `template` is the fourth-pillar base type: a typed payload bound to either a
// rendered text artifact (prompt/output) or to a tool-call envelope. Three subtypes:
//   - prompt: LLM-targeted; carries the prompt-overlay attrs and is the home for
//     future structured-prompt (role/turn/tool) divergence.
//   - output: every other rendered artifact (email, export, docs, config).
//   - toolcall: LLM tool-call envelope (no renderable body — the body IS the
//               structured output schema resolved via @payloadRef). Per ADR-0011.
//
// Format is the @format ATTRIBUTE (closed set below), never a subtype — the
// render engine keys its escaper off @format, so a new format costs one escaper
// + one enum value, not a new subtype + cross-language port.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/template/template-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Template;

/// <summary>
/// Template concern constants — the template subtypes (prompt, output, toolcall)
/// plus the universal base, the reserved attr keys (generic + prompt-overlay +
/// toolcall-specific), and the closed @format value set.
/// </summary>
public static class TemplateConstants
{
    public const string TEMPLATE_SUBTYPE_PROMPT = "prompt";
    public const string TEMPLATE_SUBTYPE_OUTPUT = "output";
    /// <summary>
    /// LLM tool-call envelope subtype (ADR-0011). Does NOT inherit the
    /// generic prompt/output attrs — declares its own minimal set.
    /// </summary>
    public const string TEMPLATE_SUBTYPE_TOOLCALL = "toolcall";

    public static readonly string[] TEMPLATE_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        TEMPLATE_SUBTYPE_PROMPT,
        TEMPLATE_SUBTYPE_OUTPUT,
        TEMPLATE_SUBTYPE_TOOLCALL,
    ];

    // Generic reserved attrs (prompt + output; NOT inherited by toolcall).
    // The "@" is applied at wire time.
    public const string TEMPLATE_ATTR_PAYLOAD_REF = "payloadRef";
    public const string TEMPLATE_ATTR_TEXT_REF    = "textRef";
    public const string TEMPLATE_ATTR_FORMAT      = "format";
    public const string TEMPLATE_ATTR_MAX_CHARS   = "maxChars";
    public const string TEMPLATE_ATTR_OWNER       = "owner";
    public const string TEMPLATE_ATTR_SINCE       = "since";
    // Output tags the rendered text must contain (drives the verify output-tag check).
    // Generic — not prompt-only: any rendered artifact (email, export, prompt) can
    // carry a tag contract a downstream parser depends on.
    public const string TEMPLATE_ATTR_REQUIRED_TAGS = "requiredTags";

    // Prompt-overlay attrs (template.prompt only).
    public const string TEMPLATE_ATTR_MAX_TOKENS     = "maxTokens";
    public const string TEMPLATE_ATTR_REQUIRED_SLOTS = "requiredSlots";
    public const string TEMPLATE_ATTR_MODEL          = "model";

    // Toolcall-specific attrs (template.toolcall only — ADR-0011). Vendor-agnostic
    // in core; vendor wire details (retry semantics, fallback shapes, parallel
    // invocation, cache hints) added by consumer providers via
    // TypeRegistry.Extend("template", "toolcall", attributes: [...]).
    //
    // @description is intentionally NOT a toolcall-specific constant — every type
    // gets @description via the documentation common-attrs provider. Tool
    // descriptions surfaced to the LLM use the same @description common attr
    // doc-gen uses.
    public const string TEMPLATE_ATTR_TOOL_NAME = "toolName";

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

    // FR-010 artifact-1 prompt presentation style (template.output only). Closed enum;
    // guidance is NEVER carried in comments. Default "guide". Set project-wide via an
    // abstract template base + extends, with a render-time PromptOverrides.Style on top.
    public const string TEMPLATE_ATTR_PROMPT_STYLE = "promptStyle";
    public const string PROMPT_STYLE_GUIDE         = "guide";
    public const string PROMPT_STYLE_INLINE        = "inline";
    public const string PROMPT_STYLE_EXAMPLE_ONLY  = "exampleOnly";
    public const string PROMPT_STYLE_DEFAULT       = PROMPT_STYLE_GUIDE;

    public static readonly string[] TEMPLATE_PROMPT_STYLES =
    [
        PROMPT_STYLE_GUIDE,
        PROMPT_STYLE_INLINE,
        PROMPT_STYLE_EXAMPLE_ONLY,
    ];
}
