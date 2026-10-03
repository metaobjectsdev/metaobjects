// MetaSegment — concrete node class for type=segment nodes (FR-044).
//
// Ported 1:1 from
// server/typescript/packages/metadata/src/core/reporting/meta-segment.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>segment.*</c> nodes. Extends <see cref="MetaData"/> directly.
/// </summary>
// ADR-0039: the getter below uses the RESOLVING Attr() accessor.
public class MetaSegment(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>The named row scope: a canonical attr.filter over the declaring entity's fields.</summary>
    public IReadOnlyDictionary<string, object?>? Filter() =>
        Attr(REPORTING_ATTR_FILTER) as IReadOnlyDictionary<string, object?>;
}
