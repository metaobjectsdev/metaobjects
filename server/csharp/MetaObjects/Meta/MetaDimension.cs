// MetaDimension — concrete node class for type=dimension nodes (FR-044).
//
// Ported 1:1 from
// server/typescript/packages/metadata/src/core/reporting/meta-dimension.ts.

using MetaObjects.Core.Reporting;

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>dimension.*</c> nodes. Extends <see cref="MetaData"/> directly.
/// </summary>
// ADR-0039: every getter below uses the RESOLVING Attr() accessor — a dimension declared
// on an abstract base entity is read through the same accessors as one declared on the
// concrete entity.
public class MetaDimension(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>True for <c>dimension.time</c> (grain truncation); false for <c>dimension.attribute</c>.</summary>
    public bool IsTime() => SubType == DIMENSION_SUBTYPE_TIME;

    /// <summary>Dotted <c>Entity.field</c> reference naming the grouped column.</summary>
    public string? Of() => Attr(REPORTING_ATTR_OF) as string;

    /// <summary>Optional dotted to-one relationship path from the owning entity to the <c>@of</c> entity.</summary>
    public string? Via() => Attr(REPORTING_ATTR_VIA) as string;

    /// <summary>
    /// The grains a <c>dimension.time</c> supports (empty for <c>dimension.attribute</c>).
    /// A bare string is one grain; values outside the closed grain set are dropped.
    /// </summary>
    public IReadOnlyList<string> Grains() =>
        ReportingValues.StringList(Attr(REPORTING_ATTR_GRAINS))
            .Where(g => TIME_GRAINS.Contains(g))
            .ToList()
            .AsReadOnly();
}
