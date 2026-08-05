// #192 — `--migration-format flyway` end to end through the CLI.
//
// Two halves: the detect-and-refuse matrix (Flyway owns apply + history, so we
// generate but never apply), and the emit layout (V<N>__/U<N>__ into Flyway's
// conventional dir, with --out-dir overriding it).

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const ENTITY = (fields: string) => ({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "Order",
        children: [
          { "field.long": { name: "id" } },
          ...JSON.parse(fields),
          { "source.rdb": { name: "src", "@table": "orders" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

async function project(fields: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-flyway-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.orders.json"), JSON.stringify(ENTITY(fields)), "utf8");
  return root;
}

async function rewrite(root: string, fields: string): Promise<void> {
  await writeFile(join(root, "metaobjects", "meta.orders.json"), JSON.stringify(ENTITY(fields)), "utf8");
}

const cfg = (over: Record<string, unknown> = {}) =>
  ({
    dialect: "sqlite",
    format: "default",
    outDir: "./.metaobjects/migrations",
    onAmbiguous: "abort",
    allow: [],
    slug: "auto",
    dryRun: false,
    ...over,
  } as never);

const visible = (entries: string[]) => entries.filter((e) => !e.startsWith(".")).sort();

/**
 * Capture stderr around a CLI run. Exit code ALONE cannot prove these refusals:
 * `--apply` without `--db`, and `d1` without a wrangler config, already exit 2
 * for unrelated reasons — so each test must assert the specific refusal text or
 * it passes for the wrong reason.
 */
async function captureStderr(
  fn: () => Promise<number>,
): Promise<{ code: number; stderr: string }> {
  const captured: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { captured.push(a.map(String).join(" ")); };
  let code: number;
  try {
    code = await fn();
  } finally {
    console.error = origErr;
  }
  return { code, stderr: captured.join("\n") };
}

// ---------------------------------------------------------------------------
// Refusals — Flyway owns apply + flyway_schema_history
// ---------------------------------------------------------------------------

describe("migrate --migration-format flyway — detect-and-refuse", () => {
  test("--apply is refused, pointing at flyway migrate", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    const { code, stderr } = await captureStderr(() => run([
      "migrate", "--cwd", root, "--dialect", "sqlite", "--migration-format", "flyway",
      "--slug", "x", "--apply",
    ]));
    expect(code).toBe(2);
    expect(stderr).toContain("--apply is not supported with --migration-format flyway");
    expect(stderr).toContain("flyway migrate");
  });

  test("apply-pending is refused", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    const { code, stderr } = await captureStderr(() => run([
      "migrate", "apply-pending", "--cwd", root, "--dialect", "sqlite", "--migration-format", "flyway",
    ]));
    expect(code).toBe(2);
    expect(stderr).toContain("apply-pending is not supported with --migration-format flyway");
  });

  test("--rollback is refused, pointing at flyway undo", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    const { code, stderr } = await captureStderr(() => run([
      "migrate", "--cwd", root, "--dialect", "sqlite", "--migration-format", "flyway",
      "--rollback", "V1",
    ]));
    expect(code).toBe(2);
    expect(stderr).toContain("--rollback is not supported with --migration-format flyway");
    expect(stderr).toContain("flyway undo");
  });

  test("--dialect d1 with --migration-format flyway is refused", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    const { code, stderr } = await captureStderr(() => run([
      "migrate", "--cwd", root, "--dialect", "d1", "--migration-format", "flyway", "--slug", "x",
    ]));
    expect(code).toBe(2);
    expect(stderr).toContain("--migration-format flyway is not supported for dialect 'd1'");
  });
});

// ---------------------------------------------------------------------------
// Emit layout
// ---------------------------------------------------------------------------

describe("migrate --migration-format flyway — emit", () => {
  test("writes V1__/U1__ into Flyway's conventional dir", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    await runBaseline(cfg({ format: "flyway" }), root);
    await rewrite(root, '[{"field.string":{"name":"ref"}},{"field.string":{"name":"note"}}]');

    expect(await runOfflineGenerate(cfg({ format: "flyway", slug: "add_note" }), root)).toBe(0);

    const dir = join(root, "src", "main", "resources", "db", "migration");
    expect(visible(await readdir(dir))).toEqual(["U1__add_note.sql", "V1__add_note.sql"]);
  });

  test("a second change advances to V2__ past the existing V1__", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    await runBaseline(cfg({ format: "flyway" }), root);

    await rewrite(root, '[{"field.string":{"name":"ref"}},{"field.string":{"name":"note"}}]');
    expect(await runOfflineGenerate(cfg({ format: "flyway", slug: "add_note" }), root)).toBe(0);

    await rewrite(root, '[{"field.string":{"name":"ref"}},{"field.string":{"name":"note"}},{"field.string":{"name":"tag"}}]');
    expect(await runOfflineGenerate(cfg({ format: "flyway", slug: "add_tag" }), root)).toBe(0);

    const dir = join(root, "src", "main", "resources", "db", "migration");
    expect(visible(await readdir(dir))).toEqual([
      "U1__add_note.sql", "U2__add_tag.sql", "V1__add_note.sql", "V2__add_tag.sql",
    ]);
  });

  test("--out-dir overrides the convention dir", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    await runBaseline(cfg({ format: "flyway", outDir: "db/mig" }), root);
    await rewrite(root, '[{"field.string":{"name":"ref"}},{"field.string":{"name":"note"}}]');

    expect(await runOfflineGenerate(cfg({ format: "flyway", outDir: "db/mig", slug: "init" }), root)).toBe(0);
    expect(visible(await readdir(join(root, "db", "mig")))).toEqual(["U1__init.sql", "V1__init.sql"]);
  });

  test("default format is unchanged — per-migration dir, no V__ files", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    await runBaseline(cfg(), root);
    await rewrite(root, '[{"field.string":{"name":"ref"}},{"field.string":{"name":"note"}}]');

    expect(await runOfflineGenerate(cfg({ slug: "add_note" }), root)).toBe(0);

    const entries = visible(await readdir(join(root, ".metaobjects", "migrations")));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.startsWith("V1__")).toBe(false);
    expect(entries[0]!.endsWith("-add-note")).toBe(true);
  });
});
