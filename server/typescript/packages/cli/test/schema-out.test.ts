/**
 * `meta schema --out <path>` — a path that cannot be written is a clean CLI error
 * (exit 1, message naming the path), not an unhandled ENOENT stack trace. The
 * parent directory is not created silently.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaCommand } from "../src/commands/schema.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [{
      "object.entity": {
        name: "Job",
        children: [
          { "source.rdb": { name: "src", "@table": "jobs" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "schema-out-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects"), { recursive: true });
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1 }), "utf8");
  return root;
}

describe("meta schema --out", () => {
  test("a missing parent directory exits 1 without creating it", async () => {
    const root = await project();
    const code = await schemaCommand(["--dialect", "sqlite", "--out", "missing/expected.sql"], root);
    expect(code).toBe(1);
    await expect(stat(join(root, "missing"))).rejects.toThrow();
  });

  test("a writable path receives the DDL and exits 0", async () => {
    const root = await project();
    const code = await schemaCommand(["--dialect", "sqlite", "--out", "expected.sql"], root);
    expect(code).toBe(0);
    expect(await readFile(join(root, "expected.sql"), "utf8")).toContain("CREATE TABLE");
  });
});
