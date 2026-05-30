import { useMemo, type ReactNode } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type PaginationState,
  type ColumnFiltersState,
  type OnChangeFn,
} from "@tanstack/react-table";
import type { GridConfig } from "@metaobjectsdev/runtime-web";
import { useCellRenderers } from "./cell-renderer-provider.js";

export interface EntityGridState {
  sorting: SortingState;
  pagination: PaginationState;
  columnFilters: ColumnFiltersState;
}

export interface EntityGridProps<T> {
  columns:  ColumnDef<T>[];
  grid:     GridConfig;
  /** The single server page of rows. */
  data:     T[];
  /** Total rows matching the filter (server-supplied; drives page count). */
  rowCount: number;
  /** Controlled state — owned by the parent / generated grid hook. */
  state:    EntityGridState;
  onSortingChange:       OnChangeFn<SortingState>;
  onPaginationChange:    OnChangeFn<PaginationState>;
  onColumnFiltersChange: OnChangeFn<ColumnFiltersState>;
  /** Optional free-text search — input renders iff onSearchChange is supplied. */
  search?:         string;
  onSearchChange?: (value: string) => void;
  isLoading?:  boolean;
  error?:      Error | null;
  emptyState?: ReactNode;
  onRowClick?: (row: T) => void;
  actions?:    (row: T) => ReactNode;
  className?:           string;
  headerClassName?:     string;
  rowClassName?:        string;
  cellClassName?:       string;
  paginationClassName?: string;
  searchClassName?:     string;
}

/**
 * Controlled, server-driven data grid. All filter/sort/pagination state lives
 * outside; on-change callbacks fire so the parent re-queries. The component
 * renders `data` as-is — no client-side sort/paginate/filter row models.
 *
 * Cell rendering routes through the CellRendererProvider registry, keyed by
 * `column.meta.view`. Per-column `cell` always wins if set.
 */
// Row type is any object: the grid keys rows by index (no getRowId), so it
// never reads `id`. A stricter `{ id?: number | string }` bound wrongly rejected
// id-less projection rows (view models with composite identity, e.g. a
// my-courses view keyed by user+course), which the codegen explicitly generates
// grids for.
export function EntityGrid<T extends object>(
  props: EntityGridProps<T>,
): ReactNode {
  const renderers = useCellRenderers();

  const columns = useMemo<ColumnDef<T>[]>(() => {
    const base: ColumnDef<T>[] = props.columns.map((col): ColumnDef<T> => {
      if (col.cell) return col;
      const viewKey = (col.meta as { view?: string } | undefined)?.view;
      const renderer = viewKey ? renderers[viewKey] : undefined;
      if (!renderer) return col;
      return { ...col, cell: renderer } as ColumnDef<T>;
    });
    if (props.actions) {
      base.push({
        id: "__actions",
        header: "",
        cell: ({ row }) => props.actions!(row.original),
      });
    }
    return base;
  }, [props.columns, props.actions, renderers]);

  const table = useReactTable<T>({
    data: props.data,
    columns,
    rowCount: props.rowCount,
    state: props.state,
    onSortingChange:       props.onSortingChange,
    onPaginationChange:    props.onPaginationChange,
    onColumnFiltersChange: props.onColumnFiltersChange,
    manualSorting:    true,
    manualPagination: true,
    manualFiltering:  true,
    getCoreRowModel:  getCoreRowModel(),
  });

  if (!props.isLoading && props.data.length === 0 && props.emptyState) {
    return <>{props.emptyState}</>;
  }

  return (
    <div>
      {props.onSearchChange !== undefined && (
        <div className={props.searchClassName}>
          <input
            type="search"
            placeholder="Search"
            value={props.search ?? ""}
            onChange={(e) => props.onSearchChange!(e.target.value)}
          />
        </div>
      )}
      <table className={props.className}>
        <thead className={props.headerClassName}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const meta = h.column.columnDef.meta as { sortable?: boolean; width?: number } | undefined;
                const sortable = meta?.sortable !== false && h.column.getCanSort();
                const sortDir = h.column.getIsSorted();
                return (
                  <th
                    key={h.id}
                    style={meta?.width ? { width: meta.width } : undefined}
                    onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                    aria-sort={sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : "none"}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sortDir === "asc" ? " ↑" : sortDir === "desc" ? " ↓" : ""}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className={props.rowClassName}
              onClick={props.onRowClick ? () => props.onRowClick!(row.original) : undefined}
              style={props.onRowClick ? { cursor: "pointer" } : undefined}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className={props.cellClassName}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.getPageCount() > 1 && (
        <div className={props.paginationClassName}>
          <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>Prev</button>
          <span>Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}</span>
          <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>Next</button>
        </div>
      )}
    </div>
  );
}
