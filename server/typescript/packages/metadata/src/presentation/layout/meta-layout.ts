// MetaLayout — concrete node class for type=layout nodes.
// Object-level UI surfaces (Project E; replaces object-attached data-grid view
// subtype; views are strictly field-level per Java parity).
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "../../shared/meta-data.js";
import {
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
} from "./layout-constants.js";
import type { SortOrderValue } from "../../core/query/query-constants.js";

export class MetaLayout extends MetaData {
  /** The number of rows per page for the dataGrid layout. */
  get pageSize(): number | undefined {
    const v = this.ownAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE);
    return typeof v === "number" ? v : undefined;
  }

  /** The field name to sort by default in the dataGrid layout. */
  get defaultSortField(): string | undefined {
    const v = this.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
    return typeof v === "string" ? v : undefined;
  }

  /**
   * The default sort order (`"asc"` or `"desc"`) for the dataGrid layout.
   * Returns `undefined` when the attr is absent.
   */
  get defaultSortOrder(): SortOrderValue | undefined {
    const v = this.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER);
    return typeof v === "string" ? (v as SortOrderValue) : undefined;
  }

  /**
   * True when `@filterable: true` is set on the dataGrid layout.
   * Defaults to `false` when the attr is absent.
   */
  get filterable(): boolean {
    return this.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTERABLE) === true;
  }

  /** The desugared preset filter object for the dataGrid layout, or undefined. */
  get filter(): Record<string, unknown> | undefined {
    const v = this.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  }

  /** The ordered list of field names to display as columns in the dataGrid layout. */
  get columns(): string[] {
    const c = this.ownAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
    return Array.isArray(c) ? (c as string[]) : [];
  }
}
