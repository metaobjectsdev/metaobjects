// Shared predicate for "is this field sortable?" — used by both filter-allowlist.ts
// (SortAllowlist generation) and filter-type.ts (sort union generation).
// Both must agree on which fields are sortable; keeping them in sync via this shared
// helper prevents client/server mismatches.

import { MetaField, MetaObject } from "@metaobjects/metadata";
import { FIELD_ATTR_FILTERABLE, FIELD_ATTR_SORTABLE } from "@metaobjects/metadata";

/**
 * Returns true if the given field should be included in sort operations.
 *
 * Rules (in priority order):
 *   1. @sortable: true  → always sortable (even without @filterable)
 *   2. @sortable: false → never sortable (overrides @filterable)
 *   3. no @sortable     → sortable iff @filterable === true
 */
export function isSortableField(field: MetaField): boolean {
  const sortableAttr = field.attr(FIELD_ATTR_SORTABLE);
  if (sortableAttr === true) return true;
  if (sortableAttr === false) return false;
  return field.attr(FIELD_ATTR_FILTERABLE) === true;
}

/**
 * Returns all sortable field children of the given entity.
 */
export function sortableFields(entity: MetaObject): MetaField[] {
  // fields() returns effective fields, so inherited fields (from extends:/super:) are included in sort ops.
  return entity.fields().filter(isSortableField);
}
