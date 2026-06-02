// Layout attribute schemas — attrs on layout.dataGrid.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/presentation/layout/layout-schema.ts.

using MetaObjects.Core.Attr;
using MetaObjects.Core.Query;

namespace MetaObjects.Presentation.Layout;

/// <summary>Attribute schemas for the layout concern.</summary>
public static class LayoutSchema
{
    /// <summary>Attrs on layout.dataGrid.</summary>
    public static readonly IReadOnlyList<AttrSchema> DataGridLayoutAttrs =
    [
        new AttrSchema(
            Name: LayoutConstants.LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
            ValueType: AttrConstants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Number of rows per page in the generated data grid."),

        new AttrSchema(
            Name: LayoutConstants.LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Field name the grid is sorted by on initial render. Must reference an actual field on the entity."),

        new AttrSchema(
            Name: LayoutConstants.LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. QueryConstants.SORT_ORDER_VALUES],
            Description: "Initial sort direction for the default sort field: 'asc' or 'desc'."),

        new AttrSchema(
            Name: LayoutConstants.LAYOUT_DATA_GRID_ATTR_FILTERABLE,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the generated grid exposes column filtering UI."),

        new AttrSchema(
            Name: LayoutConstants.LAYOUT_DATA_GRID_ATTR_FILTER,
            ValueType: AttrConstants.ATTR_SUBTYPE_FILTER,
            Required: false,
            Description: "Structured preset filter object applied to the grid at the metadata level. Desugared to canonical { field: { op: value } } form at parse time."),

        new AttrSchema(
            Name: LayoutConstants.LAYOUT_DATA_GRID_ATTR_COLUMNS,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            IsArray: true,
            Description: "Flat ordered list of field names to display as grid columns."),
    ];
}
