import { useMemo, type ReactNode } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import type { GridConfig } from "./types.js";
import { useCellRenderers } from "./cell-renderer-provider.js";

export interface EntityGridProps<T> {
  columns:  ColumnDef<T>[];
  grid:     GridConfig;
  data:     T[];
  isLoading?: boolean;
  error?:    Error | null;
  emptyState?: ReactNode;
  onRowClick?: (row: T) => void;
  actions?:    (row: T) => ReactNode;
  className?:           string;
  headerClassName?:     string;
  rowClassName?:        string;
  cellClassName?:       string;
  paginationClassName?: string;
}

/**
 * Opinionated table component built on TanStack Table.
 * Cell rendering routes through the CellRendererProvider registry, keyed by
 * `column.meta.view`. Per-column `cell` always wins if set.
 *
 * For advanced cases (virtualization, drag-and-drop, custom layout) drop
 * down to `useReactTable` directly with the same generated columns array.
 */
export function EntityGrid<T extends { id?: number | string }>(
  props: EntityGridProps<T>,
): ReactNode {
  const renderers = useCellRenderers();

  // Inject registry-backed cell renderers for columns without an explicit cell.
  const columns = useMemo<ColumnDef<T>[]>(() => {
    const base: ColumnDef<T>[] = props.columns.map((col): ColumnDef<T> => {
      if (col.cell) return col;
      const viewKey = (col.meta as { view?: string } | undefined)?.view;
      const renderer = viewKey ? renderers[viewKey] : undefined;
      if (!renderer) return col;
      return { ...col, cell: renderer } as ColumnDef<T>;
    });
    if (props.actions) {
      const actionsCol: ColumnDef<T> = {
        id: "__actions",
        header: "",
        cell: ({ row }) => props.actions!(row.original),
      };
      base.push(actionsCol);
    }
    return base;
  }, [props.columns, props.actions, renderers]);

  const initialSort: SortingState = props.grid.defaultSort
    ? [{ id: props.grid.defaultSort.field, desc: props.grid.defaultSort.order === "desc" }]
    : [];

  const table = useReactTable<T>({
    data: props.data,
    columns,
    initialState: {
      sorting: initialSort,
      pagination: { pageIndex: 0, pageSize: props.grid.pageSize },
    },
    getCoreRowModel:       getCoreRowModel(),
    getSortedRowModel:     getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  if (!props.isLoading && props.data.length === 0 && props.emptyState) {
    return <>{props.emptyState}</>;
  }

  return (
    <div>
      <table className={props.className}>
        <thead className={props.headerClassName}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const meta = h.column.columnDef.meta as { sortable?: boolean; width?: number } | undefined;
                const sortable = meta?.sortable !== false && h.column.getCanSort();
                return (
                  <th
                    key={h.id}
                    style={meta?.width ? { width: meta.width } : undefined}
                    onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                    aria-sort={
                      h.column.getIsSorted() === "asc"  ? "ascending"  :
                      h.column.getIsSorted() === "desc" ? "descending" :
                      "none"
                    }
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {h.column.getIsSorted() === "asc"  ? " ↑" : ""}
                    {h.column.getIsSorted() === "desc" ? " ↓" : ""}
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
