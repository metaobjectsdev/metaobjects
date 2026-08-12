// Template attribute schemas — the per-subtype attr sets for template.prompt,
// template.output, and template.toolcall.
//
// Colocated per ADR-0003. Mirrors the canonical spec/metamodel/template.json (which
// this port embeds + reads): DESCRIPTIONS are deliberately NOT hand-copied here — FR-033
// sources every description from the shared JSON via Registry.ApplySpecDescriptions, so
// the prose is byte-identical to TS by construction. Only the facets the manifest needs
// but the description pass does not carry (value type / array-ness / requiredness /
// allowedValues / default) are declared here.
//
// These attrs are OWN to the template type — a template.prompt with no @payloadRef
// can't render, a template.toolcall with no @toolName can't be wired to an LLM — so
// they register HERE, in the core provider (CoreTypes.cs), never in a concern
// provider that can be composed out. A required attr that lived in an optional
// provider would silently stop being enforced the moment that provider was dropped
// (the defect this schema fixes; see CoreTypes.cs "template" section). Mirrors
// RequirementSchema, the correct pattern for an own-attr type in this port.
//
// template.base carries no attrs at all — it is not in TemplateAttrsMap, so a
// lookup miss falls back to an empty list (mirrors RequirementAttrsMap, which has
// no "base" entry either).

using MetaObjects.Core.Attr;

namespace MetaObjects.Template;

/// <summary>Attribute schemas for the template concern.</summary>
public static class TemplateSchema
{
    // --- shared across prompt + output (some also shared with toolcall) ---

    /// <summary>@payloadRef — required on every concrete template subtype (prompt/output/toolcall).</summary>
    private static readonly AttrSchema PayloadRefAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_PAYLOAD_REF,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true,
        Description: "Reference to the payload (a view-object / projection) this template renders against.");

    /// <summary>@textRef — prompt + output only (toolcall has no renderable text body).</summary>
    private static readonly AttrSchema TextRefAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_TEXT_REF,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "2-layer logical reference (group/source) to the body text, resolved by a provider at render time.");

    /// <summary>@format — prompt + output only; closed enum keyed by the render engine's escaper.</summary>
    private static readonly AttrSchema FormatAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_FORMAT,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Default: TemplateConstants.TEMPLATE_FORMAT_DEFAULT,
        AllowedValues: [.. TemplateConstants.TEMPLATE_FORMATS],
        Description: "Output format; drives the render engine's escaping/whitespace behavior.");

    /// <summary>@maxChars — prompt + output only.</summary>
    private static readonly AttrSchema MaxCharsAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_MAX_CHARS,
        ValueType: AttrConstants.ATTR_SUBTYPE_INT,
        Required: false,
        Description: "Size budget for the rendered output, in characters.");

    /// <summary>@owner — governance; every concrete template subtype.</summary>
    private static readonly AttrSchema OwnerAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_OWNER,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Governance: the owner of this template.");

    /// <summary>@since — governance; every concrete template subtype.</summary>
    private static readonly AttrSchema SinceAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_SINCE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Governance: the version this template was introduced in.");

    /// <summary>@requiredTags — prompt + output only.</summary>
    private static readonly AttrSchema RequiredTagsAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_REQUIRED_TAGS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true,
        Description: "Output tags the rendered text must contain (drives the verify output-tag check).");

    /// <summary>@maxTokens — prompt + toolcall (peer LLM-specific budgets).</summary>
    private static readonly AttrSchema MaxTokensAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_MAX_TOKENS,
        ValueType: AttrConstants.ATTR_SUBTYPE_INT,
        Required: false,
        Description: "Token budget for the rendered prompt (LLM-specific).");

    // --- prompt-only overlay ---

    private static readonly AttrSchema RequiredSlotsAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_REQUIRED_SLOTS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true,
        Description: "Slots that must resolve at render time (drives the verify check).");

    private static readonly AttrSchema ModelAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_MODEL,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Target model id (LLM-specific).");

    private static readonly AttrSchema ResponseRefAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_RESPONSE_REF,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Optional ref to the response value-object this prompt expects (peer of @payloadRef; drives typed LLM-call trace derivation).");

    // --- output-only overlay ---

    private static readonly AttrSchema PromptStyleAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_PROMPT_STYLE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Default: TemplateConstants.PROMPT_STYLE_DEFAULT,
        AllowedValues: [.. TemplateConstants.TEMPLATE_PROMPT_STYLES],
        Description: "FR-010 output-format prompt presentation: 'guide' (prose list + example), 'inline' (inline placeholders / enum choices), or 'exampleOnly' (filled skeleton). Guidance is never emitted as comments.");

    private static readonly AttrSchema KindAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_KIND,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Default: TemplateConstants.TEMPLATE_KIND_DEFAULT,
        AllowedValues: [.. TemplateConstants.TEMPLATE_KINDS],
        Description: "Output shape: 'document' (renders @textRef in @format → one string) or 'email' (renders subject + html + optional text → a structured EmailDocument).");

    private static readonly AttrSchema SubjectRefAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_SUBJECT_REF,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Email only: 2-layer logical reference (group/source) to the subject-line text. Required when @kind=\"email\".");

    private static readonly AttrSchema HtmlBodyRefAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_HTML_BODY_REF,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Email only: 2-layer logical reference (group/source) to the HTML body text. Required when @kind=\"email\".");

    private static readonly AttrSchema TextBodyRefAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_TEXT_BODY_REF,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Email only: 2-layer logical reference (group/source) to the optional plain-text alternative body.");

    // --- toolcall-only overlay ---

    private static readonly AttrSchema ToolNameAttr = new AttrSchema(
        Name: TemplateConstants.TEMPLATE_ATTR_TOOL_NAME,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true,
        Description: "Wire tool name surfaced to the LLM (vendor-specific format).");

    // --- per-subtype attr lists (JSON declaration order; the manifest emitter sorts) ---

    private static readonly IReadOnlyList<AttrSchema> PromptAttrs =
    [
        PayloadRefAttr,
        TextRefAttr,
        FormatAttr,
        MaxCharsAttr,
        OwnerAttr,
        SinceAttr,
        RequiredTagsAttr,
        MaxTokensAttr,
        RequiredSlotsAttr,
        ModelAttr,
        ResponseRefAttr,
    ];

    private static readonly IReadOnlyList<AttrSchema> OutputAttrs =
    [
        PayloadRefAttr,
        TextRefAttr,
        FormatAttr,
        MaxCharsAttr,
        OwnerAttr,
        SinceAttr,
        RequiredTagsAttr,
        PromptStyleAttr,
        KindAttr,
        SubjectRefAttr,
        HtmlBodyRefAttr,
        TextBodyRefAttr,
    ];

    private static readonly IReadOnlyList<AttrSchema> ToolcallAttrs =
    [
        ToolNameAttr,
        PayloadRefAttr,
        OwnerAttr,
        SinceAttr,
        MaxTokensAttr,
    ];

    /// <summary>
    /// Attrs per template subtype. prompt has 11, output has 12, toolcall has 5
    /// (matches spec/metamodel/template.json). template.base carries none — it is
    /// deliberately absent from this map; a lookup miss is the caller's cue to fall
    /// back to an empty list (mirrors RequirementAttrsMap, which has no "base" entry).
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> TemplateAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [TemplateConstants.TEMPLATE_SUBTYPE_PROMPT] = PromptAttrs,
            [TemplateConstants.TEMPLATE_SUBTYPE_OUTPUT] = OutputAttrs,
            [TemplateConstants.TEMPLATE_SUBTYPE_TOOLCALL] = ToolcallAttrs,
        };
}
