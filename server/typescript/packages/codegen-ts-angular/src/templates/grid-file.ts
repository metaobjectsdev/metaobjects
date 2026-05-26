// Angular 18 grid template — emits a per-entity standalone Component that
// renders <mo-entity-grid> with column defs derived from a layout.dataGrid
// metadata child. Mirrors the TanStack columns-file.ts shape (column id +
// header + meta.view) but in Angular-native shape (EntityGridColumn[]).

import { code, imp } from "ts-poet";
import type { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import {
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
} from "@metaobjectsdev/metadata";
import type { RenderContext } from "@metaobjectsdev/codegen-ts";
import { GENERATED_HEADER, entityModuleSpecifier } from "@metaobjectsdev/codegen-ts";

interface ColumnSpec {
  id:        string;
  header:    string;
  viewKind:  string;
}

interface GridSpec {
  name:               string;
  pageSize:           number;
  defaultSortField?:  string;
  defaultSortOrder?:  "asc" | "desc";
  filterable:         boolean;
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

function extractGrids(entity: MetaObject): GridSpec[] {
  const fieldsByName = new Map(entity.fields().map((f) => [f.name, f] as const));
  const out: GridSpec[] = [];
  for (const layout of entity.layouts()) {
    if (layout.subType !== LAYOUT_SUBTYPE_DATA_GRID) continue;
    const columnsAttr = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
    const columnNames: string[] = Array.isArray(columnsAttr)
      ? (columnsAttr as unknown[]).filter((x): x is string => typeof x === "string")
      : [...fieldsByName.keys()];
    const columns: ColumnSpec[] = columnNames.flatMap((name) => {
      const f = fieldsByName.get(name);
      if (!f) return [];
      return [{ id: name, header: fieldLabel(f), viewKind: fieldViewKind(f) }];
    });
    const sortField = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
    const sortOrder = layout.ownAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER);
    const grid: GridSpec = {
      name: layout.name || "default",
      pageSize: (layout.ownAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE) as number | undefined) ?? 25,
      filterable: layout.ownAttr(LAYOUT_DATA_GRID_ATTR_FILTERABLE) === true,
      columns,
    };
    if (typeof sortField === "string") grid.defaultSortField = sortField;
    if (sortOrder === "asc" || sortOrder === "desc") grid.defaultSortOrder = sortOrder;
    out.push(grid);
  }
  return out;
}

function renderColumnLiteral(col: ColumnSpec): string {
  return `    { id: ${JSON.stringify(col.id)}, accessorKey: ${JSON.stringify(col.id)}, header: ${JSON.stringify(col.header)}, meta: { view: ${JSON.stringify(col.viewKind)} } }`;
}

export function renderGridFile(entity: MetaObject, ctx: RenderContext): string {
  const entityName = entity.name;
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const grids = extractGrids(entity);

  const ComponentSym = imp("Component@@angular/core");
  const signalSym = imp("signal@@angular/core");
  const CommonModuleSym = imp("CommonModule@@angular/common");
  const EntityGridComponentSym = imp("EntityGridComponent@@metaobjectsdev/angular");
  const EntityGridColumnSym = imp("t:EntityGridColumn@@metaobjectsdev/angular");
  const GridConfigSym = imp("t:GridConfig@@metaobjectsdev/angular");

  const entityModule = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entityName,
    ctx.extStyle,
  );

  // Emit one section per grid layout; the primary grid drives the default
  // export's columns + gridConfig fields.
  const primary = grids[0];
  if (!primary) {
    // Shouldn't happen — the factory filter requires a dataGrid layout.
    throw new Error(`renderGridFile: no dataGrid layout on ${entityName}`);
  }
  const columnsLiteral = primary.columns.map(renderColumnLiteral).join(",\n");
  const sortPart = primary.defaultSortField && primary.defaultSortOrder
    ? `,\n    defaultSort: { field: ${JSON.stringify(primary.defaultSortField)}, order: ${JSON.stringify(primary.defaultSortOrder)} }`
    : "";

  const literalImports = code`
import type { ${entityName} as ${entityName}Row } from ${JSON.stringify(entityModule)};
`;

  const body = code`
/**
 * Generated Angular grid component for ${entityName}. Wraps <mo-entity-grid>
 * with column defs derived from layout.dataGrid metadata. Rows arrive via the
 * \`data\` signal — wire it from your component / service.
 */
@${ComponentSym}({
  selector: ${JSON.stringify(`${entityName.toLowerCase()}-grid`)},
  standalone: true,
  imports: [${CommonModuleSym}, ${EntityGridComponentSym}],
  template: \`
    <mo-entity-grid
      [columns]="columns"
      [data]="data()"
      [grid]="gridConfig"
      [rowCount]="rowCount()"
    ></mo-entity-grid>
  \`,
})
export class ${entityName}GridComponent {
  readonly data = ${signalSym}<${entityName}Row[]>([]);
  readonly rowCount = ${signalSym}<number>(0);

  readonly columns: ${EntityGridColumnSym}[] = [
${columnsLiteral},
  ];

  readonly gridConfig: ${GridConfigSym} = {
    name: ${JSON.stringify(primary.name)},
    pageSize: ${primary.pageSize},
    filterable: ${primary.filterable}${sortPart},
  };
}
`;

  const _ = lcEntity; // reserved
  void _;

  const header =
    `// ${GENERATED_HEADER}-angular — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;
  return header + literalImports.toString() + body.toString();
}
