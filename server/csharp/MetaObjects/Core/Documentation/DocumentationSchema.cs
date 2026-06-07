// Documentation common-attr schema definitions.
//
// Colocated per ADR-0003. Mirrors
// typescript/packages/metadata/src/core/documentation/documentation-schema.ts.

using static MetaObjects.Core.Attr.AttrConstants;

namespace MetaObjects.Core.Documentation;

/// <summary>
/// The 7 universal documentation common attrs. Registered via the
/// TypeRegistry.RegisterCommonAttrs() hook by DocumentationTypes.DocTypesProvider.
/// </summary>
public static class DocumentationSchema
{
    public static readonly IReadOnlyList<AttrSchema> CommonDocAttrs = new AttrSchema[]
    {
        new(DocumentationConstants.DOC_ATTR_DESCRIPTION, ATTR_SUBTYPE_STRING, Required: false,
            Description: "Free-form user-facing prose. Markdown allowed, multi-line via YAML '|' block scalar. " +
                         "Flows into doc-gen surfaces (JSDoc / XML-doc / Postgres COMMENT / Mermaid prose)."),
        new(DocumentationConstants.DOC_ATTR_TITLE, ATTR_SUBTYPE_STRING, Required: false,
            Description: "Short single-line human label (e.g. 'Email' for a field.string email). " +
                         "Optional supplement to description."),
        new(DocumentationConstants.DOC_ATTR_NOTES, ATTR_SUBTYPE_STRING, Required: false,
            Description: "Internal-only rationale. Stays in metadata; never emitted to user-facing docs."),
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
