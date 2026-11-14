// rc.21 part B (I2): an extender keeps its super's identity anchor, so a view whose own fields
// read a TPH subtype's columns returns every base row. The loader records that on its warning
// channel, which `loadMemory` does not return; `meta gen` prints it so the change is visible.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

function model(scoped: boolean): string {
  return JSON.stringify({
    "metadata.root": {
      package: "app",
      children: [
        { "object.entity": { name: "Vehicle", "@discriminator": "kind", children: [
          { "source.rdb": { "@table": "vehicles" } }, { "field.long": { name: "id" } },
          { "field.string": { name: "kind", "@maxLength": 10 } }, { "identity.primary": { "@fields": "id" } } ] } },
        { "object.entity": { name: "Truck", extends: "Vehicle", "@discriminatorValue": "TRUCK", children: [
          { "field.string": { name: "payloadClass" } } ] } },
        { "object.projection": { name: "VehicleBase", abstract: true, children: [
          { "field.long": { name: "vehicleId", extends: "Vehicle.id" } },
          { "identity.primary": { name: "id", extends: "Vehicle.primary" } } ] } },
        { "object.projection": { name: "TruckRow", extends: "VehicleBase", ...(scoped ? { "@filter": { kind: "TRUCK" } } : {}), children: [
          { "source.rdb": { "@kind": "view", "@view": "v_trucks" } },
          { "field.string": { name: "payload", extends: "Truck.payloadClass" } } ] } },
      ],
    },
  });
}

function setupRepo(scoped: boolean): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "gen-extender-scope-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), model(scoped), "utf8");
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }), "utf8");
  writeFileSync(join(root, "metaobjects.config.ts"), `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated"))},
  dialect: "postgres",
  dbImport: "~/db",
  extStyle: "none",
  generators: [],
});
`);
  return root;
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta gen — the widened-extender warning is printed", () => {
  test("names the projection, the field and the remedy; exit code unchanged", async () => {
    const root = setupRepo(false);
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const stderr = err.join("\n");
      expect(stderr).toContain("object.projection TruckRow");
      expect(stderr).toContain(`"payload" (Truck.payloadClass)`);
      expect(stderr).toContain("@filter { kind: <value> }");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a discriminator filter scopes it: no warning", async () => {
    const root = setupRepo(true);
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(err.join("\n")).not.toContain("object.projection TruckRow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
