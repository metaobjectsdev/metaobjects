/**
 * `migrate.conventions` reaches `meta migrate` through the project-aware load: an `efcore`
 * project gets EF Core's database-only names (here, the index EF puts on every foreign
 * key), and a preset name the tool does not know is refused by name, as a config error.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCommand } from "../src/commands/migrate.js";
import { log } from "../src/lib/log.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [
      { "object.entity": { name: "Order", children: [
        { "source.rdb": { name: "src", "@table": "Orders" } },
        { "field.long": { name: "id", "@column": "Id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "OrderLine", children: [
        { "source.rdb": { name: "src", "@table": "OrderLines" } },
        { "field.long": { name: "id", "@column": "Id" } },
        { "field.long": { name: "orderId", "@column": "OrderId" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "order", "@fields": ["orderId"], "@references": "Order" } },
      ] } },
    ],
  },
});

async function project(conventions: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "schema-conventions-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
  const migrate = conventions === undefined ? { dialect: "sqlite" } : { dialect: "sqlite", conventions };
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, migrate }), "utf8");
  return root;
}

let out: string[] = [];
let infoSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  out = [];
  infoSpy = spyOn(log, "info").mockImplementation((m: string) => { out.push(String(m)); });
  errSpy = spyOn(log, "error").mockImplementation((m: string) => { out.push(String(m)); });
  warnSpy = spyOn(log, "warn").mockImplementation((m: string) => { out.push(String(m)); });
});
afterEach(() => { infoSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore(); });

const dryRun = (root: string) =>
  migrateCommand(["--from-db", "--db", `file:${join(root, "t.db")}`, "--dialect", "sqlite", "--dry-run"], root);

describe("meta migrate with migrate.conventions", () => {
  test("efcore: the foreign key gets EF Core's IX_ index", async () => {
    const root = await project("efcore");

    expect(await dryRun(root)).toBe(0);
    expect(out.join("\n")).toContain('CREATE INDEX "IX_OrderLines_OrderId" ON "OrderLines" ("OrderId");');
  });

  test("no conventions set: no FK index, as before", async () => {
    const root = await project(undefined);

    expect(await dryRun(root)).toBe(0);
    expect(out.join("\n")).not.toContain("IX_OrderLines_OrderId");
  });

  test("an unknown preset is refused by name, not as an unexpected error", async () => {
    const root = await project("hibernate");

    const code = await dryRun(root);
    const text = out.join("\n");
    expect(code).toBe(2);
    expect(text).toContain('migrate.conventions "hibernate" is not a schema-conventions preset: expected one of default, efcore');
    expect(text).not.toContain("unexpected error");
  });

  test("a conventions object from metaobjects.config.ts applies, importing the preset from migrate-ts", async () => {
    const root = await project(undefined);
    await writeFile(join(root, "metaobjects.config.ts"), [
      'import { efcoreConventions } from "@metaobjectsdev/migrate-ts";',
      "export default { generators: [], schemaConventions: { ...efcoreConventions, id: \"acme\" } };",
      "",
    ].join("\n"), "utf8");

    expect(await dryRun(root)).toBe(0);
    expect(out.join("\n")).toContain('CREATE INDEX "IX_OrderLines_OrderId"');
  });

  test("a metaobjects.config.ts that exists but does not load is warned about, not silently ignored", async () => {
    const root = await project(undefined);
    await writeFile(join(root, "metaobjects.config.ts"), 'throw new Error("config exploded");\n', "utf8");

    expect(await dryRun(root)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("metaobjects.config.ts exists but did not load");
    expect(text).toContain("config exploded");
    expect(text).toContain("schemaConventions");
  });
});
