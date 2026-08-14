// Documentation common-attr schema definitions.
//
// Colocated per ADR-0003. Mirrors
// typescript/packages/metadata/src/core/documentation/documentation-schema.ts.

using static MetaObjects.Core.Attr.AttrConstants;

namespace MetaObjects.Core.Documentation;

/// <summary>
/// The 8 universal documentation common attrs. Registered via the
/// TypeRegistry.RegisterCommonAttrs() hook by DocumentationTypes.DocTypesProvider.
/// </summary>
public static class DocumentationSchema
{
    public static readonly IReadOnlyList<AttrSchema> CommonDocAttrs = new AttrSchema[]
    {
        new(DocumentationConstants.DOC_ATTR_DESCRIPTION, ATTR_SUBTYPE_STRING, Required: false,
            Description: "What this element IS and COVERS, written for someone using it. Markdown allowed, " +
                         "multi-line via YAML '|' block scalar. Flows into doc-gen surfaces (JSDoc / XML-doc / " +
                         "Postgres COMMENT / Mermaid prose). State scope and boundary — what it covers, what it " +
                         "deliberately does NOT, and which sibling owns the rest — all of which is derivable from " +
                         "the model itself. Anything you had to read the implementation to learn belongs in @notes, " +
                         "not here."),
        new(DocumentationConstants.DOC_ATTR_SUMMARY, ATTR_SUBTYPE_STRING, Required: false,
            Description: "Short single-line SENTENCE (OpenAPI `summary` pattern) — used in index tables, sidebar " +
                         "previews, and AI prompts where the full @description is too long. Distinct from @title, " +
                         "which is a noun label rather than a sentence. When @summary is unset, doc surfaces " +
                         "typically fall back to the first sentence of @description."),
        new(DocumentationConstants.DOC_ATTR_TITLE, ATTR_SUBTYPE_STRING, Required: false,
            Description: "Short single-line human label — a NOUN PHRASE naming the element (e.g. 'Email' for a " +
                         "`field.string email`), never a sentence. What a tab, an index row or a sidebar shows when " +
                         "the name is an identifier rather than a label. See @summary for the one-line sentence form."),
        new(DocumentationConstants.DOC_ATTR_NOTES, ATTR_SUBTYPE_STRING, Required: false,
            Description: "Internal-only rationale, never emitted to user-facing docs — the slot for what you had to " +
                         "look OUTSIDE the model to learn: evidence, measurements, citations, the control that proved " +
                         "an absence was real, and what breaks if this changes. It is NOT a longer @description, and " +
                         "restating the description here is the failure mode this slot invites. Mechanical test: a " +
                         "sentence belongs in @notes exactly when it would have to change because the IMPLEMENTATION " +
                         "changed while the model did not."),
        new(DocumentationConstants.DOC_ATTR_DEPRECATED, ATTR_SUBTYPE_STRING, Required: false,
            Description: "Text reason for deprecation. Presence => deprecated. " +
                         "Codegen emits @deprecated / [Obsolete] with this reason."),
        new(DocumentationConstants.DOC_ATTR_REPLACED_BY, ATTR_SUBTYPE_STRING, Required: false,
            Description: "FQN reference to the replacement element. Only meaningful with `deprecated`. " +
                         "Codegen appends 'Replaced by <ref>' to deprecation messages."),
        new(DocumentationConstants.DOC_ATTR_SEE_ALSO, ATTR_SUBTYPE_STRING, Required: false,
            IsArray: true,
            Description: "External documentation URLs. Codegen emits @see / <seealso href=...>."),
        new(DocumentationConstants.DOC_ATTR_ALIASES, ATTR_SUBTYPE_STRING, Required: false,
            IsArray: true,
            Description: "Alternate names for this element. Aids AI authoring disambiguation, search, migration."),
    };
}
