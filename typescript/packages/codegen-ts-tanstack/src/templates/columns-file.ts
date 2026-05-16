import { code, imp, type Code } from "ts-poet";
import type { MetaData } from "@metaobjects/metadata";
import {
  TYPE_VIEW, TYPE_FIELD,
  TYPE_LAYOUT,
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  FIELD_ATTR_FILTERABLE,
  opsForSubType,
} from "@metaobjects/metadata";
import type { RenderContext } from "@metaobjects/codegen-ts";
import { GENERATED_HEADER } from "@metaobjects/codegen-ts";
import { validateGridFilter, type FilterAllowlist } from "../grid-filter-validate.js";

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
  filter?:            string;   // raw JSON-encoded @filter string from metadata
  columns:            ColumnSpec[];
}

/**
 * Build a FilterAllowlist from the entity's @filterable fields.
 * Mirrors the logic in codegen-ts's renderFilterAllowlist — used here at codegen time
 * to validate @filter values on data-grid views.
 */
function buildAllowlistForEntity(entity: MetaData): FilterAllowlist {
  const result: Record<string, { ops: readonly string[]; subType: string; leadingWildcard: boolean }> = {};
  // Use effectiveChildren() so inherited fields (from extends:/super:) are included in allowlist.
  for (const f of entity.effectiveChildren().filter((c) => c.type === TYPE_FIELD && c.attr(FIELD_ATTR_FILTERABLE) === true)) {
    result[f.name] = { ops: opsForSubType(f.subType), subType: f.subType, leadingWildcard: false };
  }
  return result as FilterAllowlist;
}

function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function fieldViewKind(field: MetaData): string {
  const view = field.children().find((c) => c.type === TYPE_VIEW);
  return view?.subType ?? "text";
}

function fieldLabel(field: MetaData): string {
  const view = field.children().find((c) => c.type === TYPE_VIEW);
  const label = view?.attr("label");
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
function extractGrids(entity: MetaData): GridSpec[] {
  // Use effectiveChildren() so inherited fields and layouts (from extends:/super:) are included.
  const effective = entity.effectiveChildren();
  const fieldsByName = new Map(
    effective.filter((c) => c.type === TYPE_FIELD).map((f) => [f.name, f] as const),
  );

  const grids: GridSpec[] = [];
  for (const layout of effective) {
    if (layout.type !== TYPE_LAYOUT || layout.subType !== LAYOUT_SUBTYPE_DATA_GRID) continue;

    // @columns is a stringArray attr on the layout (set by E-T4 migration).
    // Fall back to all entity fields if not present.
    const columnsAttr = layout.attr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
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

    const sortField = layout.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
    const sortOrder = layout.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER);

    const filterAttr = layout.attr(LAYOUT_DATA_GRID_ATTR_FILTER);
    const grid: GridSpec = {
      name:       layout.name || "default",
      pageSize:   (layout.attr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE) as number | undefined) ?? 25,
      filterable: layout.attr(LAYOUT_DATA_GRID_ATTR_FILTERABLE) === true,
      columns,
    };
    if (typeof sortField === "string") grid.defaultSortField = sortField;
    if (sortOrder === "asc" || sortOrder === "desc") grid.defaultSortOrder = sortOrder;
    if (typeof filterAttr === "string" && filterAttr.length > 0) grid.filter = filterAttr;
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

export function renderColumnsFile(entity: MetaData, _ctx: RenderContext): string {
  const entityName = entity.name;
  const lcEntity   = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const grids      = extractGrids(entity);

  const ColumnDefSym = imp("t:ColumnDef@@tanstack/react-table");

  // Build allowlist once per entity (same for all grids).
  const entityAllowlist = buildAllowlistForEntity(entity);

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

    // Emit per-grid filter const when @filter is set on the data-grid view.
    let filterConstCode: Code | null = null;
    if (grid.filter !== undefined) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(grid.filter);
      } catch (err) {
        throw new Error(
          `[grid-filter] ${entityName}.${grid.name} @filter is not valid JSON: ${(err as Error).message}`,
        );
      }
      const errors = validateGridFilter(parsed, entityAllowlist, `${entityName}.${grid.name}`);
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }
      const filterConstName = `${lcEntity}${capitalize(grid.name)}Filter`;
      hasFilterConst = true;
      filterConstCode = code`
export const ${filterConstName}: ${entityName}Filter = ${JSON.stringify(parsed, null, 2)};
`;
    }

    return filterConstCode
      ? code`${gridConst}\n${colsConst}\n${filterConstCode}`
      : code`${gridConst}\n${colsConst}`;
  });

  const header =
    `// ${GENERATED_HEADER}-tanstack — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;

  // Import <Entity>Row always; import <Entity>Filter only when a filter const is emitted.
  const entityImportCode = hasFilterConst
    ? code`import type { ${entityName} as ${entityName}Row, ${entityName}Filter } from "./${entityName}";`
    : code`import type { ${entityName} as ${entityName}Row } from "./${entityName}";`;

  const body: Code = code`${sections.join("\n")}`;
  return header + entityImportCode.toString() + "\n" + body.toString();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
