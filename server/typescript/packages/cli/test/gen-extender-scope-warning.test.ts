// rc.21 part B (I2): an extender keeps its super's identity anchor, so a view whose own fields
// read a TPH subtype's columns returns every base row. The loader records that on its warning
// channel, which `loadMemory` does not return; every command that loads a model to emit or check
// views (gen, migrate, verify) prints it, so the change is visible.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

function model(scoped: boolean, abstract = false): string {
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
        { "object.projection": { name: "TruckRow", extends: "VehicleBase", ...(abstract ? { abstract: true } : {}), ...(scoped ? { "@filter": { kind: "TRUCK" } } : {}), children: [
          { "source.rdb": { "@kind": "view", "@view": "v_trucks" } },
          { "field.string": { name: "payload", extends: "Truck.payloadClass" } } ] } },
      ],
    },
  });
}

function setupRepo(scoped: boolean, abstract = false, generators = "[]"): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "gen-extender-scope-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), model(scoped, abstract), "utf8");
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }), "utf8");
  writeFileSync(join(root, "metaobjects.config.ts"), `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated"))},
  dialect: "postgres",
  dbImport: "~/db",
  extStyle: "none",
  generators: ${generators},
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
  test("a skipped run still prints it, as dotnet meta gen does", async () => {
    // A wired generator, so the first run stores the key the second one skips on.
    const root = setupRepo(false, false, `["entity"]`);
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      err.length = 0;
      out.length = 0;
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect([...out, ...err].join("\n")).toContain("nothing changed since the last meta gen");
      expect(err.join("\n")).toContain("object.projection TruckRow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  test("meta verify and meta migrate print it too (fix round 2, N4)", async () => {
    const root = setupRepo(false);
    try {
      await run(["verify", "--cwd", root]);
      expect(err.join("\n")).toContain("object.projection TruckRow");
      err.length = 0;
      await run(["migrate", "--cwd", root, "--dialect", "sqlite", "--dry-run"]);
      expect(err.join("\n")).toContain("object.projection TruckRow");
      err.length = 0;
      await run(["migrate", "--cwd", root, "--from-db", "--db", `file:${join(root, "t.db")}`, "--slug", "init", "--dry-run"]);
      expect(err.join("\n")).toContain("object.projection TruckRow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an abstract extender emits no view: no warning (fix round 2, N4)", async () => {
    const root = setupRepo(false, true);
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(err.join("\n")).not.toContain("object.projection TruckRow");
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
