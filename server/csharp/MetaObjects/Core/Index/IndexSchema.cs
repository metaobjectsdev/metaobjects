// Index attribute schemas — @fields (optional, required unless @expr) per subtype.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/index/index-constants.ts.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Index;

/// <summary>Attribute schemas for the index concern.</summary>
public static class IndexSchema
{
    /// <summary>
    /// @fields — the field name(s) composing this index. Single-element for a simple
    /// index, multiple for a composite. May be omitted when @expr (a functional/expression
    /// index) is provided instead. Validation (≥1 field or @expr) enforced by the loader,
    /// not by required:true here.
    /// </summary>
    public static readonly AttrSchema IndexFieldsAttr = new AttrSchema(
        Name: IndexConstants.INDEX_ATTR_FIELDS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true,
        Description: "The field name(s) composing this index. Single-element for a simple index, multiple for a composite. May be omitted when @expr (a functional/expression index) is provided instead.");

    /// <summary>
    /// Attrs per index subtype. lookup carries @fields (+ physical attrs via db provider).
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> IndexAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [IndexConstants.INDEX_SUBTYPE_LOOKUP] = [IndexFieldsAttr],
        };
}
