/**
 * ADR-0019 Amendment 2: committed output generated under another `wire` setting is not "stale".
 * Regenerating would change the JSON the API writes, so `verify --codegen` names the `wire` block
 * that reproduces the committed output instead of prescribing `meta gen`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

const MODEL = { "metadata.root": { package: "acme", children: [
  { "object.value": { name: "Price", children: [
    { "field.decimal": { name: "net", "@precision": 12, "@scale": 2 } },
    { "field.string": { name: "note" } },
  ] } },
  { "object.entity": { name: "Item", children: [
    { "source.rdb": { "@table": "items" } },
    { "field.long": { name: "id" } },
    { "field.decimal": { name: "amount", "@precision": 10, "@scale": 2 } },
    { "field.object": { name: "price", "@objectRef": "Price", "@storage": "jsonb" } },
    { "identity.primary": { "@fields": "id" } },
  ] } },
] } };

function setupRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "verify-wire-"));
  mkdirSync(join(root, "metaobjects"));
  writeFileSync(join(root, "metaobjects", "meta.acme.json"), JSON.stringify(MODEL));
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated"))},
  dialect: "postgres",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity", "queries", "routes"],
});
`,
  );
  return root;
}

function writeWire(root: string, wire: Record<string, string> | null): void {
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify(wire === null ? { schema_version: 1 } : { schema_version: 1, wire }),
  );
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

const all = (): string => [...out, ...err].join("\n");

describe("meta verify --codegen — the wire setting", () => {
  test("output committed under another wire setting names that setting, not 'meta gen'", async () => {
    const root = setupRepo();
    try {
      writeWire(root, { decimals: "string", nullMembers: "omit" });
      expect(await run(["gen", "--cwd", root])).toBe(0);

      writeWire(root, null);
      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);
      expect(all()).toContain(
        'The committed output was generated with "wire": { "decimals": "string", "nullMembers": "omit" }; ' +
          'this run used "wire": { "decimals": "native", "nullMembers": "native" }',
      );
      expect(all()).toContain("Do not regenerate");
      expect(all()).not.toContain("Run 'meta gen' to regenerate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("the matching setting passes", async () => {
    const root = setupRepo();
    try {
      writeWire(root, { decimals: "string" });
      expect(await run(["gen", "--cwd", root])).toBe(0);
      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a model change is still reported as stale", async () => {
    const root = setupRepo();
    try {
      writeWire(root, null);
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const changed = JSON.parse(JSON.stringify(MODEL));
      changed["metadata.root"].children[1]["object.entity"].children.push({ "field.string": { name: "sku" } });
      writeFileSync(join(root, "metaobjects", "meta.acme.json"), JSON.stringify(changed));
      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);
      expect(all()).toContain("Run 'meta gen' to regenerate");
      expect(all()).not.toContain("The committed output was generated with");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
