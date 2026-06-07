// Layout attribute schemas — attrs for layout subtypes (e.g. dataGrid).
// Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import {
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_FILTER,
} from "../../core/attr/attr-constants.js";
import { SORT_ORDER_VALUES } from "../../core/query/query-constants.js";
import {
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
} from "./layout-constants.js";

/** Attrs on layout.dataGrid. */
export const dataGridLayoutAttrs: AttrSchema[] = [
  {
    name: LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Number of rows per page in the generated data grid.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Field name the grid is sorted by on initial render. Must reference an actual field on the entity.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...SORT_ORDER_VALUES],
    description: "Initial sort direction for the default sort field: 'asc' or 'desc'.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_FILTERABLE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description: "When true, the generated grid exposes column filtering UI.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_FILTER,
    valueType: ATTR_SUBTYPE_FILTER,
    required: false,
    description: "Structured preset filter object applied to the grid at the metadata level. Desugared to canonical { field: { op: value } } form at parse time.",
  },
  {
    name: LAYOUT_DATA_GRID_ATTR_COLUMNS,
    valueType: ATTR_SUBTYPE_STRING,
    isArray: true,
    required: false,
    description: "Flat ordered list of field names to display as grid columns.",
  },
];
