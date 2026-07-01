// Index attribute schemas — @fields (optional, required unless @expr) per subtype.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/index/index-constants.ts.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Index;

/// <summary>Attribute schemas for the index concern.</summary>
public static class IndexSchema
{
    /// <summary>
    /// @fields — the field name(s) this index covers (at least one). When @expr is
    /// present, it is the key expression derived from these fields. Required: the loader
    /// enforces ≥1 field.
    /// </summary>
    public static readonly AttrSchema IndexFieldsAttr = new AttrSchema(
        Name: IndexConstants.INDEX_ATTR_FIELDS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true,
        IsArray: true,
        Description: "The field name(s) this index covers (at least one). When @expr is present, it is the key expression derived from these fields.");

    /// <summary>
    /// Attrs per index subtype. lookup carries @fields (+ physical attrs via db provider).
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> IndexAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [IndexConstants.INDEX_SUBTYPE_LOOKUP] = [IndexFieldsAttr],
        };
}
