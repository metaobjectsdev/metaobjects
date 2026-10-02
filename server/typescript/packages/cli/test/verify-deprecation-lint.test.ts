// `meta verify` — the deprecated-reference authoring lint (#305), end to end:
// printed as its own advisory section, carried in full in the structured payload,
// never reaching the exit code, and muted by its own flag/env pair the way every
// sibling advisory is.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A `Match` entity whose `homeTeamRef` points at `Team`, which carries
 *  `@deprecated` (and `@replacedBy` when `replacedBy` is given). */
function project(replacedBy?: string): string {
  const root = mkdtempSync(join(tmpdir(), "vdl-"));
  dirs.push(root);
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }));
  writeFileSync(join(root, "metaobjects", "meta.app.json"), JSON.stringify({
    "metadata.root": {
      package: "app",
      children: [
        {
          "object.entity": {
            name: "Team",
            "@deprecated": "the league no longer tracks teams",
            ...(replacedBy !== undefined ? { "@replacedBy": replacedBy } : {}),
            children: [
              { "source.rdb": { "@table": "teams" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Match",
            children: [
              { "source.rdb": { "@table": "matches" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "homeTeamId" } },
              {
                "identity.reference": {
                  name: "homeTeamRef",
                  "@fields": ["homeTeamId"],
                  "@references": "Team",
                },
              },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
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

const FINDING_CODE = "WARN_DEPRECATED_REFERENCE";
const FINDING_PATH = "app::Match.homeTeamRef";

describe("meta verify — the deprecated-reference authoring lint", () => {
  test("a reference onto a deprecated entity is an advisory finding in text output, exit 0", async () => {
    const exit = await run(["verify", "--format", "text", "--cwd", project()]);
    expect(exit).toBe(0);
    const all = [...out, ...err].join("\n");
    expect(all).toContain("meta verify — deprecations: 1 reference(s) to a deprecated node (advisory — does not fail the build):");
    expect(all).toContain(FINDING_CODE);
    expect(all).toContain(FINDING_PATH);
    expect(all).toContain("the league no longer tracks teams");
    expect(all).not.toContain("Replaced by");
  });

  test("replacedBy, when present, is named in the finding", async () => {
    const exit = await run(["verify", "--format", "text", "--cwd", project("app::RetiredTeam")]);
    expect(exit).toBe(0);
    const all = [...out, ...err].join("\n");
    expect(all).toContain("Replaced by app::RetiredTeam.");
  });

  test("the structured payload carries the finding in its own `deprecations` section", async () => {
    const exit = await run(["verify", "--format", "json", "--cwd", project()]);
    expect(exit).toBe(0);
    const payload = JSON.parse(out.join("\n")) as {
      deprecations: { status: string; total: number; rows: { code: string; path: string; source: string }[] };
      summary: string;
    };
    expect(payload.deprecations.status).toBe("ran");
    expect(payload.deprecations.total).toBe(1);
    expect(payload.deprecations.rows[0]).toMatchObject({
      code: FINDING_CODE,
      path: FINDING_PATH,
      source: "lint",
    });
    expect(payload.summary).toContain("1 deprecated-reference finding(s)");
  });

  test("a model with no @deprecated anywhere reports nothing and the section still says it ran", async () => {
    const root = mkdtempSync(join(tmpdir(), "vdl-clean-"));
    dirs.push(root);
    mkdirSync(join(root, "metaobjects"), { recursive: true });
    mkdirSync(join(root, ".metaobjects"), { recursive: true });
    writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }));
    writeFileSync(join(root, "metaobjects", "meta.app.json"), JSON.stringify({
      "metadata.root": {
        package: "app",
        children: [
          {
            "object.entity": {
              name: "Widget",
              children: [
                { "source.rdb": { "@table": "widgets" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    }));
    const exit = await run(["verify", "--format", "json", "--cwd", root]);
    expect(exit).toBe(0);
    const payload = JSON.parse(out.join("\n")) as { deprecations: { status: string; total: number } };
    expect(payload.deprecations).toMatchObject({ status: "ran", total: 0 });
  });

  test("--no-deprecation-lint silences it", async () => {
    const exit = await run(["verify", "--format", "text", "--cwd", project(), "--no-deprecation-lint"]);
    expect(exit).toBe(0);
    expect([...out, ...err].join("\n")).not.toContain(FINDING_CODE);
  });

  test("META_NO_DEPRECATION_LINT=1 silences it", async () => {
    const prev = process.env.META_NO_DEPRECATION_LINT;
    process.env.META_NO_DEPRECATION_LINT = "1";
    try {
      expect(await run(["verify", "--format", "text", "--cwd", project()])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.META_NO_DEPRECATION_LINT;
      else process.env.META_NO_DEPRECATION_LINT = prev;
    }
    expect([...out, ...err].join("\n")).not.toContain(FINDING_CODE);
  });
});
