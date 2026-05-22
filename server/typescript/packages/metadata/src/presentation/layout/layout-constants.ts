// Layout concern constants — subtypes and dataGrid attr keys.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Layout type — object-level UI surfaces (replaces Project B's object-attached
// data-grid view subtype; views are now strictly field-level per Java parity).
// ---------------------------------------------------------------------------

export const LAYOUT_SUBTYPE_DATA_GRID = "dataGrid";

export const LAYOUT_SUBTYPES = [
  SUBTYPE_BASE,
  LAYOUT_SUBTYPE_DATA_GRID,
] as const;
export type LayoutSubType = (typeof LAYOUT_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Layout attrs (on dataGrid layouts)
// ---------------------------------------------------------------------------

export const LAYOUT_DATA_GRID_ATTR_PAGE_SIZE          = "pageSize";
export const LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD = "defaultSortField";
export const LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER = "defaultSortOrder";
export const LAYOUT_DATA_GRID_ATTR_FILTERABLE         = "filterable";
export const LAYOUT_DATA_GRID_ATTR_FILTER             = "filter";
export const LAYOUT_DATA_GRID_ATTR_COLUMNS            = "columns";
