// MetaIndex — concrete node class for type=index nodes.
// MetaLookupIndex is the only registered subtype, backed by this single class.
//
// Ported 1:1 from typescript/packages/metadata/src/core/index/meta-index.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>index.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
// ADR-0039: index attr getters use the RESOLVING Attr() accessor — an index
// attr (@fields) may be inherited from an abstract base via extends.
public class MetaIndex(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>
    /// The field names that form this lookup index.
    /// ADR-0039: resolving — @fields may be inherited via extends.
    /// </summary>
    public IReadOnlyList<string> Fields
    {
        get
        {
            var f = Attr(INDEX_ATTR_FIELDS);
            return f is IReadOnlyList<string> list ? list : [];
        }
    }

    /// <summary>True when this index's subtype is <c>lookup</c>.</summary>
    public bool IsLookup() => SubType == INDEX_SUBTYPE_LOOKUP;
}
