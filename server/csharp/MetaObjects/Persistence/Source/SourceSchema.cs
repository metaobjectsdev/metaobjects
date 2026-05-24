// Source attribute schemas — attrs declared on source.rdb (ADR-0007).
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/source/source-schema.ts
// and the Java sibling MetaSource.registerTypes(...) registration.

using MetaObjects.Core.Attr;

namespace MetaObjects.Persistence.Source;

/// <summary>Attribute schemas for the source.rdb concrete subtype.</summary>
public static class SourceSchema
{
    /// <summary>All attr schemas declared on source.rdb.</summary>
    public static readonly IReadOnlyList<AttrSchema> RdbSourceAttrs =
    [
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_TABLE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Physical SQL table or view name for this rdb source. Defaults to the object name run through the project's columnNamingStrategy when omitted."),

        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_KIND,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. SourceConstants.SOURCE_RDB_KINDS],
            Description: "The kind of database object this source represents: table (default, writable), view, materializedView, storedProc, or tableFunction. Non-table kinds are read-only."),

        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_ROLE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. SourceConstants.SOURCE_ROLES],
            Description: "Role this source plays when an object has multiple sources: primary (default, system of record), replica, index, cache, publish, or mirror."),

        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_SCHEMA,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Optional database schema name (e.g. 'catalog', 'public'). Postgres defaults to 'public'; SQLite rejects any non-default value."),
    ];
}
