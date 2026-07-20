/**
 * #225 — `meta verify --dialect d1` schema-drift gate.
 *
 * D1 has no client wire protocol, so it can't go through the Kysely-driver
 * introspection path `verify --db` uses for sqlite/postgres. This exercises
 * the wrangler-shelled-out path instead, via a FAKE D1Runner (mirrors
 * `cli/test/unit/migrate-d1.test.ts`'s mock pattern) — no real wrangler binary
 * or network access required.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRANGLER_TOML = [
  `name = "test-app"`,
  ``,
  `[[d1_databases]]`,
  `binding = "DB"`,
  `database_name = "test-db"`,
  `database_id = "test-id"`,
].join("\n");

/** A D1Runner that answers every wrangler query with an empty result set. */
function emptyDbRunner(calls: string[][]) {
  return async (args: string[], _cwd: string) => {
    calls.push(args);
    const cmdIdx = args.indexOf("--command");
    const sql = cmdIdx >= 0 ? args[cmdIdx + 1] ?? "" : "";
    if (sql.includes("sqlite_version")) {
      return { stdout: JSON.stringify([{ success: true, results: [{ v: "3.44.2" }] }]), stderr: "" };
    }
    return { stdout: JSON.stringify([{ success: true, results: [] }]), stderr: "" };
  };
}

describe("meta verify --dialect d1 — schema-drift gate", () => {
  let dir: string;
  let cwdBefore: string;
  let out: string[];
  let err: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-d1-cmd-"));
    cwdBefore = process.cwd();
    process.chdir(dir);
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
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty metadata + empty D1 (mock) → schema in sync, exit 0", async () => {
    writeFileSync(join(dir, "wrangler.toml"), WRANGLER_TOML);
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.empty.json"), JSON.stringify({
      "metadata.root": { package: "test::empty", children: [] },
    }));

    const calls: string[][] = [];
    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand(["--dialect", "d1"], dir, emptyDbRunner(calls));
    expect(code).toBe(0);
    const all = [...out, ...err].join("\n");
    expect(all).toContain("schema in sync");
  });

  test("one entity + empty D1 (mock, missing table) → drift → exit 1, table name printed", async () => {
    writeFileSync(join(dir, "wrangler.toml"), WRANGLER_TOML);
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.users.json"), JSON.stringify({
      "metadata.root": {
        package: "test::users",
        children: [{
          "object.entity": {
            name: "User",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "email" } },
              { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        }],
      },
    }));

    const calls: string[][] = [];
    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand(["--dialect", "d1"], dir, emptyDbRunner(calls));
    expect(code).toBe(1);
    const all = [...out, ...err].join("\n");
    expect(all).toContain("schema drift");
    expect(all).toContain("users");
  });

  test("--remote threads --remote (not --local) into the wrangler args", async () => {
    writeFileSync(join(dir, "wrangler.toml"), WRANGLER_TOML);
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.empty.json"), JSON.stringify({
      "metadata.root": { package: "test::empty", children: [] },
    }));

    const calls: string[][] = [];
    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand(["--dialect", "d1", "--remote"], dir, emptyDbRunner(calls));
    expect(code).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("--remote");
      expect(call).not.toContain("--local");
    }
  });

  test("errors when wrangler.toml is missing and --d1 is not supplied → exit 2", async () => {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.empty.json"), JSON.stringify({
      "metadata.root": { package: "test::empty", children: [] },
    }));

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand(["--dialect", "d1"], dir);
    expect(code).toBe(2);
  });

  test("errors when --db is supplied together with --dialect d1 → exit 2", async () => {
    writeFileSync(join(dir, "wrangler.toml"), WRANGLER_TOML);
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.empty.json"), JSON.stringify({
      "metadata.root": { package: "test::empty", children: [] },
    }));

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand(["--dialect", "d1", "--db", "file:foo.db"], dir);
    expect(code).toBe(2);
    const all = [...out, ...err].join("\n");
    expect(all).toContain("--db");
  });
});
