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

    // FR-016 / ADR-0007 point 2: the source's "logical name" is the structural
    // `name` field every MetaData node already carries — accessed via `source.Name`,
    // NOT an @-attr. (An @-attr would conflict with the ERR_RESERVED_ATTR rule for
    // the reserved structural key `name`.) See the four-step physical-name
    // resolution rule on MetaSource.PhysicalName.

    // --- Per-kind physical-name aliases (FR-016 / ADR-0018) ---------------------
    // One canonical attr key per rdb @kind. The single internal physical-name
    // "slot" on the source is filled by whichever alias matches @kind; the
    // canonical serializer emits the kind-matching alias regardless of which
    // spelling was on input.
    /// <summary>Physical SQL table name. Canonical attr for @kind: "table" (default).</summary>
    public const string SOURCE_ATTR_TABLE = "table";

    /// <summary>Physical SQL view name. Canonical attr for @kind: "view".</summary>
    public const string SOURCE_ATTR_VIEW = "view";

    /// <summary>Physical SQL materialized-view name. Canonical attr for @kind: "materializedView".</summary>
    public const string SOURCE_ATTR_MATERIALIZED_VIEW = "materializedView";

    /// <summary>Physical SQL stored-procedure name. Canonical attr for @kind: "storedProc".</summary>
    public const string SOURCE_ATTR_PROC = "proc";

    /// <summary>Physical SQL table-function name. Canonical attr for @kind: "tableFunction".</summary>
    public const string SOURCE_ATTR_FUNCTION = "function";

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

    /// <summary>
    /// FR-015: name or FQN of an object.value describing the input shape of a
    /// callable source (@kind: "storedProc" / "tableFunction"). Symmetric with
    /// template.@payloadRef. Permitted only on callable kinds.
    /// </summary>
    public const string SOURCE_ATTR_PARAMETER_REF = "parameterRef";

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

    /// <summary>
    /// Map @kind → canonical kind-aware physical-name attr key (FR-016 / ADR-0018).
    /// Drives the four-step physical-name resolution rule and the canonical-serializer
    /// per-kind rewrite. The single internal physical-name "slot" on a source is the
    /// value of whichever alias matches the source's @kind.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> PHYSICAL_NAME_ATTR_BY_KIND =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [SOURCE_KIND_TABLE]             = SOURCE_ATTR_TABLE,
            [SOURCE_KIND_VIEW]              = SOURCE_ATTR_VIEW,
            [SOURCE_KIND_MATERIALIZED_VIEW] = SOURCE_ATTR_MATERIALIZED_VIEW,
            [SOURCE_KIND_STORED_PROC]       = SOURCE_ATTR_PROC,
            [SOURCE_KIND_TABLE_FUNCTION]    = SOURCE_ATTR_FUNCTION,
        };

    /// <summary>
    /// All five kind-aware physical-name alias keys, in deterministic order
    /// (matches <see cref="SOURCE_RDB_KINDS"/>).
    /// </summary>
    public static readonly string[] ALL_PHYSICAL_NAME_ALIASES =
    [
        SOURCE_ATTR_TABLE,
        SOURCE_ATTR_VIEW,
        SOURCE_ATTR_MATERIALIZED_VIEW,
        SOURCE_ATTR_PROC,
        SOURCE_ATTR_FUNCTION,
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
