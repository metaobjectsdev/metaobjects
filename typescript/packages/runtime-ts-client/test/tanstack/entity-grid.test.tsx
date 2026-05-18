import "../setup.js";
import { describe, test, expect } from "bun:test";
import { render, fireEvent, screen } from "@testing-library/react";
import { EntityGrid, type GridConfig } from "../../src/tanstack/index.js";
import type { ColumnDef } from "@tanstack/react-table";

type Row = { id: number; name: string; active: boolean };

const columns: ColumnDef<Row>[] = [
  { id: "name",   accessorKey: "name",   header: "Name",   meta: { view: "text" } },
  { id: "active", accessorKey: "active", header: "Active", meta: { view: "boolean" } },
];

const grid: GridConfig = { name: "default", pageSize: 25, filterable: false };

describe("<EntityGrid>", () => {
  test("renders headers from column.header", () => {
    render(<EntityGrid columns={columns} grid={grid} data={[]} />);
    expect(screen.getByText("Name")).toBeDefined();
    expect(screen.getByText("Active")).toBeDefined();
  });

  test("renders cell values via default renderers (boolean → Yes/No)", () => {
    const data: Row[] = [{ id: 1, name: "alice", active: true }, { id: 2, name: "bob", active: false }];
    render(<EntityGrid columns={columns} grid={grid} data={data} />);
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
    render(<EntityGrid columns={customColumns} grid={grid} data={[{ id: 1, name: "x", active: false }]} />);
    expect(screen.getByTestId("custom").textContent).toBe("[x]");
  });
});
