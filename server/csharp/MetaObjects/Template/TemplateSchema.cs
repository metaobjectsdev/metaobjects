// Reserved-attribute schemas per template subtype (FR-004, R1).
//
// Both subtypes share the generic attrs; @format is a closed enum (allowedValues)
// that the render engine keys its escaper off. template.prompt additionally
// carries the LLM-overlay attrs. References (@payloadRef, @textRef) are plain
// strings here — resolution against a real payload / text source is render-time
// `verify` scope, NOT load-time validation.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/template/template-schema.ts.

using MetaObjects.Core.Attr;
using MetaObjects.Shared;

namespace MetaObjects.Template;

/// <summary>Attribute schemas for the template concern, keyed by subtype.</summary>
public static class TemplateSchema
{
    // Generic attrs shared by template.prompt and template.output.
    private static readonly IReadOnlyList<AttrSchema> GenericAttrs =
    [
        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_PAYLOAD_REF,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Reference to the payload (a view-object / projection) this template renders against."),

        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_TEXT_REF,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "2-layer logical reference (group/source) to the body text, resolved by a provider at render time."),

        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_FORMAT,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Default: TemplateConstants.TEMPLATE_FORMAT_DEFAULT,
            AllowedValues: [.. TemplateConstants.TEMPLATE_FORMATS],
            Description: "Output format; drives the render engine's escaping/whitespace behavior."),

        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_MAX_CHARS,
            ValueType: AttrConstants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Size budget for the rendered output, in characters."),

        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_OWNER,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Governance: the owner of this template."),

        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_SINCE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Governance: the version this template was introduced in."),

        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_REQUIRED_TAGS,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRINGARRAY,
            Required: false,
            Description: "Output tags the rendered text must contain (drives the verify output-tag check)."),
    ];

    // LLM-overlay attrs (template.prompt only).
    private static readonly IReadOnlyList<AttrSchema> PromptOverlayAttrs =
    [
        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_MAX_TOKENS,
            ValueType: AttrConstants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Token budget for the rendered prompt (LLM-specific)."),

        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_REQUIRED_SLOTS,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRINGARRAY,
            Required: false,
            Description: "Slots that must resolve at render time (drives the verify check)."),

        new AttrSchema(
            Name: TemplateConstants.TEMPLATE_ATTR_MODEL,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Target model id (LLM-specific)."),
    ];

    /// <summary>
    /// Attrs per template subtype. base has none; output carries the generic attrs;
    /// prompt carries the generic attrs plus the LLM overlay.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> TemplateAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [BaseTypes.SUBTYPE_BASE]                       = [],
            [TemplateConstants.TEMPLATE_SUBTYPE_PROMPT]    = [.. GenericAttrs, .. PromptOverlayAttrs],
            [TemplateConstants.TEMPLATE_SUBTYPE_OUTPUT]    = [.. GenericAttrs],
        };
}
