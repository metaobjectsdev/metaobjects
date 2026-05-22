import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaObject, MetaField } from "@metaobjectsdev/metadata";
import {
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
} from "@metaobjectsdev/metadata";
import type { RenderContext } from "@metaobjectsdev/codegen-ts";
import { GENERATED_HEADER, crossEntitySpecifier } from "@metaobjectsdev/codegen-ts";

interface ColumnSpec {
  id:        string;
  header:    string;     // humanized label
  viewKind:  string;     // field's view subtype, falls back to "text"
  sortable?: boolean;
  width?:    number;
  renderer?: string;
}

interface GridSpec {
  name:               string;
  pageSize:           number;
  defaultSortField?:  string;
  defaultSortOrder?:  "asc" | "desc";
  filterable:         boolean;
  filter?:            Record<string, unknown>;   // desugared, load-time-validated @filter object
  columns:            ColumnSpec[];
}

function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function fieldViewKind(field: MetaField): string {
  const view = field.ownViews()[0];
  return view?.subType ?? "text";
}

function fieldLabel(field: MetaField): string {
  const view = field.ownViews()[0];
  const label = view?.ownAttr("label");
  if (typeof label === "string") return label;
  return humanize(field.name);
}

/**
 * Extract grid specs from an entity's dataGrid layouts, resolving column
 * metadata against the entity's field list.
 *
 * Column set: read from @columns stringArray attr on the layout. If absent,
 * fall back to all fields on the entity (pre-E-T2 behaviour, kept for
 * backwards compat with metadata not yet migrated by E-T4).
 */
function extractGrids(entity: MetaObject): GridSpec[] {
  // fields() and layouts() are both effective (own + inherited via extends:/super:).
  const fieldsByName = new Map(
    entity.fields().map((f) => [f.name, f] as const),
  );

  const grids: GridSpec[] = [];
  for (const layout of entity.layouts()) {
    if (layout.subType !== LAYOUT_SUBTYPE_DATA_GRID) continue;

    // @columns is a stringArray attr on the layout (set by E-T4 migration).
    // Fall back to all entity fields if not present.
    const columnsAttr = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
    const columnNames: string[] = Array.isArray(columnsAttr)
      ? (columnsAttr as unknown[]).filter((x): x is string => typeof x === "string")
      : [...fieldsByName.keys()];

    const columns: ColumnSpec[] = columnNames.flatMap((name) => {
      const field = fieldsByName.get(name);
      if (!field) return [];     // columns ref that doesn't exist on entity; defensive skip
      const spec: ColumnSpec = {
        id:       name,
        header:   fieldLabel(field),
        viewKind: fieldViewKind(field),
      };
      return [spec];
    });

    const sortField = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
    const sortOrder = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER);

    const filterAttr = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTER);
    const grid: GridSpec = {
      name:       layout.name || "default",
      pageSize:   (layout.ownAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE) as number | undefined) ?? 25,
      filterable: layout.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTERABLE) === true,
      columns,
    };
    if (typeof sortField === "string") grid.defaultSortField = sortField;
    if (sortOrder === "asc" || sortOrder === "desc") grid.defaultSortOrder = sortOrder;
    if (typeof filterAttr === "object" && filterAttr !== null && !Array.isArray(filterAttr)) {
      grid.filter = filterAttr as Record<string, unknown>;
    }
    grids.push(grid);
  }
  return grids;
}

function renderColumnDef(col: ColumnSpec): string {
  const parts: string[] = [];
  parts.push(`    id: ${JSON.stringify(col.id)}`);
  parts.push(`    accessorKey: ${JSON.stringify(col.id)}`);
  parts.push(`    header: ${JSON.stringify(col.header)}`);
  const meta: string[] = [`view: ${JSON.stringify(col.viewKind)}`];
  if (col.sortable !== undefined) meta.push(`sortable: ${col.sortable}`);
  if (col.width    !== undefined) meta.push(`width: ${col.width}`);
  if (col.renderer !== undefined) meta.push(`renderer: ${JSON.stringify(col.renderer)}`);
  parts.push(`    meta: { ${meta.join(", ")} }`);
  return `  {\n${parts.join(",\n")}\n  }`;
}

export function renderColumnsFile(entity: MetaObject, ctx: RenderContext): string {
  const entityName = entity.name;
  const lcEntity   = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const grids      = extractGrids(entity);

  const ColumnDefSym = imp("t:ColumnDef@@tanstack/react-table");

  // Track whether any grid emits a filter const so we know to import <Entity>Filter.
  let hasFilterConst = false;

  const sections = grids.map((grid) => {
    const gridConstName    = `${lcEntity}${capitalize(grid.name)}Grid`;
    const columnsConstName = `${lcEntity}${capitalize(grid.name)}Columns`;

    const sortBlock = grid.defaultSortField && grid.defaultSortOrder
      ? `  defaultSort: { field: ${JSON.stringify(grid.defaultSortField)}, order: ${JSON.stringify(grid.defaultSortOrder)} as const },\n`
      : "";
    const gridConst = code`
export const ${gridConstName} = {
  name:        ${JSON.stringify(grid.name)},
  pageSize:    ${grid.pageSize},
${sortBlock}  filterable:  ${grid.filterable},
};
`;
    const colsLines = grid.columns.map(renderColumnDef).join(",\n");
    const colsConst = code`
export const ${columnsConstName}: ${ColumnDefSym}<${entityName}Row>[] = [
${colsLines},
];
`;

    // Emit per-grid filter const when @filter is set. The value is already a
    // desugared, load-time-validated object — emit it verbatim.
    let filterConstCode: Code | null = null;
    if (grid.filter !== undefined) {
      const filterConstName = `${lcEntity}${capitalize(grid.name)}Filter`;
      hasFilterConst = true;
      filterConstCode = code`
export const ${filterConstName}: ${entityName}Filter = ${JSON.stringify(grid.filter, null, 2)};
`;
    }

    return filterConstCode
      ? code`${gridConst}\n${colsConst}\n${filterConstCode}`
      : code`${gridConst}\n${colsConst}`;
  });

  const header =
    `// ${GENERATED_HEADER}-tanstack — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;

  // Same-entity sibling import (the entity's own file) — routed through the
  // shared helper so extStyle and package layout match the core generators.
  const entityModule = crossEntitySpecifier(
    ctx.outputLayout,
    entity.package,
    entity.package,
    entityName,
    ctx.extStyle,
  );
  // Import <Entity>Row always; import <Entity>Filter only when a filter const is emitted.
  const entityImportCode = hasFilterConst
    ? code`import type { ${entityName} as ${entityName}Row, ${entityName}Filter } from ${JSON.stringify(entityModule)};`
    : code`import type { ${entityName} as ${entityName}Row } from ${JSON.stringify(entityModule)};`;

  const body: Code = joinCode(sections, { on: "\n" });
  return header + entityImportCode.toString() + "\n" + body.toString();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
