import "../setup.js";
import { describe, test, expect, mock } from "bun:test";
import { render, fireEvent, screen } from "@testing-library/react";
import { EntityGrid } from "../../src/tanstack/entity-grid.js";
import type { ColumnDef } from "@tanstack/react-table";
import type { EntityGridState } from "../../src/tanstack/entity-grid.js";
import type { GridConfig } from "../../src/tanstack/types.js";

type Row = { id: number; name: string; active?: boolean };

const baseColumns: ColumnDef<Row>[] = [
  { id: "id",   accessorKey: "id",   header: "ID" },
  { id: "name", accessorKey: "name", header: "Name" },
];

const columns: ColumnDef<Row>[] = [
  { id: "name",   accessorKey: "name",   header: "Name",   meta: { view: "text" } },
  { id: "active", accessorKey: "active", header: "Active", meta: { view: "boolean" } },
];

const grid: GridConfig = { name: "default", pageSize: 25, filterable: false };

const baseState: EntityGridState = {
  sorting: [],
  pagination: { pageIndex: 0, pageSize: 25 },
  columnFilters: [],
};

const noopHandlers = {
  onSortingChange:       () => {},
  onPaginationChange:    () => {},
  onColumnFiltersChange: () => {},
};

// ---------------------------------------------------------------------------
// Existing API tests — adapted to controlled prop API
// ---------------------------------------------------------------------------
describe("<EntityGrid> — core rendering", () => {
  test("renders headers from column.header", () => {
    render(
      <EntityGrid
        columns={columns}
        grid={grid}
        data={[]}
        rowCount={0}
        state={baseState}
        {...noopHandlers}
      />,
    );
    expect(screen.getByText("Name")).toBeDefined();
    expect(screen.getByText("Active")).toBeDefined();
  });

  test("renders cell values via default renderers (boolean → Yes/No)", () => {
    const data: Row[] = [{ id: 1, name: "alice", active: true }, { id: 2, name: "bob", active: false }];
    render(
      <EntityGrid
        columns={columns}
        grid={grid}
        data={data}
        rowCount={2}
        state={{ ...baseState, pagination: { pageIndex: 0, pageSize: 25 } }}
        {...noopHandlers}
      />,
    );
    expect(screen.getByText("alice")).toBeDefined();
    expect(screen.getByText("Yes")).toBeDefined();
    expect(screen.getByText("No")).toBeDefined();
  });

  test("calls onRowClick with the original row data", () => {
    const data: Row[] = [{ id: 7, name: "carol", active: true }];
    let clicked: Row | null = null;
    render(
      <EntityGrid
        columns={columns}
        grid={grid}
        data={data}
        rowCount={1}
        state={baseState}
        {...noopHandlers}
        onRowClick={(row) => { clicked = row; }}
      />,
    );
    const cell = screen.getByText("carol");
    fireEvent.click(cell.closest("tr")!);
    expect(clicked!).toEqual({ id: 7, name: "carol", active: true });
  });

  test("renders emptyState when data is empty and not loading", () => {
    render(
      <EntityGrid
        columns={columns}
        grid={grid}
        data={[]}
        rowCount={0}
        state={baseState}
        {...noopHandlers}
        emptyState={<p data-testid="empty">No rows</p>}
      />,
    );
    expect(screen.getByTestId("empty").textContent).toBe("No rows");
  });

  test("renders trailing actions column when `actions` prop is set", () => {
    const data: Row[] = [{ id: 1, name: "a", active: true }];
    render(
      <EntityGrid
        columns={columns}
        grid={grid}
        data={data}
        rowCount={1}
        state={baseState}
        {...noopHandlers}
        actions={(row) => <button data-testid={`act-${row.id}`}>Edit</button>}
      />,
    );
    expect(screen.getByTestId("act-1").textContent).toBe("Edit");
  });

  test("explicit column.cell wins over the registry lookup", () => {
    const customColumns: ColumnDef<Row>[] = [
      { id: "name", accessorKey: "name", header: "Name",
        meta: { view: "text" },
        cell: ({ getValue }) => <span data-testid="custom">[{String(getValue())}]</span> },
    ];
    render(
      <EntityGrid
        columns={customColumns}
        grid={grid}
        data={[{ id: 1, name: "x", active: false }]}
        rowCount={1}
        state={baseState}
        {...noopHandlers}
      />,
    );
    expect(screen.getByTestId("custom").textContent).toBe("[x]");
  });
});

// ---------------------------------------------------------------------------
// Controlled / server-driven tests
// ---------------------------------------------------------------------------
describe("EntityGrid — controlled, server-driven", () => {
  test("renders the data array as-is — no client-side sort/paginate", () => {
    // 3 rows; pageSize=2; in client-side mode getPaginationRowModel would
    // show only 2 rows. In server-driven mode the page IS the data — all 3 show.
    const data: Row[] = [{ id: 1, name: "c" }, { id: 2, name: "a" }, { id: 3, name: "b" }];
    const { container } = render(
      <EntityGrid
        columns={baseColumns}
        grid={{ ...grid, pageSize: 2 }}
        data={data}
        rowCount={50}
        state={{ sorting: [], pagination: { pageIndex: 0, pageSize: 2 }, columnFilters: [] }}
        {...noopHandlers}
      />,
    );
    const dataRows = container.querySelectorAll("tbody tr");
    expect(dataRows.length).toBe(3);
  });

  test("derives page count from rowCount, not data.length", () => {
    const data: Row[] = [{ id: 1, name: "a" }];
    const { container } = render(
      <EntityGrid
        columns={baseColumns}
        grid={{ ...grid, pageSize: 10 }}
        data={data}
        rowCount={100}
        state={{ sorting: [], pagination: { pageIndex: 0, pageSize: 10 }, columnFilters: [] }}
        {...noopHandlers}
      />,
    );
    // 100 / 10 = 10 pages. Pager shows "Page 1 of 10".
    const pageSpan = container.querySelector("span");
    expect(pageSpan?.textContent).toMatch(/Page 1 of 10/);
  });

  test("calls onSortingChange when a sortable header is clicked (does not sort in-memory)", () => {
    const onSortingChange = mock(() => {});
    const data: Row[] = [{ id: 1, name: "z" }, { id: 2, name: "a" }];
    const { container } = render(
      <EntityGrid
        columns={baseColumns}
        grid={grid}
        data={data}
        rowCount={2}
        state={{ sorting: [], pagination: { pageIndex: 0, pageSize: 10 }, columnFilters: [] }}
        onSortingChange={onSortingChange}
        onPaginationChange={() => {}}
        onColumnFiltersChange={() => {}}
      />,
    );
    const headers = container.querySelectorAll("thead th");
    fireEvent.click(headers[1]!); // "Name" header
    expect(onSortingChange).toHaveBeenCalledTimes(1);
    // The data order in the DOM must remain unchanged (no in-memory sort).
    const firstCell = container.querySelector("tbody tr td:nth-child(2)")?.textContent;
    expect(firstCell).toBe("z");
  });

  test("calls onPaginationChange when Next is clicked", () => {
    const onPaginationChange = mock(() => {});
    const data: Row[] = [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    const { container } = render(
      <EntityGrid
        columns={baseColumns}
        grid={{ ...grid, pageSize: 2 }}
        data={data}
        rowCount={10}
        state={{ sorting: [], pagination: { pageIndex: 0, pageSize: 2 }, columnFilters: [] }}
        onSortingChange={() => {}}
        onPaginationChange={onPaginationChange}
        onColumnFiltersChange={() => {}}
      />,
    );
    // Use container-scoped query to avoid ambiguity with sibling rendered grids
    const nextBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Next",
    )!;
    expect(nextBtn).toBeTruthy();
    fireEvent.click(nextBtn);
    expect(onPaginationChange).toHaveBeenCalledTimes(1);
  });

  test("renders the search input and calls onSearchChange when typed (only when onSearchChange supplied)", () => {
    const onSearchChange = mock((_v: string) => {});
    const { getByPlaceholderText, queryByPlaceholderText, rerender } = render(
      <EntityGrid
        columns={baseColumns}
        grid={grid}
        data={[]}
        rowCount={0}
        state={{ sorting: [], pagination: { pageIndex: 0, pageSize: 10 }, columnFilters: [] }}
        {...noopHandlers}
        search=""
        onSearchChange={onSearchChange}
      />,
    );
    const input = getByPlaceholderText(/search/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onSearchChange).toHaveBeenCalledWith("abc");

    // When onSearchChange is omitted, the input is NOT rendered.
    rerender(
      <EntityGrid
        columns={baseColumns}
        grid={grid}
        data={[]}
        rowCount={0}
        state={{ sorting: [], pagination: { pageIndex: 0, pageSize: 10 }, columnFilters: [] }}
        {...noopHandlers}
      />,
    );
    expect(queryByPlaceholderText(/search/i)).toBeNull();
  });
});
