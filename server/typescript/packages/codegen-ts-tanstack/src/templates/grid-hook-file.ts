// Generated grid-hook template — emits one use<Entity><Grid>Grid() per
// layout[dataGrid] declared on the entity. The hook owns
// {sorting, pagination, columnFilters, search} state and runs the query
// against the entity's CRUD list route with withCount=1 (opt-in envelope).
//
// The hook returns the controlled-<EntityGrid> prop shape, so a consumer
// page is just:
//   const grid = useSubscriberDefaultGrid();
//   <EntityGrid {...grid} columns={subscriberDefaultColumns} grid={subscriberDefaultGrid} />

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaObject, MetaLayout } from "@metaobjectsdev/metadata";
import { LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjectsdev/metadata";
import type { RenderContext } from "@metaobjectsdev/codegen-ts";
import { GENERATED_HEADER, crossEntitySpecifier } from "@metaobjectsdev/codegen-ts";

interface GridSpec {
  name: string;           // e.g. "default", "activeOnly"
  pageSize: number;
  hasFilterPreset: boolean;
  defaultSortField?: string | undefined;
  defaultSortOrder?: "asc" | "desc" | undefined;
}

function extractGrids(entity: MetaObject): GridSpec[] {
  const out: GridSpec[] = [];
  for (const l of entity.layouts() as MetaLayout[]) {
    if (l.subType !== LAYOUT_SUBTYPE_DATA_GRID) continue;
    out.push({
      name: l.name || "default",
      pageSize: l.pageSize ?? 25,
      hasFilterPreset: l.filter !== undefined,
      defaultSortField: l.defaultSortField,
      defaultSortOrder: l.defaultSortOrder as "asc" | "desc" | undefined,
    });
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function renderGridHookFile(entity: MetaObject, ctx: RenderContext): string {
  const entityName = entity.name;
  const lcEntity   = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const grids      = extractGrids(entity);

  if (grids.length === 0) return "";

  // Sibling-entity import (same package — resolves to "./<Entity>").
  const entityModule = crossEntitySpecifier(
    ctx.outputLayout,
    entity.package,
    entity.package,
    entityName,
    ctx.extStyle,
  );

  // ts-poet symbols (imp()) — typed and deduped on emit.
  const useStateSym = imp("useState@react");
  const useMemoSym  = imp("useMemo@react");
  const useQuerySym = imp("useQuery@@tanstack/react-query");
  const SortingStateSym       = imp("t:SortingState@@tanstack/react-table");
  const PaginationStateSym    = imp("t:PaginationState@@tanstack/react-table");
  const ColumnFiltersStateSym = imp("t:ColumnFiltersState@@tanstack/react-table");
  const useEntityFetcherSym = imp("useEntityFetcher@@metaobjectsdev/tanstack");
  const buildFilterQsSym    = imp("buildFilterQs@@metaobjectsdev/runtime-web");

  const entityImports: Code = code`
import { ${entityName} } from ${JSON.stringify(entityModule)};
import type { ${entityName} as ${entityName}Row } from ${JSON.stringify(entityModule)};
`;

  // Collect names of all filter preset consts needed.
  const filterPresetImports: string[] = grids
    .filter((g) => g.hasFilterPreset)
    .map((g) => `${lcEntity}${capitalize(g.name)}Filter`);

  const filterPresetImportCode: Code =
    filterPresetImports.length > 0
      ? code`import { ${filterPresetImports.join(", ")} } from "./${entityName}.columns";\n`
      : code``;

  const sections: Code[] = grids.map((grid) => {
    const cap      = capitalize(grid.name);
    const hookName = `use${entityName}${cap}Grid`;
    const presetConst = grid.hasFilterPreset ? `${lcEntity}${cap}Filter` : null;

    const initialSorting = grid.defaultSortField
      ? `[{ id: ${JSON.stringify(grid.defaultSortField)}, desc: ${JSON.stringify(grid.defaultSortOrder === "desc")} }]`
      : `[]`;
    const initialPagination = `{ pageIndex: 0, pageSize: ${grid.pageSize} }`;

    return code`
export function ${hookName}() {
  const [sorting,       setSorting]       = ${useStateSym}<${SortingStateSym}>(${initialSorting});
  const [pagination,    setPagination]    = ${useStateSym}<${PaginationStateSym}>(${initialPagination});
  const [columnFilters, setColumnFilters] = ${useStateSym}<${ColumnFiltersStateSym}>([]);
  const [search,        setSearch]        = ${useStateSym}<string>("");

  const fetcher = ${useEntityFetcherSym}();

  const qs = ${useMemoSym}(() => {
    const filterObj: Record<string, unknown> = ${presetConst ? `{ ...${presetConst} }` : `{}`};
    for (const f of columnFilters) {
      filterObj[f.id] = f.value as unknown;
    }
    const sort = sorting.length > 0
      ? \`\${sorting[0].id}:\${sorting[0].desc ? "desc" : "asc"}\`
      : undefined;
    return ${buildFilterQsSym}({
      ...filterObj,
      ...(sort !== undefined ? { sort } : {}),
      limit:  pagination.pageSize,
      offset: pagination.pageIndex * pagination.pageSize,
      ...(search !== "" ? { search } : {}),
      withCount: 1,
    });
  }, [sorting, pagination, columnFilters, search]);

  const query = ${useQuerySym}<{ rows: ${entityName}Row[]; total: number }>({
    queryKey: [${JSON.stringify(lcEntity)}, "grid", ${JSON.stringify(grid.name)}, qs],
    queryFn: () => fetcher<{ rows: ${entityName}Row[]; total: number }>(
      \`\${${entityName}.$apiPrefix}\${${entityName}.$path}?\${qs}\`,
    ),
  });

  return {
    data: query.data?.rows ?? [],
    rowCount: query.data?.total ?? 0,
    state: { sorting, pagination, columnFilters },
    onSortingChange:       setSorting,
    onPaginationChange:    setPagination,
    onColumnFiltersChange: setColumnFilters,
    search,
    onSearchChange: setSearch,
    isLoading: query.isLoading,
    error:     query.error,
  };
}
`;
  });

  const header =
    `// ${GENERATED_HEADER}-tanstack — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;

  const body = joinCode(sections, { on: "\n" });
  return header + entityImports.toString() + filterPresetImportCode.toString() + body.toString();
}
