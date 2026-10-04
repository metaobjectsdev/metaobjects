// `meta verify` — the field authoring lint, end to end: printed as its own advisory
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

/** A project whose `Item` references `Owner` through `referenceField`, and declares
 *  `label` once or twice. */
function project(referenceField: string, duplicateLabel: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "vfl-"));
  dirs.push(root);
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }));
  const label = { "field.string": { name: "label" } };
  writeFileSync(join(root, "metaobjects", "meta.app.json"), JSON.stringify({
    "metadata.root": {
      package: "app",
      children: [
        {
          "object.entity": {
            name: "Owner",
            children: [
              { "source.rdb": { "@table": "owners" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Item",
            children: [
              { "source.rdb": { "@table": "items" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "ownerId" } },
              label,
              ...(duplicateLabel ? [label] : []),
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
              { "identity.reference": { name: "owner_fk", "@fields": [referenceField], "@references": "Owner" } },
            ],
          },
        },
      ],
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

describe("meta verify — the field authoring lint", () => {
  test("both findings are advisory in text output, exit 0", async () => {
    const exit = await run(["verify", "--format", "text", "--cwd", project("ownerIdd", true)]);
    expect(exit).toBe(0);
    const all = [...out, ...err].join("\n");
    expect(all).toContain("meta verify — fields: 2 authoring warning(s) (advisory — does not fail the build):");
    expect(all).toContain("WARN_REFERENCE_FIELD_NOT_FOUND [app::Item.owner_fk]");
    expect(all).toContain("WARN_DUPLICATE_FIELD_NAME [app::Item.label]");
  });

  test("the structured payload carries the findings in their own `fields` section", async () => {
    const exit = await run(["verify", "--format", "json", "--cwd", project("ownerIdd", true)]);
    expect(exit).toBe(0);
    const payload = JSON.parse(out.join("\n")) as {
      fields: { status: string; total: number; rows: { code: string; path: string; source: string }[] };
      summary: string;
    };
    expect(payload.fields.status).toBe("ran");
    expect(payload.fields.rows.map((r) => [r.code, r.path, r.source])).toEqual([
      ["WARN_REFERENCE_FIELD_NOT_FOUND", "app::Item.owner_fk", "lint"],
      ["WARN_DUPLICATE_FIELD_NAME", "app::Item.label", "lint"],
    ]);
    expect(payload.summary).toContain("2 field authoring finding(s)");
  });

  test("a clean model reports nothing and the section still says it ran", async () => {
    const exit = await run(["verify", "--format", "json", "--cwd", project("ownerId", false)]);
    expect(exit).toBe(0);
    const payload = JSON.parse(out.join("\n")) as { fields: { status: string; total: number } };
    expect(payload.fields).toMatchObject({ status: "ran", total: 0 });
  });

  test("--no-field-lint silences it", async () => {
    const exit = await run(["verify", "--format", "text", "--cwd", project("ownerIdd", true), "--no-field-lint"]);
    expect(exit).toBe(0);
    const all = [...out, ...err].join("\n");
    expect(all).not.toContain("WARN_REFERENCE_FIELD_NOT_FOUND");
    expect(all).not.toContain("WARN_DUPLICATE_FIELD_NAME");
  });

  test("META_NO_FIELD_LINT=1 silences it", async () => {
    const prev = process.env.META_NO_FIELD_LINT;
    process.env.META_NO_FIELD_LINT = "1";
    try {
      expect(await run(["verify", "--format", "text", "--cwd", project("ownerIdd", true)])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.META_NO_FIELD_LINT;
      else process.env.META_NO_FIELD_LINT = prev;
    }
    expect([...out, ...err].join("\n")).not.toContain("WARN_REFERENCE_FIELD_NOT_FOUND");
  });
});
