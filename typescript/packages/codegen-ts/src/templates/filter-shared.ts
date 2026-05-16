// Shared predicate for "is this field sortable?" — used by both filter-allowlist.ts
// (SortAllowlist generation) and filter-type.ts (sort union generation).
// Both must agree on which fields are sortable; keeping them in sync via this shared
// helper prevents client/server mismatches.

import type { MetaData } from "@metaobjects/metadata";
import { TYPE_FIELD, FIELD_ATTR_FILTERABLE, FIELD_ATTR_SORTABLE } from "@metaobjects/metadata";

/**
 * Returns true if the given MetaData child should be included in sort operations.
 *
 * Rules (in priority order):
 *   1. @sortable: true  → always sortable (even without @filterable)
 *   2. @sortable: false → never sortable (overrides @filterable)
 *   3. no @sortable     → sortable iff @filterable === true
 */
export function isSortableField(field: MetaData): boolean {
  const sortableAttr = field.attr(FIELD_ATTR_SORTABLE);
  if (sortableAttr === true) return true;
  if (sortableAttr === false) return false;
  return field.attr(FIELD_ATTR_FILTERABLE) === true;
}

/**
 * Returns all sortable field children of the given entity MetaData.
 */
export function sortableFields(entity: MetaData): MetaData[] {
  // Use effectiveChildren() so inherited fields (from extends:/super:) are included in sort ops.
  return entity.effectiveChildren().filter((c) => c.type === TYPE_FIELD && isSortableField(c));
}
