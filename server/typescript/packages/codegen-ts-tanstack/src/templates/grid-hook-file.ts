// Generated grid-hook template — emits one use<Entity><Grid>Grid() per
// layout[dataGrid] declared on the entity. The hook owns
// {sorting, pagination, columnFilters, search} state and runs the query
// against the entity's CRUD list route with withCount=1 (opt-in envelope).
//
// The hook returns the controlled-<EntityGrid> prop shape, so a consumer
// page is just:
//   const grid = useSubscriberDefaultGrid();
//   <EntityGrid {...grid} columns={subscriberDefaultColumns} grid={subscriberDefaultGrid} />

import { str, TsWriter } from "@metaobjectsdev/codegen-ts/engine";
import type { MetaObject, MetaLayout, MetaRoot } from "@metaobjectsdev/metadata";
import { LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjectsdev/metadata";
import type { RenderContext } from "@metaobjectsdev/codegen-ts/engine";

import {
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  entityModuleSpecifier,
  siblingSpecifier,
  effectivePackage,
} from "@metaobjectsdev/codegen-ts/engine";
import {
  resolveGridDefaultSort,
  type GridDefaultSort,
} from "@metaobjectsdev/codegen-ts/templates/filter-shared";

/** The DB-free `<Entity>.meta` descriptor. The UI generator writes it into ITS OWN target,
 *  beside this file, so it is always a sibling import — never the entity module's path,
 *  which on a multi-target project is another package's importBase. The UI files take the
 *  `<Entity>` descriptor from there so a browser bundle never pulls the Drizzle table in —
 *  it is the ONLY value they import from the entity module; everything else is `import type`. */
function metaModuleOf(entity: MetaObject, ctx: RenderContext): string {
  return siblingSpecifier(ctx.selfTarget, effectivePackage(entity), `${entity.name}.meta`, ctx.extStyle);
}

interface GridSpec {
  name: string;           // e.g. "default", "activeOnly"
  pageSize: number;
  hasFilterPreset: boolean;
  // Resolved through the SAME call the grid const uses, so the hook's initial
  // sorting and the const's `defaultSort` cannot disagree about one declaration.
  defaultSort?: GridDefaultSort | undefined;
}

function extractGrids(entity: MetaObject, root: MetaRoot): GridSpec[] {
  const out: GridSpec[] = [];
  for (const l of entity.layouts() as MetaLayout[]) {
    if (l.subType !== LAYOUT_SUBTYPE_DATA_GRID) continue;
    out.push({
      name: l.name || "default",
      pageSize: l.pageSize ?? 25,
      hasFilterPreset: l.filter !== undefined,
      // A @defaultSortField naming a credential resolves to no initial sort, as in the grid const.
      defaultSort: resolveGridDefaultSort(entity, l, root),
    });
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The grid hooks module for `entity`, or "" when it declares no dataGrid. */
export function renderGridHookFile(entity: MetaObject, ctx: RenderContext): string {
  if (extractGrids(entity, ctx.loadedRoot).length === 0) return "";
  const w = new TsWriter();
  writeGridHookFile(w, entity, ctx);
  return w.toString();
}

/** Write one use<Entity><Grid>Grid() hook per dataGrid layout of `entity` into `w`. */
export function writeGridHookFile(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  const entityName = entity.name;
  const lcEntity   = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const grids      = extractGrids(entity, ctx.loadedRoot);
  const pkg = effectivePackage(entity);

  w.header(
    `// ${GENERATED_HEADER}-tanstack — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entityName} (${entity.fqn()})`,
  );

  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityModule = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    pkg,
    entityName,
    ctx.extStyle,
  );
  const meta = w.use(entityName, metaModuleOf(entity, ctx));
  const row = w.useType(entityName, entityModule, `${entityName}Row`);
  // Columns file is a same-target sibling of the grid-hook (both emitted to
  // selfTarget) — always relative, package-layout aware. It holds the filter presets.
  const columnsModule = siblingSpecifier(ctx.selfTarget, pkg, `${entityName}.columns`, ctx.extStyle);

  const useState = w.use("useState", "react");
  const rowsType = `{ rows: ${row}[]; total: number }`;
  for (const grid of grids) {
    const cap = capitalize(grid.name);
    const preset = grid.hasFilterPreset ? w.use(`${lcEntity}${cap}Filter`, columnsModule) : undefined;
    const initialSorting = grid.defaultSort
      ? `[{ id: ${str(grid.defaultSort.field)}, desc: ${JSON.stringify(grid.defaultSort.order === "desc")} }]`
      : "[]";

    w.blank();
    w.block(`export function use${entityName}${cap}Grid() {`, () => {
      w.line(`const [sorting, setSorting] = ${useState}<${w.useType("SortingState", "@tanstack/react-table")}>(${initialSorting});`);
      w.line(`const [pagination, setPagination] = ${useState}<${w.useType("PaginationState", "@tanstack/react-table")}>({ pageIndex: 0, pageSize: ${grid.pageSize} });`);
      w.line(`const [columnFilters, setColumnFilters] = ${useState}<${w.useType("ColumnFiltersState", "@tanstack/react-table")}>([]);`);
      w.line(`const [search, setSearch] = ${useState}<string>("");`);
      w.blank();
      w.line(`const fetcher = ${w.use("useEntityPathFetcher", "@metaobjectsdev/tanstack")}();`);
      w.blank();
      w.open(`const qs = ${w.use("useMemo", "react")}(() => {`);
      w.line(`const filterObj: Record<string, unknown> = ${preset !== undefined ? `{ ...${preset} }` : "{}"};`);
      w.block("for (const f of columnFilters) {", () => w.line("filterObj[f.id] = f.value as unknown;"));
      w.line("const sortEntry = sorting[0];");
      w.line('const sort = sortEntry ? `${sortEntry.id}:${sortEntry.desc ? "desc" : "asc"}` : undefined;');
      w.block(`return ${w.use("buildFilterQs", "@metaobjectsdev/runtime-web")}({`, () => {
        w.line("...filterObj,");
        w.line("...(sort !== undefined ? { sort } : {}),");
        w.line("limit: pagination.pageSize,");
        w.line("offset: pagination.pageIndex * pagination.pageSize,");
        w.line('...(search !== "" ? { search } : {}),');
        w.line("withCount: 1,");
      }, "});");
      w.close("}, [sorting, pagination, columnFilters, search]);");
      w.blank();
      w.block(`const query = ${w.use("useQuery", "@tanstack/react-query")}<${rowsType}>({`, () => {
        w.line(`queryKey: [${str(lcEntity)}, "grid", ${str(grid.name)}, qs],`);
        w.line(`queryFn: () => fetcher<${rowsType}>(\`\${${meta}.$path}?\${qs}\`),`);
      }, "});");
      w.blank();
      w.block("return {", () => {
        w.line("data: query.data?.rows ?? [],");
        w.line("rowCount: query.data?.total ?? 0,");
        w.line("state: { sorting, pagination, columnFilters },");
        w.line("onSortingChange: setSorting,");
        w.line("onPaginationChange: setPagination,");
        w.line("onColumnFiltersChange: setColumnFilters,");
        w.line("search,");
        w.line("onSearchChange: setSearch,");
        w.line("isLoading: query.isLoading,");
        w.line("error: query.error,");
      }, "};");
    });
  }
}
