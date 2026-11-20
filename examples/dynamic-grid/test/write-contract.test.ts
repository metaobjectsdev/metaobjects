/**
 * The write half of the contract: the unknown-field 400, validation from the metadata,
 * constraint failures that do not leak, and the hand-written business rules.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyProject, openDemo, type Demo, type ProjectCopy } from "./helpers";

let demo: Demo;
beforeAll(async () => {
  demo = await openDemo();
});
afterAll(async () => {
  await demo.close();
});

describe("unknown fields", () => {
  test("a key the entity does not declare is a 400 naming the keys, sorted", async () => {
    const res = await demo.send("POST", "/api/customers", { name: "Acme", zeta: 1, alpha: 2 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "unknown_fields", fields: ["alpha", "zeta"] });
  });

  test("it is answered before validation, so the caller hears about the typo first", async () => {
    // `name` is missing (a validation failure) AND `nmae` is unknown: unknown_fields wins.
    const res = await demo.send("POST", "/api/customers", { nmae: "Acme" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "unknown_fields", fields: ["nmae"] });
  });

  test("a database-generated primary key is not a settable field", async () => {
    const res = await demo.send("POST", "/api/customers", { id: 999, name: "Acme" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "unknown_fields", fields: ["id"] });
  });

  test("update refuses them on both verbs, and writes nothing", async () => {
    for (const verb of ["PATCH", "PUT"] as const) {
      const res = await demo.send(verb, "/api/customers/1", { name: "Renamed", isAdmin: true });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "unknown_fields", fields: ["isAdmin"] });
    }
    expect((await demo.get("/api/customers/1")).body).toMatchObject({ name: "Harbor Bakery" });
  });

  describe('with api.unknownFields: "drop" in the project config', () => {
    let project: ProjectCopy;
    let dropping: Demo;
    beforeAll(async () => {
      project = copyProject();
      project.editConfig((config) => {
        (config["api"] as Record<string, unknown>)["unknownFields"] = "drop";
      });
      dropping = await openDemo({ projectDir: project.dir });
    });
    afterAll(async () => {
      await dropping.close();
      project.remove();
    });

    test("the undeclared key is dropped and the row is written without it", async () => {
      const res = await dropping.send("POST", "/api/customers", { name: "Acme", isAdmin: true });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: "Acme" });
      expect(res.body).not.toHaveProperty("isAdmin");
    });
  });
});

describe("validation from the metadata", () => {
  const refused = async (collection: string, body: unknown): Promise<unknown> => {
    const res = await demo.send("POST", `/api/${collection}`, body);
    expect(res.status).toBe(400);
    return res.body;
  };

  test("@required, @maxLength and validator children", async () => {
    expect(await refused("customers", { email: "ops@acme.example" })).toMatchObject({
      error: "validation",
      issues: [{ path: ["name"], code: "required" }],
    });
    expect(await refused("customers", { name: "x".repeat(121) })).toMatchObject({ error: "validation", issues: [{ path: ["name"] }] });
    expect(await refused("customers", { name: "Acme", email: "not-an-address" })).toMatchObject({
      error: "validation",
      issues: [{ path: ["email"], code: "regex" }],
    });
    expect(await refused("parts", { sku: "N-1", name: "n", unitPriceCents: 100, stockQty: -4 })).toMatchObject({
      error: "validation",
      issues: [{ path: ["stockQty"], code: "numeric" }],
    });
  });

  test("a value of the wrong type", async () => {
    expect(await refused("parts", { sku: "N-2", name: "n", unitPriceCents: "cheap" })).toMatchObject({
      error: "validation",
      issues: [{ path: ["unitPriceCents"] }],
    });
    expect(await refused("technicians", { name: "T", level: "master", hourlyRate: "12.345" })).toMatchObject({
      error: "validation",
      issues: [{ path: ["hourlyRate"] }],
    });
  });

  test("an enum value must be a declared member, and a date a real date", async () => {
    expect(await refused("customers", { name: "Acme", tier: "diamond" })).toEqual({
      error: "validation",
      issues: [{ path: ["tier"], code: "enum", message: "'tier' must be one of standard, gold, platinum." }],
    });
    expect(await refused("technicians", { name: "T", level: "master", hourlyRate: "50", hiredOn: "2026-02-31" })).toMatchObject({
      error: "validation",
      issues: [{ path: ["hiredOn"], code: "date" }],
    });
  });

  test("a value object is checked member by member", async () => {
    expect(await refused("customers", { name: "Acme", billingAddress: { street: "1 Main" } })).toMatchObject({
      error: "validation",
      issues: [{ path: ["billingAddress.city"], code: "required" }],
    });
    expect(await refused("customers", { name: "Acme", billingAddress: { street: "1 Main", city: "Town", planet: "Mars" } })).toMatchObject({
      error: "validation",
      issues: [{ path: ["billingAddress", "planet"], code: "unknown_member" }],
    });
  });

  test("a body that is not an object, and a body that is not JSON", async () => {
    expect(await refused("customers", ["Acme"])).toMatchObject({ error: "validation" });
    const res = await demo.app.inject({ method: "POST", url: "/api/customers", payload: "{not json", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_json" });
  });
});

describe("round trip", () => {
  test("create, read, update and delete through the one mount", async () => {
    const created = await demo.send("POST", "/api/customers", {
      name: "Round Trip Co",
      tier: "gold",
      billingAddress: { street: "5 Loop Road", city: "Circleville" },
    });
    expect(created.status).toBe(201);
    const row = created.body as Record<string, unknown>;
    // `active` was not sent: the metadata's @default filled it.
    expect(row).toMatchObject({ name: "Round Trip Co", tier: "gold", active: true, billingAddress: { street: "5 Loop Road", city: "Circleville" } });
    const path = `/api/customers/${String(row["id"])}`;

    expect((await demo.get(path)).body).toEqual(row);
    const patched = await demo.send("PATCH", path, { active: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: "Round Trip Co", active: false });
    expect((await demo.send("PUT", path, { tier: "platinum" })).body).toMatchObject({ tier: "platinum", active: false });

    expect((await demo.send("DELETE", path)).status).toBe(204);
    expect((await demo.get(path)).status).toBe(404);
    expect((await demo.send("DELETE", path)).status).toBe(404);
    expect((await demo.send("PATCH", path, { active: true })).status).toBe(404);
  });

  test("a decimal is exact: it goes in and comes back as a string", async () => {
    const created = await demo.send("POST", "/api/technicians", { name: "Dee", level: "journeyman", hourlyRate: "71.35" });
    expect(created.status).toBe(201);
    expect((created.body as Record<string, unknown>)["hourlyRate"]).toBe("71.35");
  });
});

describe("constraints the database enforces", () => {
  test("a unique violation is a 409 that says only which kind", async () => {
    const res = await demo.send("POST", "/api/parts", { sku: "BRG-6204", name: "duplicate", unitPriceCents: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "constraint_violation", constraint: "unique" });
  });

  test("a reference to a row that does not exist, and deleting a row something refers to", async () => {
    const orphan = await demo.send("POST", "/api/work_orders", { title: "Nobody's", customerId: 987654 });
    expect(orphan.status).toBe(409);
    expect(orphan.body).toEqual({ error: "constraint_violation", constraint: "foreign_key" });
    const inUse = await demo.send("DELETE", "/api/customers/2");
    expect(inUse.status).toBe(409);
    expect(inUse.body).toEqual({ error: "constraint_violation", constraint: "foreign_key" });
  });
});

describe("hand-written business rules, typed against the generated code", () => {
  test("a work order cannot be marked done with no technician", async () => {
    // Work order 7 has no technician.
    const res = await demo.send("PATCH", "/api/work_orders/7", { status: "done" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "validation",
      issues: [{ path: ["technicianId"], code: "work_order.done_needs_technician", message: "Assign a technician before marking the work order done." }],
    });
    expect((await demo.get("/api/work_orders/7")).body).toMatchObject({ status: "open" });
    // Assigning one in the same request satisfies it.
    expect((await demo.send("PATCH", "/api/work_orders/7", { status: "done", technicianId: 1 })).status).toBe(200);
    // And it holds on create too.
    expect((await demo.send("POST", "/api/work_orders", { title: "Born done", customerId: 1, status: "done" })).status).toBe(400);
  });

  test("a line cannot take a discontinued part, or more than is in stock", async () => {
    const discontinued = await demo.send("POST", "/api/work_order_lines", { workOrderId: 1, partId: 6, quantity: 1 });
    expect(discontinued.status).toBe(400);
    expect(discontinued.body).toMatchObject({
      error: "validation",
      issues: [{ path: ["partId"], code: "work_order_line.part_discontinued" }, { path: ["quantity"], code: "work_order_line.insufficient_stock" }],
    });
    // Part 5 has 3 in stock.
    expect((await demo.send("POST", "/api/work_order_lines", { workOrderId: 1, partId: 5, quantity: 4 })).body).toMatchObject({
      issues: [{ path: ["quantity"], code: "work_order_line.insufficient_stock", message: "Only 3 of PMP-W-110 in stock." }],
    });
    expect((await demo.send("POST", "/api/work_order_lines", { workOrderId: 1, partId: 5, quantity: 3 })).status).toBe(201);
  });

  test("a rule is not asked about a body the metadata already refuses", async () => {
    const res = await demo.send("POST", "/api/work_order_lines", { workOrderId: 1, partId: 5, quantity: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation", issues: [{ path: ["quantity"], code: "numeric" }] });
  });
});

describe("fields no route reads or writes", () => {
  // A credential (a field with a view.password) and a field marked @formExclude, added to
  // Technician. The generated routes never write either and never show a credential.
  let project: ProjectCopy;
  let guarded: Demo;
  let id: unknown;
  beforeAll(async () => {
    project = copyProject();
    project.editModel(
      "- field.date: { name: hiredOn, filterable: true }",
      [
        "- field.date: { name: hiredOn, filterable: true }",
        "          - field.string:",
        "              name: portalSecret",
        "              maxLength: 200",
        "              children:",
        "                - view.password: { name: masked }",
        "          - field.string: { name: payrollCode, maxLength: 20, formExclude: true }",
      ].join("\n"),
    );
    guarded = await openDemo({ projectDir: project.dir });
    // The application's own code is what writes them.
    const written = await guarded.runtime.current().om.create("Technician", {
      name: "Eve Castellan", level: "master", hourlyRate: "90.00", portalSecret: "s3cret-hash", payrollCode: "P-17",
    });
    id = written["id"];
  });
  afterAll(async () => {
    await guarded.close();
    project.remove();
  });

  test("a credential is in no response: get, list, create or update", async () => {
    const one = await guarded.get(`/api/technicians/${String(id)}`);
    expect(one.body).toMatchObject({ name: "Eve Castellan", payrollCode: "P-17" });
    expect(one.body).not.toHaveProperty("portalSecret");

    const list = await guarded.get("/api/technicians?filter[name]=Eve%20Castellan&withCount=1");
    expect(JSON.stringify(list.body)).not.toContain("s3cret-hash");
    expect(JSON.stringify(list.body)).not.toContain("portalSecret");

    const updated = await guarded.send("PATCH", `/api/technicians/${String(id)}`, { level: "journeyman" });
    expect(updated.status).toBe(200);
    expect(updated.body).not.toHaveProperty("portalSecret");

    const created = await guarded.send("POST", "/api/technicians", { name: "Finn Aldous", level: "apprentice", hourlyRate: "30.00" });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty("portalSecret");
  });

  test("neither can be set through a route, and the stored values stand", async () => {
    for (const body of [{ portalSecret: "mine-now" }, { payrollCode: "P-99" }]) {
      const res = await guarded.send("PATCH", `/api/technicians/${String(id)}`, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "unknown_fields", fields: Object.keys(body) });
    }
    const stored = await guarded.runtime.current().om.findById("Technician", id);
    expect(stored).toMatchObject({ portalSecret: "s3cret-hash", payrollCode: "P-17" });
  });
});
