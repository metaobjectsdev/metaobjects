// Index concern constants — type name, subtypes, and attr keys.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/index/index-constants.ts.

namespace MetaObjects.Core.Index;

/// <summary>
/// Index concern constants — the single index subtype (lookup) and attr keys.
/// </summary>
public static class IndexConstants
{
    // -----------------------------------------------------------------------
    // Index subtypes (1: lookup)
    // -----------------------------------------------------------------------

    /// <summary>Non-unique lookup index — query-performance indexes that do NOT enforce uniqueness.</summary>
    public const string INDEX_SUBTYPE_LOOKUP = "lookup";

    public static readonly string[] INDEX_SUBTYPES =
    [
        INDEX_SUBTYPE_LOOKUP,
    ];

    // -----------------------------------------------------------------------
    // Index attrs (logical — core)
    // -----------------------------------------------------------------------

    /// <summary>The field name(s) composing this index. May be omitted when @expr is provided instead.</summary>
    public const string INDEX_ATTR_FIELDS = "fields";

    // NOTE: physical RDB-only index attrs (@using / @expr / @where / @orders) are
    // NOT core — they are contributed by the db provider, reusing the existing
    // IDENTITY_ATTR_* constants in persistence/db/db-constants.ts.
}
