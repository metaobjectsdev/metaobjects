// Metadata-driven grid — the runtime twin of the `tanstackGrid()` codegen.
//
// Builds grid columns + config by walking a loaded MetaObject's fields and
// views at RUNTIME. Fully generic: no object or field names are hardcoded, so
// one call renders any object you've described in metadata. Pass any MetaObject
// (e.g. obtained from a loader, or via a MetaObjectAware row's getMetaData()).
//
// Mirrors the derivation in codegen-ts-tanstack's columns-file (humanized
// headers, the field's view subtype as the cell-renderer hint, @columns / grid
// attrs from the dataGrid layout) so a runtime-built grid matches a generated
// one. Browser-safe: depends only on @metaobjectsdev/metadata.
import type { MetaObject, MetaField, MetaView } from "@metaobjectsdev/metadata";
import {
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
} from "@metaobjectsdev/metadata";
import type { GridConfig } from "./fetcher.js";

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_GRID_NAME = "default";
// The view's display-label attr. Mirrors the literal used by the columns-file
// codegen; there is no exported constant for it in @metaobjectsdev/metadata.
const VIEW_ATTR_LABEL = "label";

/** A neutral, framework-agnostic column descriptor derived from metadata. */
export interface MetaColumn {
  /** The field's logical name (the data accessor key). */
  field: string;
  /** Display header — the field view's `label`, else the humanized field name. */
  header: string;
  /** Cell-renderer hint — the field's view subtype, else the field subtype. */
  viewKind: string;
}

export interface MetaGrid {
  config: GridConfig;
  columns: MetaColumn[];
}

/** camelCase / PascalCase → "Title Case" (matches the codegen `humanize`). */
function humanize(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function firstView(field: MetaField): MetaView | undefined {
  return field.ownViews()[0];
}

function header(field: MetaField): string {
  const label = firstView(field)?.ownAttr(VIEW_ATTR_LABEL);
  return typeof label === "string" ? label : humanize(field.name);
}

function viewKind(field: MetaField): string {
  return firstView(field)?.subType ?? field.subType;
}

/**
 * Build a grid (config + columns) from a MetaObject at runtime.
 *
 * If the object declares a `dataGrid` layout (optionally selected by `gridName`),
 * its `@columns`, `@pageSize`, sort and `@filterable` attrs drive the result.
 * Otherwise every field becomes a column with sensible defaults — so it works
 * for ANY object, with or without a declared grid.
 */
export function buildGrid(meta: MetaObject, gridName?: string): MetaGrid {
  const layouts = meta.layouts().filter((l) => l.subType === LAYOUT_SUBTYPE_DATA_GRID);
  const layout = gridName ? layouts.find((l) => l.name === gridName) : layouts[0];

  const fieldsByName = new Map(meta.fields().map((f) => [f.name, f] as const));

  const columnsAttr = layout?.ownAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
  const names: string[] = Array.isArray(columnsAttr)
    ? columnsAttr.filter((x): x is string => typeof x === "string")
    : meta.fields().map((f) => f.name);

  const columns: MetaColumn[] = names
    .map((n) => fieldsByName.get(n))
    .filter((f): f is MetaField => f !== undefined)
    .map((f) => ({ field: f.name, header: header(f), viewKind: viewKind(f) }));

  const pageSizeAttr = layout?.ownAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE);
  const sortField = layout?.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
  const sortOrder = layout?.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER);

  const config: GridConfig = {
    name: layout?.name ?? gridName ?? DEFAULT_GRID_NAME,
    pageSize: typeof pageSizeAttr === "number" ? pageSizeAttr : DEFAULT_PAGE_SIZE,
    filterable: layout?.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTERABLE) === true,
    ...(typeof sortField === "string"
      ? { defaultSort: { field: sortField, order: sortOrder === "desc" ? "desc" : "asc" } }
      : {}),
  };

  return { config, columns };
}
