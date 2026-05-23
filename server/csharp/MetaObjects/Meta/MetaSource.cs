// MetaSource — concrete node class for type=source nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-source.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>source.*</c> nodes.
/// Declares where an object's data lives (dbTable / dbView).
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaSource(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>The SQL table or view name (value of <c>@name</c> attr on the source child).</summary>
    public string? SourceName
    {
        get
        {
            var v = OwnAttr(SOURCE_ATTR_NAME);
            return v is string s ? s : null;
        }
    }

    /// <summary>
    /// True when this source is a <c>dbTable</c> (writable).
    /// Explicitly defined rather than derived from <see cref="IsReadOnly"/> so it
    /// remains correct if a third source subtype is added in the future.
    /// </summary>
    public bool IsWritable() => SubType == SOURCE_SUBTYPE_DB_TABLE;

    /// <summary>
    /// True when this source is a <c>dbView</c> (read-only projection).
    /// Explicitly defined rather than derived from <see cref="IsWritable"/> so it
    /// remains correct if a third source subtype is added in the future.
    /// </summary>
    public bool IsReadOnly() => SubType == SOURCE_SUBTYPE_DB_VIEW;
}
