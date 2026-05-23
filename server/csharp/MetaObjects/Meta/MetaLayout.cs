// MetaLayout — concrete node class for type=layout nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-layout.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>layout.*</c> nodes (object-level UI surfaces).
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaLayout(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>The number of rows per page for the dataGrid layout.</summary>
    public long? PageSize
    {
        get
        {
            var v = OwnAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE);
            return v is long l ? l : null;
        }
    }

    /// <summary>The field name to sort by default in the dataGrid layout.</summary>
    public string? DefaultSortField
    {
        get
        {
            var v = OwnAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
            return v is string s ? s : null;
        }
    }

    /// <summary>
    /// The default sort order (<c>"asc"</c> or <c>"desc"</c>) for the dataGrid layout.
    /// Returns <see langword="null"/> when the attr is absent.
    /// </summary>
    public string? DefaultSortOrder
    {
        get
        {
            var v = OwnAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER);
            return v is string s ? s : null;
        }
    }

    /// <summary>
    /// True when <c>@filterable: true</c> is set on the dataGrid layout.
    /// Defaults to <see langword="false"/> when the attr is absent.
    /// </summary>
    public bool Filterable => OwnAttr(LAYOUT_DATA_GRID_ATTR_FILTERABLE) is true;

    /// <summary>A JSON-encoded preset filter string for the dataGrid layout.</summary>
    public string? Filter
    {
        get
        {
            var v = OwnAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
            return v is string s ? s : null;
        }
    }

    /// <summary>The ordered list of field names to display as columns in the dataGrid layout.</summary>
    public IReadOnlyList<string> Columns
    {
        get
        {
            var c = OwnAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
            return c is IReadOnlyList<string> list ? list : [];
        }
    }
}
