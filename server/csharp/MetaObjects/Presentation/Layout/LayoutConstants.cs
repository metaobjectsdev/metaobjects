// Layout concern constants — object-level UI surface subtypes + dataGrid attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/presentation/layout/layout-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Presentation.Layout;

/// <summary>
/// Layout concern constants — object-level UI surfaces (replaces Project B's
/// object-attached data-grid view subtype; views are now strictly field-level
/// per Java parity) and the dataGrid layout attrs.
/// </summary>
public static class LayoutConstants
{
    public const string LAYOUT_SUBTYPE_DATA_GRID = "dataGrid";

    public static readonly string[] LAYOUT_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        LAYOUT_SUBTYPE_DATA_GRID,
    ];

    // Layout attrs (on dataGrid layouts)
    public const string LAYOUT_DATA_GRID_ATTR_PAGE_SIZE          = "pageSize";
    public const string LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD = "defaultSortField";
    public const string LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER = "defaultSortOrder";
    public const string LAYOUT_DATA_GRID_ATTR_FILTERABLE         = "filterable";
    public const string LAYOUT_DATA_GRID_ATTR_FILTER             = "filter";
    public const string LAYOUT_DATA_GRID_ATTR_COLUMNS            = "columns";
}
