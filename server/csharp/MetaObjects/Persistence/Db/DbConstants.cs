// DB concern constants — physical DB column attr keys.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/db/db-constants.ts.
//
// NOTE: these attrs are DB-domain. In TS they are registered onto fields by a
// separate dbProvider; the C# loader+conformance milestone composes the core
// provider only (no fixture exercises a db provider), so these constants are
// consumed today by the loader's drift checks (@db.indexed) and downstream
// tooling, not by an attr schema. Kept here as the cross-language home.

namespace MetaObjects.Persistence.Db;

/// <summary>DB-domain physical-column attr keys on fields.</summary>
public static class DbConstants
{
    /// <summary>Custom DB column name override on a field (source-v2 attr <c>@column</c>).</summary>
    public const string FIELD_ATTR_COLUMN     = "column";
    /// <summary>When true, suppress the @filterable-without-index Loader warning (Project D drift check).</summary>
    public const string FIELD_ATTR_DB_INDEXED = "db.indexed";
}
