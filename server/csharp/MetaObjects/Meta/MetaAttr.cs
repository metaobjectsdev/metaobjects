// MetaAttr — concrete node class for type=attr nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-attr.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>attr.*</c> nodes.
/// Used when an attribute is materialized as a child node (rare).
/// Implements <see cref="IDataTypeAware"/> — the coarse value-type classification is
/// supplied by the registry at node construction via <c>SetDataType()</c>.
/// </summary>
public class MetaAttr(TypeId typeId, string name) : MetaData(typeId, name), IDataTypeAware
{
    /// <summary>The declared value on this attr node (the <c>value</c> reserved key).</summary>
    /// <remarks>
    /// ADR-0039: <c>OwnAttr</c> (own-only) by design — an <c>attr.*</c> node's
    /// <c>value</c> is its authored declaration; a materialized attr node is not an
    /// <c>extends</c> participant, so its own layer is its effective layer. Matches the
    /// cross-port reference (TS <c>MetaAttr.value</c> reads <c>ownAttr</c>).
    /// </remarks>
    public object? Value => OwnAttr(RESERVED_KEY_VALUE);

    /// <summary>The coarse value-type classification for this attribute's subtype.</summary>
    public DataType DataType => DataTypeValue ?? global::MetaObjects.DataType.String;
}
