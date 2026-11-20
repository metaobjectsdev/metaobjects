/**
 * The filter and sort allowlists come from the metadata, at request time.
 *
 * Each expectation here is stated twice on purpose: once as a literal (so a reader can see
 * the contract), and once derived from the loaded model (so the test proves the route is
 * reading the model and not a list somebody typed).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIELD_ATTR_FILTERABLE } from "@metaobjectsdev/metadata";
import { copyProject, openDemo, type Demo, type ProjectCopy } from "./helpers";

let demo: Demo;
beforeAll(async () => {
  demo = await openDemo();
});
afterAll(async () => {
  await demo.close();
});

describe("filter allowlist", () => {
  test("only fields the model marks @filterable can be filtered on", async () => {
    const res = await demo.get("/api/work_orders?filter[notes]=gasket");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "invalid_filter_field",
      field: "notes",
      allowed: ["title", "status", "priority", "customerId", "technicianId", "estimatedHours", "dueOn"],
    });
  });

  test("the allowed list is exactly the model's @filterable fields, for every entity", async () => {
    const model = demo.runtime.current();
    expect(model.served.size).toBe(5);
    for (const [collection, entity] of model.served) {
      const declared = entity.fields().filter((f) => f.attr(FIELD_ATTR_FILTERABLE) === true).map((f) => f.name);
      const res = await demo.get(`/api/${collection}?filter[__no_such_field__]=1`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_filter_field", allowed: declared });
    }
  });

  test("a primary key the model did not mark @filterable is not filterable either", async () => {
    const res = await demo.get("/api/customers?filter[id]=1");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_filter_field", field: "id" });
  });

  test("the operators offered depend on the field's subtype", async () => {
    // A string takes `like`; a number does not.
    expect((await demo.get("/api/parts?filter[sku][like]=B%25")).status).toBe(200);
    expect((await demo.get("/api/parts?filter[stockQty][like]=1%25")).body).toEqual({
      error: "invalid_filter_op",
      field: "stockQty",
      op: "like",
      allowed: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
    });
    // A boolean has no ordering.
    expect((await demo.get("/api/parts?filter[discontinued][gt]=true")).body).toEqual({
      error: "invalid_filter_op",
      field: "discontinued",
      op: "gt",
      allowed: ["eq", "isNull"],
    });
    // An enum has no ordering either, but takes `in`.
    expect((await demo.get("/api/work_orders?filter[status][gte]=open")).body).toMatchObject({
      error: "invalid_filter_op",
      allowed: ["eq", "ne", "in", "like", "isNull"],
    });
  });

  test("a value is read as the field's own type, or refused", async () => {
    const bad = async (query: string) => {
      const res = await demo.get(`/api/${query}`);
      expect(res.status).toBe(400);
      return res.body;
    };
    expect(await bad("work_orders?filter[customerId]=abc")).toMatchObject({ error: "invalid_filter_value", field: "customerId", op: "eq" });
    expect(await bad("work_orders?filter[customerId]=1.5")).toMatchObject({ error: "invalid_filter_value" });
    expect(await bad("work_orders?filter[dueOn][gte]=2026-02-31")).toMatchObject({ error: "invalid_filter_value", field: "dueOn", op: "gte" });
    expect(await bad("technicians?filter[hourlyRate][gte]=1e3")).toMatchObject({ error: "invalid_filter_value", field: "hourlyRate" });
    expect(await bad("customers?filter[active]=yes")).toMatchObject({ error: "invalid_filter_value", field: "active" });
    // An enum value must be a member the model declares.
    expect(await bad("work_orders?filter[status]=finished")).toEqual({
      error: "invalid_filter_value",
      field: "status",
      op: "eq",
      expected: "one of open, in_progress, blocked, done",
      allowed: ["open", "in_progress", "blocked", "done"],
    });
    expect(await bad("work_orders?filter[status][in]=open,finished")).toMatchObject({ error: "invalid_filter_value", field: "status", op: "in" });
  });

  test("a leading wildcard is refused", async () => {
    const res = await demo.get("/api/parts?filter[name][like]=%25pump");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "filter.leading_wildcard_disallowed", field: "name" });
  });

  test("an in-list longer than the ceiling is refused", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(",");
    const res = await demo.get(`/api/work_orders?filter[customerId][in]=${ids}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "filter.in_too_large", field: "customerId", limit: 100 });
  });

  test("allowed filters select the rows they describe", async () => {
    const names = async (query: string): Promise<unknown[]> => {
      const res = await demo.get(`/api/${query}`);
      expect(res.status).toBe(200);
      return (res.body as Record<string, unknown>[]).map((row) => row["name"] ?? row["title"]);
    };
    expect(await names("customers?filter[active]=false")).toEqual(["Old Mill Cafe"]);
    expect(await names("customers?filter[tier][in]=gold,platinum&sort=name")).toEqual(["Harbor Bakery", "Northgate Print"]);
    expect(await names("technicians?filter[hourlyRate][gte]=60&sort=hourlyRate:desc")).toEqual(["Ada Okafor", "Ben Ruiz"]);
    expect(await names("technicians?filter[hiredOn][lt]=2020-01-01")).toEqual(["Ada Okafor"]);
    expect(await names("parts?filter[unitPriceCents][gte]=7400&sort=unitPriceCents")).toEqual(["Head gasket, series 7", "Water pump, 110 V"]);
    expect(await names("work_orders?filter[technicianId][isNull]=true&filter[priority]=urgent")).toEqual(["Water pump failure"]);
    // A range on one field: both bounds apply.
    expect(await names("work_orders?filter[dueOn][gte]=2026-12-01&filter[dueOn][lte]=2026-12-10&sort=dueOn")).toEqual([
      "Proofing cabinet thermostat",
      "Quarterly mixer service",
    ]);
  });
});

describe("sort allowlist", () => {
  test("a field that is not sortable is refused, and the answer lists what is", async () => {
    const res = await demo.get("/api/work_orders?sort=notes:asc");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "invalid_sort",
      field: "notes",
      expected: "sort=<field>:asc|desc",
      allowed: ["title", "status", "priority", "customerId", "technicianId", "estimatedHours", "dueOn"],
    });
  });

  test("an order that is not asc or desc is refused", async () => {
    const res = await demo.get("/api/work_orders?sort=dueOn:sideways");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_sort", field: "dueOn" });
  });

  test("an allowed sort orders the rows", async () => {
    const due = async (sort: string): Promise<unknown[]> =>
      ((await demo.get(`/api/work_orders?sort=${sort}&limit=3`)).body as Record<string, unknown>[]).map((row) => row["dueOn"]);
    expect(await due("dueOn:asc")).toEqual(["2026-10-29", "2026-11-03", "2026-11-10"]);
    expect(await due("dueOn:desc")).toEqual(["2027-01-15", "2026-12-19", "2026-12-12"]);
    expect(await due("dueOn")).toEqual(["2026-10-29", "2026-11-03", "2026-11-10"]);
  });
});

describe("@sortable in the metadata", () => {
  let project: ProjectCopy;
  let edited: Demo;
  beforeAll(async () => {
    project = copyProject();
    // Three edits to the metadata and nothing else: no code is generated for any of them.
    project.editModel("- field.date: { name: dueOn, filterable: true }", "- field.date: { name: dueOn, filterable: true, sortableDefaultOrder: desc }");
    project.editModel("- field.string: { name: title, required: true, maxLength: 160, filterable: true }", "- field.string: { name: title, required: true, maxLength: 160, filterable: true, sortable: false }");
    project.editModel("name: notes\n              maxLength: 2000", "name: notes\n              maxLength: 2000\n              sortable: true");
    edited = await openDemo({ projectDir: project.dir });
  });
  afterAll(async () => {
    await edited.close();
    project.remove();
  });

  test("@sortable: false takes a filterable field off the sort list; @sortable: true puts a plain one on", async () => {
    const res = await edited.get("/api/work_orders?sort=title");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "invalid_sort",
      field: "title",
      allowed: ["status", "priority", "customerId", "technicianId", "estimatedHours", "dueOn", "notes"],
    });
    expect((await edited.get("/api/work_orders?sort=notes")).status).toBe(200);
    // It is still filterable: the two lists are separate.
    expect((await edited.get("/api/work_orders?filter[title][like]=Water%25")).status).toBe(200);
  });

  test("@sortableDefaultOrder is the order when the caller gives none", async () => {
    const rows = (await edited.get("/api/work_orders?sort=dueOn&limit=2")).body as Record<string, unknown>[];
    expect(rows.map((row) => row["dueOn"])).toEqual(["2027-01-15", "2026-12-19"]);
  });
});
