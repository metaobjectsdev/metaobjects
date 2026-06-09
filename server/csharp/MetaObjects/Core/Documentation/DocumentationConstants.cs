// Documentation concern constants.
//
// Colocated per ADR-0003. Mirrors
// typescript/packages/metadata/src/core/documentation/documentation-constants.ts.

namespace MetaObjects.Core.Documentation;

/// <summary>
/// The 8 documentation common-attr names. Bare names — the @-prefix is added
/// by the serializer per ADR-0006.
/// </summary>
public static class DocumentationConstants
{
    public const string DOC_ATTR_DESCRIPTION = "description";
    public const string DOC_ATTR_SUMMARY     = "summary";
    public const string DOC_ATTR_TITLE       = "title";
    public const string DOC_ATTR_NOTES       = "notes";
    public const string DOC_ATTR_DEPRECATED  = "deprecated";
    public const string DOC_ATTR_REPLACED_BY = "replacedBy";
    public const string DOC_ATTR_SEE_ALSO    = "seeAlso";
    public const string DOC_ATTR_ALIASES     = "aliases";

    public static readonly IReadOnlyList<string> DOC_ATTR_NAMES = new[]
    {
        DOC_ATTR_DESCRIPTION,
        DOC_ATTR_SUMMARY,
        DOC_ATTR_TITLE,
        DOC_ATTR_NOTES,
        DOC_ATTR_DEPRECATED,
        DOC_ATTR_REPLACED_BY,
        DOC_ATTR_SEE_ALSO,
        DOC_ATTR_ALIASES,
    };
}
