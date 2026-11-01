/**
 * An FK whose target columns are not a unique key is a metadata defect, not a tool
 * failure: `meta migrate` refuses it with the engine's message and a hint, the way it
 * refuses two declarations that generate one database name, never as an "unexpected error".
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
      {
        "object.entity": {
          name: "Person",
          children: [
            { "source.rdb": { name: "src", "@table": "people" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "code" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Visit",
          children: [
            { "source.rdb": { name: "src", "@table": "visits" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "personCode" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.reference": { name: "ref_person", "@fields": ["personCode"], "@references": "Person.code" } },
          ],
        },
      },
    ],
  },
});

async function project(migrate: Record<string, unknown> = { dialect: "sqlite" }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fk-target-unique-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
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

describe("meta migrate refuses an FK to a non-unique target", () => {
  test("exits 1 with the reference named and the fix, not as an unexpected error", async () => {
    const root = await project();
    const code = await migrateCommand(["--from-db", "--db", `file:${join(root, "t.db")}`, "--dialect", "sqlite", "--dry-run"], root);

    const text = out.join("\n");
    expect(code).toBe(1);
    expect(text).toContain('reference "ref_person" targets [code] on "Person"');
    expect(text).toContain("identity.secondary");
    expect(text).not.toContain("unexpected error");
    expect(text).not.toContain("CREATE TABLE");
  });

  test("a holder outside migrate.scope is not this run's to fix: warned, and the run goes on", async () => {
    const root = await project({ dialect: "sqlite", scope: ["acme::platform::Person"] });
    const code = await migrateCommand(["--from-db", "--db", `file:${join(root, "t.db")}`, "--dialect", "sqlite", "--dry-run"], root);

    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain('reference "ref_person" targets [code] on "Person"');
    expect(text).toContain("not governed by this run");
  });
});
