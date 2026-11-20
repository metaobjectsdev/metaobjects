/**
 * Change the metadata, reload, and the API changes. No code is generated and no route is
 * registered: the one mount reads the new model on its next request.
 *
 * (The dev server calls the same `reload()` when a metadata file is saved. A restart does
 * the same thing from an empty database.)
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { copyProject, openDemo, PROJECT_DIR, type Demo, type ProjectCopy } from "./helpers";

let project: ProjectCopy;
let demo: Demo;
let generatedBefore: string;

/** Name, size and modified time of every generated file: unchanged means nothing was regenerated. */
function generatedFingerprint(): string {
  const dir = join(PROJECT_DIR, "src", "generated");
  return readdirSync(dir).sort().map((name) => {
    const stat = statSync(join(dir, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join("|");
}

const metaText = async (): Promise<string> => (await demo.app.inject({ method: "GET", url: "/api/_meta" })).body;

beforeAll(async () => {
  generatedBefore = generatedFingerprint();
  project = copyProject();
  demo = await openDemo({ projectDir: project.dir });
});
afterAll(async () => {
  await demo.close();
  project.remove();
});

test("before the edit: the field is not filterable, the column and the entity do not exist", async () => {
  expect((await demo.get("/api/work_orders?filter[notes][like]=Waiting%25")).status).toBe(400);
  expect((await demo.send("POST", "/api/parts", { sku: "W-1", name: "w", unitPriceCents: 1, warrantyMonths: 12 })).body).toEqual({
    error: "unknown_fields",
    fields: ["warrantyMonths"],
  });
  expect((await demo.get("/api/suppliers")).status).toBe(404);
  expect(await metaText()).not.toContain("warrantyMonths");
});

test("marking a field @filterable makes it filterable", async () => {
  project.editModel("name: notes\n              maxLength: 2000", "name: notes\n              maxLength: 2000\n              filterable: true");
  await demo.runtime.reload();
  const res = await demo.get("/api/work_orders?filter[notes][like]=Waiting%25");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject([{ title: "Compressor will not hold pressure" }]);
});

test("a new field is served by /_meta, stored, returned and filterable", async () => {
  project.editModel(
    "- field.boolean: { name: discontinued, required: true, default: false, filterable: true }",
    "- field.boolean: { name: discontinued, required: true, default: false, filterable: true }\n          - field.int: { name: warrantyMonths, filterable: true }",
  );
  await demo.runtime.reload();
  expect(await metaText()).toContain("warrantyMonths");
  const created = await demo.send("POST", "/api/parts", { sku: "W-1", name: "Warrantied widget", unitPriceCents: 500, warrantyMonths: 24 });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ sku: "W-1", warrantyMonths: 24 });
  expect((await demo.get("/api/parts?filter[warrantyMonths][gte]=12")).body).toMatchObject([{ sku: "W-1" }]);
  // Rows written before the edit are still there, with no value for the new field.
  expect((await demo.get("/api/parts/1")).body).toMatchObject({ sku: "BLT-M8-40", warrantyMonths: null });
});

test("a new enum member is accepted, by writes and by filters", async () => {
  expect((await demo.send("PATCH", "/api/work_orders/1", { priority: "critical" })).status).toBe(400);
  project.editModel("values: [low, normal, urgent]", "values: [low, normal, urgent, critical]");
  await demo.runtime.reload();
  expect((await demo.send("PATCH", "/api/work_orders/1", { priority: "critical" })).body).toMatchObject({ priority: "critical" });
  expect((await demo.get("/api/work_orders?filter[priority]=critical")).body).toMatchObject([{ id: 1 }]);
});

test("a new entity gets its table and its routes", async () => {
  project.appendModel(`
    - object.entity:
        name: Supplier
        children:
          - source.rdb: { table: suppliers }
          - field.long: { name: id }
          - field.string: { name: name, required: true, maxLength: 120, filterable: true }
          - field.enum: { name: rating, values: [preferred, approved, probation], filterable: true }
          - identity.primary: { name: pk, fields: id, generation: increment }
`);
  await demo.runtime.reload();
  expect((await demo.get("/api/suppliers")).body).toEqual([]);
  const created = await demo.send("POST", "/api/suppliers", { name: "Bearing Supply Co", rating: "preferred" });
  expect(created.status).toBe(201);
  expect((await demo.get("/api/suppliers?filter[rating]=preferred&sort=name")).body).toEqual([created.body]);
  expect((await demo.send("POST", "/api/suppliers", { name: "x", rating: "terrible" })).status).toBe(400);
  expect((await demo.get("/api/suppliers?filter[id]=1")).body).toMatchObject({ error: "invalid_filter_field", allowed: ["name", "rating"] });
});

test("an edit that would drop a column is refused, and the model in force keeps serving", async () => {
  project.editModel("          - field.date: { name: hiredOn, filterable: true }\n", "");
  project.editModel("columns: [name, level, hourlyRate, hiredOn]", "columns: [name, level, hourlyRate]");
  await expect(demo.runtime.reload()).rejects.toThrow(/drop-column on technicians\.hired_on/);
  expect((await demo.get("/api/technicians?filter[hiredOn][lt]=2020-01-01")).body).toMatchObject([{ name: "Ada Okafor", hiredOn: "2015-03-02" }]);
});

test("a metadata file that does not load is refused too", async () => {
  project.appendModel("    - object.entity: { name: Broken, children: [ { field.nosuchtype: { name: x } } ] }\n");
  await expect(demo.runtime.reload()).rejects.toThrow();
  expect((await demo.get("/api/suppliers")).status).toBe(200);
});

test("none of it touched the generated code", () => {
  expect(generatedFingerprint()).toBe(generatedBefore);
});
