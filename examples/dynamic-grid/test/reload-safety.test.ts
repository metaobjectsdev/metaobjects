/**
 * A reload that goes wrong must not leave the server unable to reload again, and a runtime
 * that never opened must leave nothing behind.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntime } from "../src/server/runtime";
import { copyProject, openDemo, type Demo, type ProjectCopy } from "./helpers";

const HIRED_ON = "- field.date: { name: hiredOn, filterable: true }";
const withFields = (...fields: string[]): string => [HIRED_ON, ...fields.map((field) => `          ${field}`)].join("\n");

let project: ProjectCopy;
let demo: Demo | undefined;
beforeEach(() => {
  project = copyProject();
});
afterEach(async () => {
  await demo?.close();
  demo = undefined;
  project.remove();
});

test("two reloads at once each see the schema the other left, so no statement runs twice", async () => {
  demo = await openDemo({ projectDir: project.dir });
  project.editModel(HIRED_ON, withFields("- field.string: { name: badge, maxLength: 20 }"));
  const [first, second] = await Promise.all([demo.runtime.reload(), demo.runtime.reload()]);
  expect([first.revision, second.revision]).toEqual([2, 3]);
  const created = await demo.send("POST", "/api/technicians", { name: "Hal Brandt", level: "apprentice", hourlyRate: "31.00", badge: "T-204" });
  expect(created.body).toMatchObject({ badge: "T-204" });
});

test("a reload whose schema change fails part-way changes nothing, and the corrected model then loads", async () => {
  demo = await openDemo({ projectDir: project.dir });
  // The first column can be added; the second cannot (a required column with no default,
  // on a table that has rows). Neither must stay.
  project.editModel(
    HIRED_ON,
    withFields("- field.string: { name: badge, maxLength: 20 }", "- field.string: { name: union, maxLength: 20, required: true }"),
  );
  await expect(demo.runtime.reload()).rejects.toThrow();
  expect(demo.runtime.current().revision).toBe(1);
  expect((await demo.get("/api/technicians")).status).toBe(200);

  project.editModel("- field.string: { name: union, maxLength: 20, required: true }", "- field.string: { name: union, maxLength: 20 }");
  expect((await demo.runtime.reload()).revision).toBe(2);
  const created = await demo.send("POST", "/api/technicians", { name: "Hal Brandt", level: "apprentice", hourlyRate: "31.00", badge: "T-204", union: "L-9" });
  expect(created.body).toMatchObject({ badge: "T-204", union: "L-9" });
});

test("a runtime that cannot load its model leaves no scratch database behind", async () => {
  const scratch = mkdtempSync(join(process.env["DEV_SCRATCH"] ?? tmpdir(), "dynamic-grid-scratch-"));
  const before = process.env["DEV_SCRATCH"];
  process.env["DEV_SCRATCH"] = scratch;
  try {
    project.appendModel("    - object.entity: { name: Broken, children: [ { field.nosuchtype: { name: x } } ] }\n");
    await expect(openRuntime({ projectDir: project.dir })).rejects.toThrow();
    expect(readdirSync(scratch)).toEqual([]);
  } finally {
    if (before === undefined) delete process.env["DEV_SCRATCH"];
    else process.env["DEV_SCRATCH"] = before;
    rmSync(scratch, { recursive: true, force: true });
  }
});
