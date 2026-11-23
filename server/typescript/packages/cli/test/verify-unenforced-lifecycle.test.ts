/**
 * `meta verify` — a lifecycle no service generator enforces (ADR-0067 §6).
 *
 * The flat routes generators write no rules, by decision, so a project that declares a lifecycle
 * and lists no service generator for that entity has transitions and permissions nothing checks.
 * `verify` names each such entity in its advisory tier and never fails the build on it.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStringSource, MetaDataLoader, type MetaData } from "@metaobjectsdev/metadata";
import { verifyCommand } from "../src/commands/verify.js";
import { scanForUnenforcedLifecycles } from "../src/lib/unenforced-lifecycle-advisory.js";

const SCRATCH = process.env.DEV_SCRATCH ?? tmpdir();
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const order = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  "object.entity": { name: "Order", ...extra, children: [
    { "source.rdb": { "@table": "orders" } },
    { "field.long": { name: "id" } },
    { "identity.primary": { name: "pk", "@fields": ["id"] } },
    { "field.enum": { name: "status", "@values": ["draft", "placed"], "@default": "draft", children: [
      { "transition.action": { name: "place", "@from": ["draft"], "@to": "placed" } },
    ] } },
  ] },
});

/** A second entity with a lifecycle and no source: inert, so never named. */
const SOURCELESS = {
  "object.entity": { name: "Draft", children: [
    { "field.long": { name: "id" } },
    { "field.enum": { name: "state", "@values": ["open", "shut"], "@default": "open", children: [
      { "transition.action": { name: "shut", "@from": ["open"], "@to": "shut" } },
    ] } },
  ] },
};

const MODEL = JSON.stringify({ "metadata.root": { package: "acme::shop", children: [order(), SOURCELESS] } });

function project(generators: string): string {
  const root = mkdtempSync(join(SCRATCH, "verify-lifecycle-"));
  dirs.push(root);
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.shop.json"), MODEL, "utf8");
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated"))},
  dialect: "sqlite",
  extStyle: "none",
  generators: ${generators},
});
`,
  );
  return root;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

async function loadModel(doc: unknown): Promise<MetaData> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}

async function loaded(): Promise<MetaData> {
  return loadModel(JSON.parse(MODEL));
}

describe("a lifecycle no service generator enforces (advisory)", () => {
  test("verify names the entity when the generators include no service, and passes", async () => {
    const root = project(`[]`);
    const { code, out } = await capture(() => verifyCommand(["--templates"], root));
    expect(code).toBe(0);
    expect(out).toContain("1 entit(ies) declare a lifecycle no service generator enforces");
    expect(out).toContain(`acme::shop::Order declares a lifecycle on "status"`);
    expect(out).not.toContain("acme::shop::Draft");
  });

  test("a listed service generator silences it", async () => {
    const root = project(`["service"]`);
    const { code, out } = await capture(() => verifyCommand(["--templates"], root));
    expect(code).toBe(0);
    expect(out).not.toContain("no service generator enforces");
  });

  test("the structured payload carries one row keyed to the entity", async () => {
    const root = project(`[]`);
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.error = () => {};
    try {
      expect(await verifyCommand(["--templates"], root, undefined, "json")).toBe(0);
    } finally {
      console.log = log;
      console.error = err;
    }
    const payload = JSON.parse(lines.join("\n")) as { antiPatterns: { rows: { rule: string; construct: string }[] } };
    const rows = payload.antiPatterns.rows.filter((r) => r.rule === "unenforced-lifecycle");
    expect(rows.map((r) => r.construct)).toEqual(["acme::shop::Order"]);
  });

  test("a service generator whose filter drops the entity does not cover it", async () => {
    const root = await loaded();
    const keep = (keepIt: boolean) => [{ name: "service", filter: () => keepIt }];
    expect(scanForUnenforcedLifecycles(root, keep(false)).map((f) => f.construct)).toEqual(["acme::shop::Order"]);
    expect(scanForUnenforcedLifecycles(root, keep(true))).toEqual([]);
    expect(scanForUnenforcedLifecycles(root, [{ name: "routes" }]).map((f) => f.construct)).toEqual(["acme::shop::Order"]);
  });

  test("a model with no lifecycle has nothing to name", async () => {
    const root = await loadModel({ "metadata.root": { package: "acme::shop", children: [
      { "object.entity": { name: "Plain", children: [
        { "source.rdb": { "@table": "plain" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"] } },
      ] } },
    ] } });
    expect(scanForUnenforcedLifecycles(root, [])).toEqual([]);
  });
});
