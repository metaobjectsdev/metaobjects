/**
 * One grid component for every entity: `<MetaGrid entity="..." />`, and nothing else.
 *
 * As in the server tests, expectations are stated as literals a reader can check against
 * the metadata file, and derived from the loaded model where that proves the component is
 * reading the model and not a list somebody typed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { EntityFetcher } from "@metaobjectsdev/runtime-web";
import { EntityFetcherProvider } from "@metaobjectsdev/tanstack";
import { FIELD_ATTR_FILTERABLE, LAYOUT_DATA_GRID_ATTR_COLUMNS, opsForField } from "@metaobjectsdev/metadata";
import { ModelProvider } from "../src/client/context";
import { MetaGrid } from "../src/client/meta-grid";
import { API_PREFIX } from "../src/server/app";
import { clientModel, header, headers, inProcess, mount, tableRows, type Transport } from "./client-helpers";
import { copyProject, openDemo, type Demo, type ProjectCopy } from "./helpers";

let demo: Demo;
let transport: Transport;
beforeAll(async () => {
  demo = await openDemo();
  transport = inProcess(demo.app);
});
afterEach(() => {
  cleanup();
  transport.calls.length = 0;
});
afterAll(async () => {
  await demo.close();
});

/** Render the grid and wait for its first page. */
async function grid(entity: string, props: { where?: Record<string, string | number> } = {}, on: Transport = transport) {
  const view = await mount(on, <MetaGrid entity={entity} {...props} />);
  await waitFor(() => expect(view.container.querySelector('[aria-busy="false"]')).not.toBeNull());
  return view;
}

const options = (select: HTMLElement): string[] => [...select.querySelectorAll("option")].map((o) => o.getAttribute("value") ?? "");

describe("columns", () => {
  test("come from the entity's layout.dataGrid, for every entity the server serves", async () => {
    for (const [, entity] of demo.runtime.current().served) {
      const declared = entity.layouts()[0]?.attr(LAYOUT_DATA_GRID_ATTR_COLUMNS) as string[];
      const view = await grid(entity.name);
      expect(headers(view.container)).toEqual(declared.map((name) => view.model.entity(entity.name)?.field(name)?.label ?? ""));
      cleanup();
    }
  });

  test("the work order grid, spelled out", async () => {
    const view = await grid("WorkOrder");
    expect(headers(view.container)).toEqual(["Title", "Status", "Priority", "Customer Id", "Technician Id", "Estimated Hours", "Due On"]);
  });

  test("an entity the model does not serve is an error, not an empty grid", async () => {
    await expect(mount(transport, <MetaGrid entity="Invoice" />)).rejects.toThrow(/serves no entity "Invoice"/);
  });
});

describe("cells are drawn from each field's metadata", () => {
  test("a decimal keeps its scale, an enum reads as a label", async () => {
    const view = await grid("Technician");
    // hourlyRate is stored 92.5; @scale: 2 shows 92.50. No number formatting, no double.
    expect(tableRows(view.container)[0]).toEqual(["Ada Okafor", "Master", "92.50", "2015-03-02"]);
  });

  test("money uses the field's currency and its view's locale, a boolean reads Yes or No", async () => {
    const view = await grid("Part");
    expect(tableRows(view.container)[0]).toEqual(["BLT-M8-40", "M8 x 40 bolt", "$0.45", "1200", "No"]);
  });

  test("a foreign key shows the row it points at (identity.reference)", async () => {
    const view = await grid("WorkOrderLine");
    await waitFor(() =>
      expect(tableRows(view.container)[0]).toEqual(["Replace oven conveyor bearing", "BRG-6204", "2"]),
    );
  });
});

describe("sorting and paging", () => {
  test("the first page is sorted and sized by the layout", async () => {
    const view = await grid("WorkOrder");
    const rows = tableRows(view.container);
    // @pageSize: 10, @defaultSortField: dueOn, @defaultSortOrder: desc. Twelve work orders are seeded.
    expect(rows).toHaveLength(10);
    expect(rows[0]?.[0]).toBe("Annual safety inspection");
    expect(rows[0]?.[6]).toBe("2027-01-15");
    expect(view.getByText("Page 1 of 2")).toBeDefined();
    expect(view.getByText("12 rows")).toBeDefined();
    expect(transport.calls.at(0)?.path).toContain("sort=dueOn%3Adesc");
  });

  test("Next asks the server for the second page", async () => {
    const view = await grid("WorkOrder");
    fireEvent.click(view.getByText("Next"));
    await waitFor(() => expect(tableRows(view.container)).toHaveLength(2));
    expect(transport.calls.at(-1)?.path).toContain("offset=10");
  });

  test("clicking a header sorts by that field, on the server", async () => {
    const view = await grid("Technician");
    fireEvent.click(header(view.container, "Hourly Rate"));
    await waitFor(() => expect(tableRows(view.container).map((r) => r[0])).toEqual(["Cleo Lindqvist", "Ben Ruiz", "Ada Okafor"]));
    expect(transport.calls.at(-1)?.path).toContain("sort=hourlyRate%3Aasc");
  });

  test("a column whose field is not sortable does not sort", async () => {
    // `notes` is neither @filterable nor @sortable. Put it in the grid and click it.
    const project = copyProject();
    project.editModel("columns: [title, status, priority, customerId, technicianId, estimatedHours, dueOn]", "columns: [title, notes]");
    const other = await openDemo({ projectDir: project.dir });
    try {
      const on = inProcess(other.app);
      const view = await grid("WorkOrder", {}, on);
      expect(headers(view.container)).toEqual(["Title", "Notes"]);
      const before = on.calls.length;
      fireEvent.click(header(view.container, "Notes"));
      fireEvent.click(header(view.container, "Title"));
      await waitFor(() => expect(on.calls.at(-1)?.path).toContain("sort=title%3Aasc"));
      // One request, for Title. The click on Notes asked for nothing.
      expect(on.calls.length).toBe(before + 1);
    } finally {
      cleanup();
      await other.close();
      project.remove();
    }
  });

  test("the page is never larger than api.pagination allows", async () => {
    const project = copyProject();
    project.editConfig((config) => {
      config["api"] = { pagination: { defaultLimit: 3, maxLimit: 4 } };
    });
    const other = await openDemo({ projectDir: project.dir });
    try {
      const on = inProcess(other.app);
      const view = await grid("WorkOrder", {}, on);
      // The layout asks for 10 a page; the project serves at most 4.
      expect(tableRows(view.container)).toHaveLength(4);
      expect(view.getByText("Page 1 of 3")).toBeDefined();
    } finally {
      cleanup();
      await other.close();
      project.remove();
    }
  });
});

describe("filters", () => {
  test("the fields offered are exactly the @filterable ones, with the operators of their subtype", async () => {
    for (const [, entity] of demo.runtime.current().served) {
      const view = await grid(entity.name);
      const filterable = entity.fields().filter((f) => f.attr(FIELD_ATTR_FILTERABLE) === true);
      const fieldSelect = view.getByLabelText("Filter field");
      expect(options(fieldSelect)).toEqual(filterable.map((f) => f.name));
      for (const field of filterable) {
        fireEvent.change(fieldSelect, { target: { value: field.name } });
        expect(options(view.getByLabelText("Filter operator"))).toEqual([...opsForField(field)]);
      }
      cleanup();
    }
  });

  test("an enum is filtered by choosing a member", async () => {
    const view = await grid("WorkOrder");
    fireEvent.change(view.getByLabelText("Filter field"), { target: { value: "status" } });
    const value = view.getByLabelText("Filter value");
    expect(value.tagName).toBe("SELECT");
    expect(options(value)).toEqual(["", "open", "in_progress", "blocked", "done"]);
    fireEvent.change(value, { target: { value: "done" } });
    fireEvent.click(view.getByText("Add filter"));
    await waitFor(() => expect(tableRows(view.container)).toHaveLength(3));
    expect(tableRows(view.container).every((row) => row[1] === "Done")).toBe(true);
    expect(transport.calls.at(-1)?.path).toContain("filter%5Bstatus%5D%5Beq%5D=done");

    // Removing the filter brings the full list back.
    fireEvent.click(view.getByLabelText("Remove filter status eq"));
    await waitFor(() => expect(view.getByText("12 rows")).toBeDefined());
  });

  test("a foreign key is filtered by choosing the row it points at", async () => {
    const view = await grid("WorkOrder");
    fireEvent.change(view.getByLabelText("Filter field"), { target: { value: "customerId" } });
    const value = view.getByLabelText("Filter value");
    await waitFor(() => expect(within(value).getByText("Lakeside Cycles")).toBeDefined());
    fireEvent.change(value, { target: { value: "2" } });
    fireEvent.click(view.getByText("Add filter"));
    await waitFor(() => expect(view.getByText("3 rows")).toBeDefined());
  });

  test("two operators on one field make a range", async () => {
    const view = await grid("Technician");
    const add = (op: string, typed: string): void => {
      fireEvent.change(view.getByLabelText("Filter field"), { target: { value: "hourlyRate" } });
      fireEvent.change(view.getByLabelText("Filter operator"), { target: { value: op } });
      fireEvent.change(view.getByLabelText("Filter value"), { target: { value: typed } });
      fireEvent.click(view.getByText("Add filter"));
    };
    add("gte", "50");
    add("lt", "92.5");
    await waitFor(() => expect(tableRows(view.container).map((r) => r[0])).toEqual(["Ben Ruiz"]));
  });

  test("a value the server refuses is shown, with what it allows", async () => {
    const view = await grid("Part");
    fireEvent.change(view.getByLabelText("Filter field"), { target: { value: "sku" } });
    fireEvent.change(view.getByLabelText("Filter operator"), { target: { value: "like" } });
    fireEvent.change(view.getByLabelText("Filter value"), { target: { value: "%M8" } });
    fireEvent.click(view.getByText("Add filter"));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("filter.leading_wildcard_disallowed"));
  });

  test("`where` lists only the related rows", async () => {
    const view = await grid("WorkOrderLine", { where: { workOrderId: 1 } });
    expect(tableRows(view.container)).toHaveLength(2);
    // The grid's own request (the filter bar also asks for the work orders a line may point at).
    const list = transport.calls.find((call) => call.path.startsWith("/api/work_order_lines?"));
    expect(list?.path).toContain("filter%5BworkOrderId%5D%5Beq%5D=1");
  });

  test("a field `where` fixes is not offered as a filter, so the list cannot be pointed at another owner", async () => {
    const view = await grid("WorkOrderLine", { where: { workOrderId: 1 } });
    expect(options(view.getByLabelText("Filter field"))).toEqual(["partId", "quantity"]);
  });
});

describe("the row a foreign key points at", () => {
  test("a title asked for before the page was fetched again still arrives", async () => {
    // Hold every lookup of a referenced row until the test lets it go.
    const held: (() => void)[] = [];
    const fetcher: EntityFetcher = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path.startsWith("/api/customers/") || path.startsWith("/api/technicians/")) await new Promise<void>((go) => held.push(go));
      return transport.fetcher<T>(path, init);
    };
    const model = await clientModel(transport);
    transport.calls.length = 0;
    const page = (refresh: number) => (
      <EntityFetcherProvider fetcher={fetcher} baseUrl={API_PREFIX}>
        <ModelProvider model={model}>
          <MetaGrid entity="WorkOrder" refresh={refresh} />
        </ModelProvider>
      </EntityFetcherProvider>
    );
    const lists = (): number => transport.calls.filter((call) => call.path.startsWith("/api/work_orders?")).length;
    const view = render(page(0));
    await waitFor(() => expect(held.length).toBeGreaterThan(0));
    // A row was saved elsewhere, so the page is fetched again while the lookups are out.
    view.rerender(page(1));
    await waitFor(() => expect(lists()).toBe(2));
    await waitFor(() => expect(view.container.querySelector('[aria-busy="false"]')).not.toBeNull());
    for (const go of held.splice(0)) go();
    await waitFor(() => expect(tableRows(view.container).flat()).toContain("Harbor Bakery"));
  });
});
