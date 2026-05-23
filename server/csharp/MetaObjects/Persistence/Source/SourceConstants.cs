// Source concern constants — subtypes and attr keys for the source.* type family.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/source/source-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Persistence.Source;

/// <summary>
/// Source concern constants — declares where an object's data lives (Project E).
/// dbTable / dbView ship in v1. Multiple sources per object are allowed and
/// meaningful (write-through CQRS: dbTable for writes + dbView for reads).
/// </summary>
public static class SourceConstants
{
    public const string SOURCE_SUBTYPE_DB_TABLE = "dbTable";
    public const string SOURCE_SUBTYPE_DB_VIEW  = "dbView";

    public static readonly string[] SOURCE_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        SOURCE_SUBTYPE_DB_TABLE,
        SOURCE_SUBTYPE_DB_VIEW,
    ];

    // Source attrs — both dbTable and dbView use @name for the SQL identifier
    // (table name and view name respectively). Same key for ergonomic consistency.
    public const string SOURCE_DB_TABLE_ATTR_NAME = "name";
    public const string SOURCE_DB_VIEW_ATTR_NAME  = "name";
    /// <summary>
    /// Shared @name attr key for MetaSource (covers both dbTable and dbView). Use this
    /// in generic source accessors instead of the subtype-specific aliases above.
    /// </summary>
    public const string SOURCE_ATTR_NAME          = "name";
}
