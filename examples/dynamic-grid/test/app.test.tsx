/**
 * The whole page: a menu, a grid and a form for every entity, none of them named in the
 * client's code, and a model that can change while the page is open.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within, type RenderResult } from "@testing-library/react";
import { App } from "../src/client/app";
import { API_PREFIX, buildApp } from "../src/server/app";
import { openRuntime } from "../src/server/runtime";
import { headers, inProcess, tableRows, type Transport } from "./client-helpers";
import { copyProject, openDemo, type Demo, type ProjectCopy } from "./helpers";

let project: ProjectCopy;
let demo: Demo;
let transport: Transport;
beforeEach(async () => {
  project = copyProject();
  demo = await openDemo({ projectDir: project.dir });
  transport = inProcess(demo.app);
});
afterEach(async () => {
  cleanup();
  await demo.close();
  project.remove();
});

/** Render the page and wait for the first grid. `pollMs` is short so a reload shows quickly. */
async function page(): Promise<RenderResult> {
  const view = render(<App fetcher={transport.fetcher} baseUrl={API_PREFIX} pollMs={20} />);
  await waitFor(() => expect(view.container.querySelector('main [aria-busy="false"]')).not.toBeNull());
  return view;
}

const menu = (view: RenderResult): string[] => [...view.getByRole("navigation").querySelectorAll("button")].map((b) => b.textContent ?? "");
const main = (view: RenderResult): HTMLElement => view.getByRole("main");
const settled = (view: RenderResult): Promise<void> => waitFor(() => expect(main(view).querySelector('[aria-busy="false"]')).not.toBeNull());

describe("one page for every entity", () => {
  test("the menu is the model's entities, and each opens its own grid", async () => {
    const view = await page();
    expect(menu(view)).toEqual(["Customer", "Technician", "Part", "Work Order", "Work Order Line"]);
    expect(headers(main(view))).toEqual(["Name", "Email", "Tier", "Active"]);

    fireEvent.click(within(view.getByRole("navigation")).getByText("Part"));
    await waitFor(() => expect(headers(main(view))).toEqual(["Sku", "Name", "Unit Price Cents", "Stock Qty", "Discontinued"]));
    await settled(view);
    expect(tableRows(main(view))).toHaveLength(6);
  });

  test("a row opens its form, and a to-many relationship lists the related rows beside it", async () => {
    const view = await page();
    fireEvent.click(within(view.getByRole("navigation")).getByText("Work Order"));
    await waitFor(() => expect(within(main(view)).getByText("Replace oven conveyor bearing")).toBeDefined());
    fireEvent.click(within(main(view)).getByText("Replace oven conveyor bearing"));

    const side = await waitFor(() => view.getByRole("complementary"));
    await waitFor(() => expect((within(side).getByLabelText("Title *") as HTMLInputElement).value).toBe("Replace oven conveyor bearing"));
    // relationship.composition `lines`: the lines of this work order, and only this one.
    const lines = within(side).getByLabelText("Work Order Line list");
    await waitFor(() => expect(tableRows(lines)).toHaveLength(2));
    expect(tableRows(lines).map((row) => row[1])).toEqual(["BRG-6204", "BLT-M8-40"]);
  });

  test("a row created in the form shows up in the grid", async () => {
    const view = await page();
    fireEvent.click(view.getByText("New Customer"));
    const side = await waitFor(() => view.getByRole("complementary"));
    fireEvent.change(within(side).getByLabelText("Name *"), { target: { value: "Aardvark Tooling" } });
    fireEvent.click(within(side).getByText("Create"));
    await waitFor(() => expect(tableRows(main(view))[0]?.[0]).toBe("Aardvark Tooling"));
    expect(within(main(view)).getByText("5 rows")).toBeDefined();
  });
});

describe("the metadata changes while the page is open", () => {
  test("a new field, column and entity appear, with nothing regenerated", async () => {
    const view = await page();
    fireEvent.click(within(view.getByRole("navigation")).getByText("Part"));
    await waitFor(() => expect(headers(main(view))).toContain("Stock Qty"));

    project.editModel(
      "- field.boolean: { name: discontinued, required: true, default: false, filterable: true }",
      "- field.boolean: { name: discontinued, required: true, default: false, filterable: true }\n          - field.int: { name: warrantyMonths, filterable: true, sortable: true }",
    );
    project.editModel("columns: [sku, name, unitPriceCents, stockQty, discontinued]", "columns: [sku, name, warrantyMonths]");
    project.appendModel(`
    - object.entity:
        name: Supplier
        children:
          - source.rdb: { table: suppliers }
          - field.long: { name: id }
          - field.string: { name: name, required: true, maxLength: 120, filterable: true }
          - field.enum: { name: rating, values: [preferred, approved, probation], filterable: true }
          - identity.primary: { name: pk, fields: id, generation: increment }
          - layout.dataGrid: { name: default, columns: [name, rating], defaultSortField: name, filterable: true }
`);
    await demo.runtime.reload();

    // The open page notices the new revision by itself.
    await waitFor(() => expect(headers(main(view))).toEqual(["Sku", "Name", "Warranty Months"]));
    expect(menu(view)).toEqual(["Customer", "Technician", "Part", "Work Order", "Work Order Line", "Supplier"]);

    // The new field is in the form, and the new entity has a grid and a form of its own.
    fireEvent.click(view.getByText("New Part"));
    const side = await waitFor(() => view.getByRole("complementary"));
    expect(within(side).getByLabelText("Warranty Months").getAttribute("type")).toBe("number");

    fireEvent.click(within(view.getByRole("navigation")).getByText("Supplier"));
    await waitFor(() => expect(headers(main(view))).toEqual(["Name", "Rating"]));
    fireEvent.click(view.getByText("New Supplier"));
    const supplier = await waitFor(() => view.getByRole("complementary"));
    fireEvent.change(within(supplier).getByLabelText("Name *"), { target: { value: "Bearing Supply Co" } });
    fireEvent.change(within(supplier).getByLabelText("Rating"), { target: { value: "preferred" } });
    fireEvent.click(within(supplier).getByText("Create"));
    await waitFor(() => expect(tableRows(main(view))).toEqual([["Bearing Supply Co", "Preferred"]]));
  });

  test("a model that does not load is refused, and the page keeps the one it has", async () => {
    const view = await page();
    project.editModel("values: [standard, gold, platinum]", "values: [standard, gold, platinum\n  nonsense: [");
    await expect(demo.runtime.reload()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(menu(view)).toHaveLength(5);
    expect(headers(main(view))).toEqual(["Name", "Email", "Tier", "Active"]);
  });
});

describe("no entity is named in the client", () => {
  test("a model whose every name is new is served by the same grid, form and routes", async () => {
    const fresh = copyProject();
    fresh.replaceModel(`metadata:
  package: demo::observatory
  children:
    - object.entity:
        name: Telescope
        children:
          - source.rdb: { table: telescopes }
          - field.long: { name: id }
          - field.string: { name: callsign, required: true, maxLength: 40, filterable: true }
          - field.int: { name: apertureMm, filterable: true, sortable: true }
          - field.enum: { name: mount, values: [dobsonian, equatorial, altazimuth], filterable: true }
          - identity.primary: { name: pk, fields: id, generation: increment }
          - layout.dataGrid: { name: default, columns: [callsign, apertureMm, mount], defaultSortField: callsign, filterable: true }
`);
    const runtime = await openRuntime({ projectDir: fresh.dir });
    const app = buildApp({ runtime, rules: [] });
    const other = inProcess(app);
    try {
      const view = render(<App fetcher={other.fetcher} baseUrl={API_PREFIX} pollMs={20} />);
      await waitFor(() => expect(view.container.querySelector('main [aria-busy="false"]')).not.toBeNull());
      expect(menu(view)).toEqual(["Telescope"]);
      expect(headers(main(view))).toEqual(["Callsign", "Aperture Mm", "Mount"]);

      fireEvent.click(view.getByText("New Telescope"));
      const side = await waitFor(() => view.getByRole("complementary"));
      fireEvent.change(within(side).getByLabelText("Callsign *"), { target: { value: "Vega-1" } });
      fireEvent.change(within(side).getByLabelText("Aperture Mm"), { target: { value: "300" } });
      fireEvent.change(within(side).getByLabelText("Mount"), { target: { value: "dobsonian" } });
      fireEvent.click(within(side).getByText("Create"));
      await waitFor(() => expect(tableRows(main(view))).toEqual([["Vega-1", "300", "Dobsonian"]]));

      const listed = await app.inject({ method: "GET", url: `${API_PREFIX}/telescopes` });
      expect(listed.statusCode).toBe(200);
      const body = JSON.parse(listed.body) as { rows?: unknown[] } | unknown[];
      const rows = Array.isArray(body) ? body : body.rows;
      expect(rows).toEqual([expect.objectContaining({ callsign: "Vega-1", apertureMm: 300, mount: "dobsonian" })]);
    } finally {
      cleanup();
      await app.close();
      await runtime.close();
      fresh.remove();
    }
  });
});
