// `meta verify` — the node-name authoring lint, end to end: printed as its own advisory
// section, carried in full in the structured payload, never reaching the exit code, and
// muted by its own flag/env pair the way every sibling advisory is.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(fieldName: string): string {
  const root = mkdtempSync(join(tmpdir(), "vnl-"));
  dirs.push(root);
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }));
  writeFileSync(join(root, "metaobjects", "meta.app.json"), JSON.stringify({
    "metadata.root": {
      package: "app",
      children: [{
        "object.entity": {
          name: "Account",
          children: [
            { "source.rdb": { "@table": "accounts" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: fieldName } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      }],
    },
  }));
  return root;
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

const FINDING = 'WARN_NAME_SURROUNDING_WHITESPACE [app::Account."defaultCurrencyId "]';

describe("meta verify — the node-name authoring lint", () => {
  test("a trailing-space field is an advisory finding in text output, exit 0", async () => {
    const exit = await run(["verify", "--format", "text", "--cwd", project("defaultCurrencyId ")]);
    expect(exit).toBe(0);
    const all = [...out, ...err].join("\n");
    expect(all).toContain("meta verify — names: 1 authoring warning(s) (advisory — does not fail the build):");
    expect(all).toContain(FINDING);
  });

  test("the structured payload carries the finding in its own `names` section", async () => {
    const exit = await run(["verify", "--format", "json", "--cwd", project("defaultCurrencyId ")]);
    expect(exit).toBe(0);
    const payload = JSON.parse(out.join("\n")) as {
      names: { status: string; total: number; rows: { code: string; path: string; source: string }[] };
      summary: string;
    };
    expect(payload.names.status).toBe("ran");
    expect(payload.names.total).toBe(1);
    expect(payload.names.rows[0]).toMatchObject({
      code: "WARN_NAME_SURROUNDING_WHITESPACE",
      path: 'app::Account."defaultCurrencyId "',
      source: "lint",
    });
    expect(payload.summary).toContain("1 name authoring finding(s)");
  });

  test("a clean model reports nothing and the section still says it ran", async () => {
    const exit = await run(["verify", "--format", "json", "--cwd", project("defaultCurrencyId")]);
    expect(exit).toBe(0);
    const payload = JSON.parse(out.join("\n")) as { names: { status: string; total: number } };
    expect(payload.names).toMatchObject({ status: "ran", total: 0 });
  });

  test("--no-name-lint silences it", async () => {
    const exit = await run(["verify", "--format", "text", "--cwd", project("defaultCurrencyId "), "--no-name-lint"]);
    expect(exit).toBe(0);
    expect([...out, ...err].join("\n")).not.toContain("WARN_NAME_");
  });

  test("META_NO_NAME_LINT=1 silences it", async () => {
    const prev = process.env.META_NO_NAME_LINT;
    process.env.META_NO_NAME_LINT = "1";
    try {
      expect(await run(["verify", "--format", "text", "--cwd", project("defaultCurrencyId ")])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.META_NO_NAME_LINT;
      else process.env.META_NO_NAME_LINT = prev;
    }
    expect([...out, ...err].join("\n")).not.toContain("WARN_NAME_");
  });
});
