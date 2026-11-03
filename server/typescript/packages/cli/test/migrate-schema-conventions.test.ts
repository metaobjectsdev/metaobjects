/**
 * `migrate.conventions` (or a conventions object from metaobjects.config.ts) reaches
 * `meta migrate` and `meta verify --db`: an `efcore` project gets EF Core's database-only
 * names (here, the index EF puts on every foreign key), and a preset name the tool does not
 * know is refused by name, as a config error.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCommand } from "../src/commands/migrate.js";
import { verifyCommand } from "../src/commands/verify.js";
import { genCommand } from "../src/commands/gen.js";
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

  test("meta gen refuses an unknown preset too, rather than generating with the default names", async () => {
    const root = await project("hibernate");
    await writeFile(join(root, "metaobjects.config.ts"), "export default { generators: [] };\n", "utf8");
    const code = await genCommand([], root);
    expect(code).toBe(2);
    expect(out.join("\n")).toContain('migrate.conventions "hibernate" is not a schema-conventions preset');
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

  test("meta verify --db builds with the same conventions, from config.json or metaobjects.config.ts", async () => {
    const consoleSpies = [
      spyOn(console, "log").mockImplementation((m: unknown) => { out.push(String(m)); }),
      spyOn(console, "error").mockImplementation((m: unknown) => { out.push(String(m)); }),
    ];
    try {
      const db = (root: string) => `file:${join(root, "t.db")}`;
      const verify = (root: string) => verifyCommand(["--db", db(root), "--dialect", "sqlite"], root);

      const preset = await project("efcore");
      expect(await migrateCommand(["--from-db", "--db", db(preset), "--dialect", "sqlite", "--slug", "init", "--apply"], preset)).toBe(0);
      expect(await verify(preset)).toBe(0);

      const own = await project(undefined);
      await writeFile(join(own, "metaobjects.config.ts"), [
        'import { efcoreConventions } from "@metaobjectsdev/migrate-ts";',
        "export default { generators: [], schemaConventions: { ...efcoreConventions, id: \"acme\" } };",
        "",
      ].join("\n"), "utf8");
      expect(await migrateCommand(["--from-db", "--db", db(own), "--dialect", "sqlite", "--slug", "init", "--apply"], own)).toBe(0);
      expect(await verify(own)).toBe(0);

      // Without the conventions, the EF Core FK index is an object the metadata does not describe.
      await rm(join(own, "metaobjects.config.ts"));
      out = [];
      expect(await verify(own)).toBe(1);
      expect(out.join("\n")).toContain("IX_OrderLines_OrderId");
    } finally {
      for (const s of consoleSpies) s.mockRestore();
    }
  });
});
