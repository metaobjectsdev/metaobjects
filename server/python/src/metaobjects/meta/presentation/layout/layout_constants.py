"""Layout subtype vocabulary (colocated)."""
from ....shared.base_types import SUBTYPE_BASE

LAYOUT_SUBTYPE_DATA_GRID = "dataGrid"
LAYOUT_SUBTYPES = (SUBTYPE_BASE, LAYOUT_SUBTYPE_DATA_GRID)

# layout.dataGrid attrs
LAYOUT_ATTR_COLUMNS = "columns"
LAYOUT_ATTR_DEFAULT_SORT_FIELD = "defaultSortField"
LAYOUT_ATTR_DEFAULT_SORT_ORDER = "defaultSortOrder"
LAYOUT_ATTR_PAGE_SIZE = "pageSize"
LAYOUT_ATTR_FILTERABLE = "filterable"
LAYOUT_ATTR_FILTER = "filter"
