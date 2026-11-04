/**
 * `enums.maxLength` in .metaobjects/config.json reaches `meta migrate` through the
 * project-aware load: an enum with no @maxLength gets VARCHAR(n), and a member longer than
 * the default is refused by name — a metadata defect, not an "unexpected error".
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCommand } from "../src/commands/migrate.js";
import { log } from "../src/lib/log.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

function model(values: string[]): string {
  return JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Ticket", children: [
      { "source.rdb": { "@table": "tickets" } },
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": values } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] } },
  ] } });
}

async function project(values: string[], maxLength: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "enum-max-length-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.acme.json"), model(values), "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
  await writeFile(join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, enums: { maxLength }, migrate: { dialect: "postgres" } }), "utf8");
  return root;
}

let out: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  out = [];
  spies = (["info", "error", "warn"] as const).map((k) =>
    spyOn(log, k).mockImplementation((m: string) => { out.push(String(m)); }));
});
afterEach(() => { for (const s of spies) s.mockRestore(); });

const dryRun = (root: string) =>
  migrateCommand(["--from-db", "--db", `file:${join(root, "t.db")}`, "--dialect", "sqlite", "--dry-run"], root);

describe("meta migrate with enums.maxLength", () => {
  test("an enum with no @maxLength gets the project's length", async () => {
    const root = await project(["OPEN", "CLOSED"], 24);
    expect(await dryRun(root)).toBe(0);
    expect(out.join("\n")).toMatch(/"status" (VARCHAR|varchar)\(24\)/);
  });

  test("a member longer than the default is refused by name, not as an unexpected error", async () => {
    const root = await project(["OPEN", "IN_PROGRESS"], 10);
    const code = await dryRun(root);
    const text = out.join("\n");
    expect(code).toBe(1);
    expect(text).toContain('field.enum "Ticket.status" has the member "IN_PROGRESS"');
    expect(text).not.toContain("unexpected error");
  });
});
