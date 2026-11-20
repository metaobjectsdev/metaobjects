// Shared answers to "how does this entity sort?" — used by every tier that has to
// answer it, so none of them can answer it differently.
//
// Two questions live here:
//   WHICH fields sort   — isSortableField / sortableFields, read by the generated
//                         <Entity>SortAllowlist (filter-allowlist.ts), the client
//                         <Entity>Filter sort union (filter-type.ts) and the agent
//                         UI page.
//   WHICH WAY one sorts — declaredSortDefaultOrder / sortDefaultOrder /
//                         resolveGridDefaultSort, read by the same allowlist, the
//                         generated grid const + grid hook, and the agent UI page.
//
// Keeping both here is what prevents a client/server mismatch: a header the grid
// renders clickable for a field the endpoint rejects, or a grid whose initial sort
// runs the opposite way from the endpoint it queries.

import { flatSurfaceFields } from "@metaobjectsdev/codegen-ts/engine";
import { hiddenFieldNames, isCredentialField, tphHierarchy } from "@metaobjectsdev/codegen-ts/engine";
import { MetaField, MetaObject, type MetaData, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
} from "@metaobjectsdev/metadata";

/** A resolved sort direction. Never widened to `string`: every door below either
 *  returns one of these two or says it has no answer. */
export type SortOrder = "asc" | "desc";

/**
 * Returns true if the given field is on the filter allowlist: it is marked `@filterable: true`
 * and is not a credential. A filter on a secret is an oracle for it (`eq`, or `like` a prefix,
 * one character at a time), so a credential (a field that declares a `view.password`) is never
 * filterable, whatever the model marks. The allowlist is built from this predicate, so a
 * request that names one is refused as any other field the allowlist does not hold.
 */
export function isFilterableField(field: MetaField): boolean {
  return field.attr(FIELD_ATTR_FILTERABLE) === true && !isCredentialField(field);
}

/**
 * Returns true if the given field should be included in sort operations.
 *
 * Rules (in priority order):
 *   0. a credential   → never sortable (the order of a secret leaks it)
 *   1. @sortable: true  → always sortable (even without @filterable)
 *   2. @sortable: false → never sortable (overrides @filterable)
 *   3. no @sortable     → sortable iff @filterable === true
 */
export function isSortableField(field: MetaField): boolean {
  if (isCredentialField(field)) return false;
  const sortableAttr = field.attr(FIELD_ATTR_SORTABLE);
  if (sortableAttr === true) return true;
  if (sortableAttr === false) return false;
  return field.attr(FIELD_ATTR_FILTERABLE) === true;
}

/**
 * The field names no allowlist of `entity` may hold because the column is a credential: a
 * `view.password` on ANY declaration of a column that subtypes of one single-table (TPH)
 * hierarchy share counts on every subtype that has it, the same rule the generated routes use to
 * hide the column. `root` is the loaded model the hierarchy is read from; without it the entity
 * stands alone.
 */
export function credentialFieldNames(entity: MetaObject, root: MetaRoot | undefined): ReadonlySet<string> {
  const hierarchy = root === undefined ? [entity] : tphHierarchy(entity, root);
  return new Set(hiddenFieldNames(entity, hierarchy));
}

/**
 * Returns all sortable field children of the given entity.
 */
export function sortableFields(entity: MetaObject, root?: MetaRoot): MetaField[] {
  // fields() returns effective fields, so inherited fields (from extends:/super:) are included in sort ops.
  const credentials = credentialFieldNames(entity, root);
  return flatSurfaceFields(entity).filter((f) => isSortableField(f) && !credentials.has(f.name));
}

/**
 * The direction `@sortableDefaultOrder` DECLARES on this field, or undefined when
 * the field declares none.
 *
 * The declared value is what the generated `<Entity>SortAllowlist` carries, so an
 * undeclared field stays `{}` there and the runtime's own `?? "asc"` remains the
 * single place the fallback is spelled. Callers that need a concrete direction
 * rather than a declaration use `sortDefaultOrder`.
 *
 * ADR-0039: resolving — `@sortableDefaultOrder` may be inherited via `extends`.
 */
export function declaredSortDefaultOrder(field: MetaField): SortOrder | undefined {
  const v = field.attr(FIELD_ATTR_SORTABLE_DEFAULT_ORDER);
  return v === "asc" || v === "desc" ? v : undefined;
}

/** The direction a sort runs when it names this field without giving one. */
export function sortDefaultOrder(field: MetaField): SortOrder {
  return declaredSortDefaultOrder(field) ?? "asc";
}

/** A grid's initial sort: the field it runs on and the direction it runs. */
export interface GridDefaultSort {
  field: string;
  order: SortOrder;
}

/**
 * A `layout.dataGrid`'s initial sort, resolved once for every tier that renders it.
 *
 * `@defaultSortOrder` wins when the layout declares one. When it does not, the
 * NAMED FIELD's `@sortableDefaultOrder` applies — that is what the attribute has
 * always been registered to mean ("the direction a sort takes when it names this
 * field but omits the order"), and it is the same rule the runtime applies to
 * `?sort=<field>` with no `:order`. Without this the two ends of one declaration
 * disagree: the endpoint returns the field's declared order while the grid that
 * queries it renders the opposite.
 *
 * Returns undefined when the layout names no field — a grid with no initial sort.
 *
 * The field lookup cannot miss on a LOADED model: `validateDataGridSortFields`
 * refuses `@defaultSortField` naming a field the entity does not have
 * (`ERR_BAD_DEFAULT_SORT_FIELD`). "asc" is the answer for a hand-built node that
 * never went through the loader, so codegen degrades rather than throwing.
 */
// `layout` is typed as the base MetaData rather than MetaLayout because the three
// call sites hold the node at different static types (`entity.layouts()` gives
// MetaLayout, the agent page's own `dataGrids()` gives MetaData) and this reads
// nothing but `attr()`, which is declared there. Widening beats a cast per caller.
export function resolveGridDefaultSort(
  entity: MetaObject,
  layout: MetaData,
): GridDefaultSort | undefined {
  // ADR-0039: resolving — a layout may inherit its grid attrs via extends.
  const fieldName = layout.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
  if (typeof fieldName !== "string" || fieldName === "") return undefined;

  const declared = layout.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER);
  if (declared === "asc" || declared === "desc") return { field: fieldName, order: declared };

  const field = flatSurfaceFields(entity).find((f) => f.name === fieldName);
  return { field: fieldName, order: field === undefined ? "asc" : sortDefaultOrder(field) };
}
