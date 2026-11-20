/**
 * One form component for every entity: `<MetaForm entity="..." />`, and with `id` an edit.
 *
 * Each test opens its own database, so a write in one is never what another reads.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within, type RenderResult } from "@testing-library/react";
import type { Row } from "../src/client/api";
import { MetaForm, type MetaFormProps } from "../src/client/meta-form";
import { MetaGrid } from "../src/client/meta-grid";
import { clientModel, inProcess, mount, type Transport } from "./client-helpers";
import { copyProject, openDemo, type Demo } from "./helpers";

let demo: Demo;
let transport: Transport;
beforeEach(async () => {
  demo = await openDemo();
  transport = inProcess(demo.app);
});
afterEach(async () => {
  cleanup();
  await demo.close();
});

/** Render the form and wait until its controls are on the page. */
async function form(props: MetaFormProps, on: Transport = transport): Promise<RenderResult> {
  const view = await mount(on, <MetaForm {...props} />);
  await waitFor(() => expect(view.container.querySelector(".mo-actions")).not.toBeNull());
  return view;
}

/** What a person sees for one field: its label and the kind of control under it. */
function controls(root: HTMLElement): [string, string][] {
  const kindOf = (el: Element | null): string => {
    if (el === null) return "nothing";
    if (el.tagName === "SELECT" || el.tagName === "TEXTAREA") return el.tagName.toLowerCase();
    if (el.tagName !== "INPUT") return el.textContent ?? "";
    const type = el.getAttribute("type") ?? "text";
    return type === "text" && el.getAttribute("inputmode") !== null ? `text/${el.getAttribute("inputmode")}` : type;
  };
  const listed: [string, string][] = [];
  for (const node of root.querySelectorAll("label, legend")) {
    if (node.tagName === "LEGEND") listed.push([node.textContent ?? "", "group"]);
    else listed.push([node.textContent ?? "", kindOf(root.ownerDocument.getElementById(node.getAttribute("for") ?? ""))]);
  }
  return listed;
}

const optionValues = (select: HTMLElement): string[] => [...select.querySelectorAll("option")].map((o) => o.getAttribute("value") ?? "");
const optionLabels = (select: HTMLElement): string[] => [...select.querySelectorAll("option")].map((o) => o.textContent ?? "");
const type = (view: RenderResult, label: string, value: string): void => {
  fireEvent.change(view.getByLabelText(label), { target: { value } });
};
/** The requests that wrote something. */
const writes = (on: Transport = transport) => on.calls.filter((call) => call.method !== "GET");
/** The message shown beside a field. */
const issueFor = (view: RenderResult, label: string): string | undefined =>
  view.getByLabelText(label).closest(".mo-field")?.querySelector('[role="alert"]')?.textContent ?? undefined;

describe("controls are chosen from each field's metadata", () => {
  test("a work order: enums and foreign keys are selects, a decimal is text, long text a textarea", async () => {
    const view = await form({ entity: "WorkOrder" });
    expect(controls(view.container)).toEqual([
      ["Title *", "text"],
      ["Status *", "select"],
      ["Priority *", "select"],
      ["Customer Id *", "select"],
      ["Technician Id", "select"],
      ["Estimated Hours", "text/decimal"],
      ["Due On", "date"],
      ["Notes", "textarea"],
    ]);
  });

  test("a customer: a value object is a group of its own members", async () => {
    const view = await form({ entity: "Customer" });
    expect(controls(view.container)).toEqual([
      ["Name *", "text"],
      ["Email", "text"],
      ["Tier *", "select"],
      ["Active *", "checkbox"],
      ["Billing Address", "group"],
      ["Street *", "text"],
      ["City *", "text"],
      ["Postal Code", "text"],
    ]);
  });

  test("a part: money is a currency box, an integer a number box", async () => {
    const view = await form({ entity: "Part" });
    expect(controls(view.container)).toEqual([
      ["Sku *", "text"],
      ["Name *", "text"],
      ["Unit Price Cents *", "text/decimal"],
      ["Stock Qty *", "number"],
      ["Discontinued *", "checkbox"],
    ]);
  });

  test("the generated key is not a control", async () => {
    const view = await form({ entity: "Technician" });
    expect(controls(view.container).map(([label]) => label)).toEqual(["Name *", "Level *", "Hourly Rate *", "Hired On"]);
  });

  test("an enum offers its members, starting on the model's @default", async () => {
    const view = await form({ entity: "WorkOrder" });
    const status = view.getByLabelText("Status *") as HTMLSelectElement;
    expect(optionValues(status)).toEqual(["", "open", "in_progress", "blocked", "done"]);
    expect(optionLabels(status).slice(1)).toEqual(["Open", "In progress", "Blocked", "Done"]);
    expect(status.value).toBe("open");
    expect((view.getByLabelText("Priority *") as HTMLSelectElement).value).toBe("normal");
  });

  test("a foreign key offers the rows it may point at, by their title", async () => {
    const view = await form({ entity: "WorkOrder" });
    const customer = view.getByLabelText("Customer Id *");
    await waitFor(() => expect(optionLabels(customer)).toEqual(["—", "Harbor Bakery", "Lakeside Cycles", "Northgate Print", "Old Mill Cafe"]));
    expect(optionValues(customer)).toEqual(["", "1", "2", "3", "4"]);
  });

  test("length limits, numeric bounds and textarea rows are the model's", async () => {
    const order = await form({ entity: "WorkOrder" });
    expect(order.getByLabelText("Title *").getAttribute("maxlength")).toBe("160");
    expect(order.getByLabelText("Notes").getAttribute("rows")).toBe("4");
    cleanup();
    const part = await form({ entity: "Part" });
    expect(part.getByLabelText("Stock Qty *").getAttribute("min")).toBe("0");
    expect(part.getByLabelText("Sku *").getAttribute("maxlength")).toBe("40");
  });

  test("a subtype this form has no control for is said, and left out of what is sent", async () => {
    const project = copyProject();
    project.editModel(
      "- field.date: { name: hiredOn, filterable: true }",
      "- field.date: { name: hiredOn, filterable: true }\n          - field.timestamp: { name: badgeIssuedAt }",
    );
    const other = await openDemo({ projectDir: project.dir });
    try {
      const on = inProcess(other.app);
      const view = await form({ entity: "Technician" }, on);
      expect(controls(view.container).at(-1)).toEqual(["Badge Issued At", "This form has no control for field.timestamp."]);
      type(view, "Name *", "Dee Marsh");
      type(view, "Level *", "master");
      type(view, "Hourly Rate *", "80");
      fireEvent.click(view.getByText("Create"));
      await waitFor(() => expect(writes(on)).toHaveLength(1));
      expect(writes(on)[0]?.body).toEqual({ name: "Dee Marsh", level: "master", hourlyRate: "80" });
    } finally {
      cleanup();
      await other.close();
      project.remove();
    }
  });
});

describe("fields the form does not offer", () => {
  test("a credential and a @formExclude field have no control, because no request may set them", async () => {
    const project = copyProject();
    project.editModel(
      "- field.date: { name: hiredOn, filterable: true }",
      [
        "- field.date: { name: hiredOn, filterable: true }",
        "          - field.string:",
        "              name: portalSecret",
        "              filterable: true",
        "              children:",
        "                - view.password: { name: masked }",
        "          - field.string: { name: payrollCode, maxLength: 20, formExclude: true }",
      ].join("\n"),
    );
    const other = await openDemo({ projectDir: project.dir });
    try {
      const view = await form({ entity: "Technician" }, inProcess(other.app));
      expect(controls(view.container).map(([label]) => label)).toEqual(["Name *", "Level *", "Hourly Rate *", "Hired On"]);
      // Nor is the credential offered to filter or sort on, though the model marks it @filterable.
      const secret = (await clientModel(inProcess(other.app))).entity("Technician")?.field("portalSecret");
      expect(secret).toMatchObject({ filterOps: [], sortable: false, writable: false });
    } finally {
      cleanup();
      await other.close();
      project.remove();
    }
  });
});

describe("a field that holds a list", () => {
  test("the form says it has no control for it, and the grid shows its members", async () => {
    const project = copyProject();
    project.editModel(
      "- field.date: { name: hiredOn, filterable: true }",
      ["- field.date: { name: hiredOn, filterable: true }", "          - field.string: { name: certifications, isArray: true }"].join("\n"),
    );
    project.editModel("columns: [name, level, hourlyRate, hiredOn]", "columns: [name, level, hourlyRate, hiredOn, certifications]");
    const other = await openDemo({ projectDir: project.dir });
    try {
      const row = await other.runtime.current().om.create("Technician", {
        name: "Gus Ferro", level: "master", hourlyRate: "88.00", certifications: ["hydraulics", "welding"],
      });
      const transport = inProcess(other.app);
      const view = await form({ entity: "Technician", id: String(row["id"]) }, transport);
      expect(controls(view.container)).toContainEqual(["Certifications", "This form has no control for field.string."]);
      // Saving leaves the list alone: the form sends nothing for a field it cannot edit.
      type(view, "Name *", "Gus Ferro Sr");
      fireEvent.click(view.getByText("Save"));
      await waitFor(() => expect(writes(transport)).toHaveLength(1));
      expect(writes(transport)[0]?.body).toEqual({ name: "Gus Ferro Sr" });
      cleanup();
      const grid = await mount(transport, <MetaGrid entity="Technician" />);
      await waitFor(() => expect(grid.container.textContent).toContain("hydraulics, welding"));
      const stored = await other.runtime.current().om.findById("Technician", row["id"]);
      expect(stored).toMatchObject({ certifications: ["hydraulics", "welding"] });
    } finally {
      cleanup();
      await other.close();
      project.remove();
    }
  });
});

describe("creating", () => {
  test("a customer with an address: the value object is sent nested, defaults as shown", async () => {
    const saved: Row[] = [];
    const view = await form({ entity: "Customer", onSaved: (row) => saved.push(row) });
    type(view, "Name *", "Quarry Stoneworks");
    type(view, "Email", "desk@quarry.example");
    type(view, "Tier *", "gold");
    type(view, "Street *", "1 Pit Road");
    type(view, "City *", "Granton");
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(saved).toHaveLength(1));

    expect(writes()).toEqual([
      {
        method: "POST",
        path: "/api/customers",
        // Postal code was left empty, so it is not sent at all.
        body: { name: "Quarry Stoneworks", email: "desk@quarry.example", tier: "gold", active: true, billingAddress: { street: "1 Pit Road", city: "Granton" } },
      },
    ]);
    const stored = (await demo.get(`/api/customers/${String(saved[0]?.["id"])}`)).body;
    expect(stored).toMatchObject({ name: "Quarry Stoneworks", tier: "gold", billingAddress: { street: "1 Pit Road", city: "Granton" } });
  });

  test("an address left wholly empty is no address", async () => {
    const view = await form({ entity: "Customer" });
    type(view, "Name *", "No Fixed Abode Ltd");
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ name: "No Fixed Abode Ltd", tier: "standard", active: true });
  });

  test("a decimal is sent as the digits typed, never as a number", async () => {
    const view = await form({ entity: "Technician" });
    type(view, "Name *", "Dee Marsh");
    type(view, "Level *", "journeyman");
    type(view, "Hourly Rate *", "71.10");
    type(view, "Hired On", "2026-02-02");
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ name: "Dee Marsh", level: "journeyman", hourlyRate: "71.10", hiredOn: "2026-02-02" });
  });

  test("a foreign key is sent as the key's own type", async () => {
    const view = await form({ entity: "WorkOrder" });
    type(view, "Title *", "Replace drive belt");
    await waitFor(() => expect(optionValues(view.getByLabelText("Customer Id *"))).toContain("3"));
    type(view, "Customer Id *", "3");
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ title: "Replace drive belt", status: "open", priority: "normal", customerId: 3 });
  });

  test("money is held in minor units", async () => {
    const view = await form({ entity: "Part" });
    type(view, "Sku *", "SEAL-22");
    type(view, "Name *", "Shaft seal, 22 mm");
    const price = view.getByLabelText("Unit Price Cents *");
    fireEvent.focus(price);
    fireEvent.change(price, { target: { value: "12.34" } });
    fireEvent.blur(price);
    type(view, "Stock Qty *", "15");
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ sku: "SEAL-22", name: "Shaft seal, 22 mm", unitPriceCents: 1234, stockQty: 15, discontinued: false });
  });

  test("`initial` starts a new row on given values (a line for one work order)", async () => {
    const view = await form({ entity: "WorkOrderLine", initial: { workOrderId: 2 } });
    const order = view.getByLabelText("Work Order Id *") as HTMLSelectElement;
    await waitFor(() => expect(order.selectedOptions[0]?.textContent).toBe("Quarterly mixer service"));
  });
});

describe("what stops a write", () => {
  test("an empty required field is said before anything is sent", async () => {
    const view = await form({ entity: "WorkOrder" });
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(issueFor(view, "Title *")).toBe("Title is required."));
    expect(issueFor(view, "Customer Id *")).toBe("Customer Id is required.");
    expect(issueFor(view, "Notes")).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  test("text in a decimal box is said before anything is sent", async () => {
    const view = await form({ entity: "Technician" });
    type(view, "Name *", "Dee Marsh");
    type(view, "Level *", "master");
    type(view, "Hourly Rate *", "about 70");
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(issueFor(view, "Hourly Rate *")).toBe("Enter a decimal number, like 12.50."));
    expect(writes()).toEqual([]);
  });

  test("the model's validators run on the server, and their message lands beside the field", async () => {
    const view = await form({ entity: "Customer" });
    type(view, "Name *", "Quarry Stoneworks");
    type(view, "Email", "not an address");
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(issueFor(view, "Email")).toBeDefined());
    expect(view.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
    expect((await demo.get("/api/customers?withCount=1")).body).toMatchObject({ total: 4 });
  });

  test("a value-object member's issue lands beside that member", async () => {
    const view = await form({ entity: "Customer" });
    type(view, "Name *", "Quarry Stoneworks");
    type(view, "City *", "Granton");
    fireEvent.click(view.getByText("Create"));
    // Street is required once the address has anything in it.
    await waitFor(() => expect(issueFor(view, "Street *")).toBe("Street is required."));
    expect(writes()).toEqual([]);
  });

  test("a hand-written business rule is shown the same way", async () => {
    // Work order 2 is open and has no technician.
    const view = await form({ entity: "WorkOrder", id: 2 });
    type(view, "Status *", "done");
    fireEvent.click(view.getByText("Save"));
    await waitFor(() => expect(issueFor(view, "Technician Id")).toBe("Assign a technician before marking the work order done."));
    expect((await demo.get("/api/work_orders/2")).body).toMatchObject({ status: "open" });

    type(view, "Technician Id", "1");
    fireEvent.click(view.getByText("Save"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    await waitFor(async () => expect((await demo.get("/api/work_orders/2")).body).toMatchObject({ status: "done", technicianId: 1 }));
  });

  test("a rule that reads another entity: a line cannot take more than the stock", async () => {
    const view = await form({ entity: "WorkOrderLine", initial: { workOrderId: 2 } });
    await waitFor(() => expect(optionLabels(view.getByLabelText("Part Id *"))).toContain("PMP-W-110"));
    type(view, "Part Id *", "5");
    type(view, "Quantity *", "9");
    fireEvent.click(view.getByText("Create"));
    await waitFor(() => expect(issueFor(view, "Quantity *")).toBe("Only 3 of PMP-W-110 in stock."));
  });
});

describe("editing", () => {
  test("the form opens on the stored row", async () => {
    const view = await form({ entity: "Customer", id: 1 });
    expect((view.getByLabelText("Name *") as HTMLInputElement).value).toBe("Harbor Bakery");
    expect((view.getByLabelText("Tier *") as HTMLSelectElement).value).toBe("gold");
    expect((view.getByLabelText("Active *") as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText("City *") as HTMLInputElement).value).toBe("Portside");
    expect(within(view.container).getByText("Edit Customer")).toBeDefined();
  });

  test("only what changed is sent", async () => {
    const view = await form({ entity: "WorkOrder", id: 1 });
    type(view, "Priority *", "low");
    fireEvent.click(view.getByText("Save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "PATCH", path: "/api/work_orders/1", body: { priority: "low" } });
  });

  test("an emptied field is sent as null", async () => {
    // Work order 4 has notes.
    const view = await form({ entity: "WorkOrder", id: 4 });
    type(view, "Notes", "");
    fireEvent.click(view.getByText("Save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ notes: null });
    expect((await demo.get("/api/work_orders/4")).body).toMatchObject({ notes: null });
  });

  test("saving with nothing changed changes nothing", async () => {
    const before = (await demo.get("/api/technicians/1")).body;
    const view = await form({ entity: "Technician", id: 1 });
    fireEvent.click(view.getByText("Save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({});
    expect((await demo.get("/api/technicians/1")).body).toEqual(before);
  });

  test("Delete removes the row", async () => {
    let deleted = 0;
    // Line 6 belongs to nothing else.
    const view = await form({ entity: "WorkOrderLine", id: 6, onDeleted: () => deleted++ });
    fireEvent.click(view.getByText("Delete"));
    await waitFor(() => expect(deleted).toBe(1));
    expect((await demo.get("/api/work_order_lines/6")).status).toBe(404);
  });

  test("a row that is not there is said", async () => {
    const view = await mount(transport, <MetaForm entity="Customer" id={999} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("not_found"));
  });
});
