// FR-033 — the metaobjects-prompt concern provider.
//
// Re-homes the prompt / AI + serialization metamodel attrs that are PROJECTIONS onto
// someone else's type — OUT of the CORE type classes (FieldSchema / ObjectSchema, and
// the former TemplateTypesProvider's @xmlText) and INTO a data-driven concern provider
// that reads the embedded spec/metamodel/prompt.json `extends` directives — matching
// the TS promptProvider (renamed from templateProvider), Java
// PromptTypesMetaDataProvider, and Python prompt_provider. It owns:
//   - field.*       : @xmlText / @example / @instruction (FR-010 field-teaching + extract)
//   - field.enum    : @enumAlias / @enumDoc / @coerceDefault / @normalize (FR-010 / FR-011 tolerant-extract overlays)
//   - object.value  : @normalize (object-level default for its enum fields' extract)
//
// template.prompt / template.output / template.toolcall's OWN attrs (@payloadRef,
// @textRef, @format, @toolName, ...) do NOT live here. They are intrinsic to the
// template type — a template.prompt with no @payloadRef can't render, a
// template.toolcall with no @toolName can't be wired to an LLM — so they register in
// CoreTypes (TemplateSchema), the type's own provider, and are always present
// regardless of which optional concern providers get composed in. Re-homing them here
// (the pre-fix state) made a REQUIRED attr's enforcement depend on an optional
// provider: compose without metaobjects-prompt and template.prompt stayed registered
// with ZERO attrs, so ERR_MISSING_REQUIRED_ATTR silently stopped firing on a
// template.prompt missing @payloadRef. The rule going forward: an attr the type is not
// meaningfully itself without registers WITH the type, always; only a genuine
// projection onto someone else's (already-complete) type belongs in a concern
// provider, and it must be optional.
//
// The template TYPE definitions (template.base/prompt/output/toolcall) stay registered
// by CoreTypes; this provider applies only the field.* / field.enum / object.value
// attrs above. Those attrs + their value-types / required-ness / allowed-values /
// defaults are DATA — read from the embedded JSON (single-sourced, never hand-copied).
//
// `metaobjects-template` is kept as a back-compat alias to this provider in the
// conformance adapter's provider map (the pre-rename fixtures still name it; TS / Java
// / Python all keep the same alias).

using MetaObjects.Core.Field;
using MetaObjects.Registry.Spec;
using MetaObjects.Shared;

namespace MetaObjects.Template;

/// <summary>
/// FR-033 prompt concern provider (<c>metaobjects-prompt</c>): extends the core field /
/// field.enum / object.value types with the prompt-construction + tolerant-extract attrs
/// declared in <c>spec/metamodel/prompt.json</c>. Does NOT own any template.* attrs —
/// those are intrinsic to template and register with the type itself in CoreTypes
/// (TemplateSchema), never in this optional, composable-out provider. Depends on the
/// core types being registered first.
/// </summary>
public sealed class PromptMetaDataProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry alongside the core provider.</summary>
    public static readonly IMetaDataTypeProvider Instance = new PromptMetaDataProvider();

    /// <summary>The provider id — matches <c>prompt.json</c>'s <c>"provider"</c> field.</summary>
    public const string ProviderId = "metaobjects-prompt";

    /// <summary>The pre-rename id kept as a back-compat alias (mapped to this provider in the conformance adapter).</summary>
    public const string LegacyAliasId = "metaobjects-template";

    /// <summary>
    /// FR-033 — the parsed embedded spec reader, reused across composes. The 15 JSON
    /// files are immutable assembly resources, so a single parse is sufficient.
    /// </summary>
    private static readonly Lazy<SpecMetamodelReader> Reader = new(SpecMetamodelReader.Load);

    public string Id => ProviderId;

    public string? Description =>
        "MetaObjects prompt-construction concern attrs (xmlText/example/instruction, enum extract overlays, object.value @normalize) — FR-033.";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        // The prompt.json field.* wildcard expands to every concrete field subtype (the
        // shared FIELD_SUBTYPES set already includes base + enum). The exact
        // (field.enum / object.value) directives resolve directly. Attrs are
        // single-sourced from the embedded JSON. prompt.json no longer carries any
        // template.* extends block (those attrs moved to CoreTypes/TemplateSchema), so
        // there is nothing template-shaped left for this call to pick up.
        registry.ApplyProviderExtends(
            Reader.Value,
            ProviderId,
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                [BaseTypes.TYPE_FIELD] = FieldConstants.FIELD_SUBTYPES,
            });
    }
}
