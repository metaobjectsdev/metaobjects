// Source concern constants — subtypes and attr keys for the source.* type family.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/source/source-constants.ts
// and the Java sibling com.metaobjects.source.MetaSource.
//
// Source v2 (ADR-0007): paradigm subtype "rdb"; physical name @table; @kind + @role
// drive read-only derivation and multi-source role semantics. Multiple sources per
// object are allowed and meaningful (write-through CQRS: writable rdb[table] for
// writes + read-only rdb[view] for reads).

using MetaObjects.Shared;

namespace MetaObjects.Persistence.Source;

/// <summary>
/// Source v2 concern constants (ADR-0007) — declares where an object's data lives.
/// Concrete paradigm subtypes attach to the source.base abstract via inheritsFrom.
/// </summary>
public static class SourceConstants
{
    // -----------------------------------------------------------------------
    // Source v2 (ADR-0007): paradigm subtype "rdb"; physical name @table; @kind + @role.
    // -----------------------------------------------------------------------

    /// <summary>Relational-database paradigm subtype.</summary>
    public const string SOURCE_SUBTYPE_RDB = "rdb";

    public static readonly string[] SOURCE_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        SOURCE_SUBTYPE_RDB,
    ];

    // -----------------------------------------------------------------------
    // Source v2 attrs
    // -----------------------------------------------------------------------

    /// <summary>Physical SQL table/view name on source.rdb.</summary>
    public const string SOURCE_ATTR_TABLE = "table";

    /// <summary>Object kind within the rdb paradigm; read-only-ness is derived from it.</summary>
    public const string SOURCE_ATTR_KIND = "kind";

    /// <summary>Multi-source role; exactly one primary per object.</summary>
    public const string SOURCE_ATTR_ROLE = "role";

    /// <summary>
    /// Optional DB schema attr on source.rdb. Postgres uses this to namespace
    /// tables/views. SQLite has no schema concept and rejects any non-default
    /// value at the migrate-emit boundary. Default for Postgres: "public".
    /// Free-form name (not an enum); carried through the loader.
    /// </summary>
    public const string SOURCE_ATTR_SCHEMA = "schema";

    /// <summary>Default Postgres schema when @schema is omitted from a source.</summary>
    public const string DEFAULT_DB_SCHEMA_POSTGRES = "public";

    // -----------------------------------------------------------------------
    // Kind values (closed enum)
    // -----------------------------------------------------------------------

    public const string SOURCE_KIND_TABLE              = "table";
    public const string SOURCE_KIND_VIEW               = "view";
    public const string SOURCE_KIND_MATERIALIZED_VIEW  = "materializedView";
    public const string SOURCE_KIND_STORED_PROC        = "storedProc";
    public const string SOURCE_KIND_TABLE_FUNCTION     = "tableFunction";

    public static readonly string[] SOURCE_RDB_KINDS =
    [
        SOURCE_KIND_TABLE,
        SOURCE_KIND_VIEW,
        SOURCE_KIND_MATERIALIZED_VIEW,
        SOURCE_KIND_STORED_PROC,
        SOURCE_KIND_TABLE_FUNCTION,
    ];

    /// <summary>Default @kind when omitted (writable table).</summary>
    public const string DEFAULT_SOURCE_KIND = SOURCE_KIND_TABLE;

    /// <summary>Kinds whose source is read-only (codegen emits read-only model/queries/routes).</summary>
    public static readonly HashSet<string> SOURCE_READ_ONLY_KINDS = new(StringComparer.Ordinal)
    {
        SOURCE_KIND_VIEW,
        SOURCE_KIND_MATERIALIZED_VIEW,
        SOURCE_KIND_STORED_PROC,
        SOURCE_KIND_TABLE_FUNCTION,
    };

    // -----------------------------------------------------------------------
    // Role values (closed enum)
    // -----------------------------------------------------------------------

    public const string SOURCE_ROLE_PRIMARY = "primary";
    public const string SOURCE_ROLE_REPLICA = "replica";
    public const string SOURCE_ROLE_INDEX   = "index";
    public const string SOURCE_ROLE_CACHE   = "cache";
    public const string SOURCE_ROLE_PUBLISH = "publish";
    public const string SOURCE_ROLE_MIRROR  = "mirror";

    public static readonly string[] SOURCE_ROLES =
    [
        SOURCE_ROLE_PRIMARY,
        SOURCE_ROLE_REPLICA,
        SOURCE_ROLE_INDEX,
        SOURCE_ROLE_CACHE,
        SOURCE_ROLE_PUBLISH,
        SOURCE_ROLE_MIRROR,
    ];

    /// <summary>Default @role when omitted (system of record).</summary>
    public const string DEFAULT_SOURCE_ROLE = SOURCE_ROLE_PRIMARY;
}
