/**
 * A column the model RENAMED (title → summary, names too far apart for the rename
 * heuristic to pair) reaches `meta migrate` as a blocked drop-column plus an add-column in
 * the same table. The hint used to recommend only `--allow drop-column`, which deletes the
 * column and every value in it. Every hint on that shape now names the declared rename
 * FIRST, spelled with the real names, and presents `--allow drop-column` as the explicitly
 * data-losing alternative.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaseline, runOfflineGenerate, MIGRATE_HELP_TEXT } from "../src/commands/migrate.js";
import { formatMigrateResult, migrateResultToData, type MigrateResultShape } from "../src/lib/output.js";
import { blockedEntriesFor } from "../src/lib/allow.js";
import type { Change } from "@metaobjectsdev/migrate-ts";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const ENTITY = (col: string) => ({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "Issue",
        children: [
          { "field.long": { name: "id" } },
          { "field.string": { name: col, "@required": true, "@maxLength": 200 } },
          { "source.rdb": { name: "src", "@table": "issues" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

async function write(root: string, col: string): Promise<void> {
  await writeFile(join(root, "metaobjects", "meta.issues.json"), JSON.stringify(ENTITY(col)), "utf8");
}

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const code = await fn();
    return { code, err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

const cfg = { dialect: "sqlite", outDir: "./.metaobjects/migrations", onAmbiguous: "abort", allow: [], renames: [], slug: "rename", dryRun: true } as const;

describe("meta migrate — a pairable drop+add recommends the declared rename first", () => {
  test("offline path names --rename-column issues.title=summary before --allow drop-column", async () => {
    const root = await mkdtemp(join(tmpdir(), "mts-rename-hint-"));
    dirs.push(root);
    await mkdir(join(root, "metaobjects"), { recursive: true });
    await write(root, "title");
    expect(await runBaseline({ ...cfg, dryRun: false, fromDb: false } as never, root)).toBe(0);
    await write(root, "summary");

    const { code, err } = await captureStderr(() => runOfflineGenerate(cfg as never, root));
    expect(code).toBe(1);
    const renameAt = err.indexOf("--rename-column issues.title=summary");
    const dropAt = err.indexOf("--allow drop-column");
    expect(renameAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThan(renameAt);
    expect(err).toMatch(/--allow drop-column[^\n]*(DELETES|deletes)[^\n]*data/);
  });

  const drop: Change = {
    kind: "drop-column", table: "issues", column: "title",
    status: { state: "blocked", blockedReason: "destructive" },
  };
  const add: Change = {
    kind: "add-column", table: "issues",
    column: { name: "summary", sqlType: { kind: "text" }, nullable: false },
    status: { state: "allowed" },
  };
  const unrelated: Change = {
    kind: "drop-table", table: "legacy", status: { state: "blocked", blockedReason: "destructive" },
  };

  const result = (): MigrateResultShape => ({
    dialect: "sqlite", displayUrl: "file:x.db", changeCounts: { "drop-column": 1, "add-column": 1 },
    blocked: blockedEntriesFor([drop, unrelated], [drop, add, unrelated]),
    ambiguous: [], writtenPaths: [], dryRun: false,
  });

  test("text output (the --from-db / --db path) puts the rename ahead of the data-losing flag", () => {
    const out = formatMigrateResult(result(), { isTTY: false });
    expect(out).toContain("--rename-column issues.title=summary");
    expect(out.indexOf("--rename-column issues.title=summary")).toBeLessThan(out.indexOf("--allow drop-column"));
    expect(out).toMatch(/--allow drop-column[^\n]*(DELETES|deletes)/);
    // An unpaired blocked change keeps its plain allow hint.
    expect(out).toContain("--allow drop-table");
  });

  test("toon/json help lists the rename first", () => {
    const { help } = migrateResultToData(result());
    expect(help[0]).toContain("--rename-column issues.title=summary");
    expect(help[0]).toMatch(/--allow drop-column[^;]*(DELETES|deletes)/);
  });

  test("a non-default schema is spelled into the flag", () => {
    const d = { ...drop, schema: "app" } as Change;
    const a = { ...add, schema: "app" } as Change;
    const [e] = blockedEntriesFor([d], [d, a]);
    expect(e!.renameFlag).toBe("--rename-column app.issues.title=summary");
  });

  test("--help says drop-column deletes data and points at --rename-column", () => {
    expect(MIGRATE_HELP_TEXT).toMatch(/drop-column[\s\S]{0,200}--rename-column/);
  });
});
