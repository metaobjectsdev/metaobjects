// Index attribute schemas — @fields (optional, required unless @expr) per subtype.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/index/index-constants.ts.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Index;

/// <summary>Attribute schemas for the index concern.</summary>
public static class IndexSchema
{
    /// <summary>
    /// @fields — the field name(s) this index covers. OPTIONAL at the schema tier (#342):
    /// the real rule is @fields XOR @expr, and an exclusive-or is not expressible as a
    /// per-attr Required flag, so ValidationPasses.ValidateIndexLookupFields enforces it
    /// (ERR_INVALID_INDEX). Required:true here fired first and made an expression index
    /// undeclarable.
    /// </summary>
    public static readonly AttrSchema IndexFieldsAttr = new AttrSchema(
        Name: IndexConstants.INDEX_ATTR_FIELDS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true,
        Description: "The field name(s) this index covers. Required UNLESS @expr is present — an index keys off plain columns (@fields) or a key expression (@expr), never both; declaring both is ERR_INVALID_INDEX.");

    /// <summary>
    /// Attrs per index subtype. lookup carries @fields (+ physical attrs via db provider).
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> IndexAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [IndexConstants.INDEX_SUBTYPE_LOOKUP] = [IndexFieldsAttr],
        };
}
