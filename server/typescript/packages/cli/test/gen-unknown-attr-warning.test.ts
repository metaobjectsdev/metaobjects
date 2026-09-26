// `meta gen` loads leniently, `meta verify` strictly (ADR-0023). An unknown attribute —
// a bare `isAbstrakt: true` meant as `abstract`, a misspelt `@requird` — used to pass
// `gen` without a word while `verify` rejected the same file with ERR_UNKNOWN_ATTR, and
// the typo silently changed the output (the "abstract" base got a table of its own).
// `gen` now names each finding — attribute, node and file — as a warning, and keeps its
// exit code.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

function model(opts: { typos: boolean }): string {
  return JSON.stringify({
    "metadata.root": {
      package: "app",
      children: [
        {
          "object.entity": {
            name: "BaseThing",
            ...(opts.typos ? { isAbstrakt: true } : { abstract: true }),
            children: [{ "field.long": { name: "id" } }],
          },
        },
        {
          "object.entity": {
            name: "Talk",
            extends: "BaseThing",
            children: [
              { "source.rdb": { "@table": "talks" } },
              { "field.string": { name: "title", ...(opts.typos ? { "@requird": true } : { "@required": true }) } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
}

function setupRepo(opts: { typos: boolean }): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "gen-unknown-attr-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), model(opts), "utf8");
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }), "utf8");
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated"))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
`,
  );
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

describe("meta gen — unknown attributes are warned about, not swallowed", () => {
  test("each unknown attribute is named with its node and file; exit code unchanged", async () => {
    const root = setupRepo({ typos: true });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const stderr = err.join("\n");
      expect(stderr).toContain("ERR_UNKNOWN_ATTR");
      expect(stderr).toContain("isAbstrakt");
      expect(stderr).toContain("BaseThing");
      expect(stderr).toContain("@requird");
      expect(stderr).toContain("title");
      expect(stderr).toContain("meta.app.json");
      expect(stderr).toContain("meta verify");
      // Printed relative to the project, never as the machine's absolute path.
      expect(stderr).not.toContain(join(root, "metaobjects"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the structured output carries the same warnings", async () => {
    const root = setupRepo({ typos: true });
    try {
      expect(await run(["gen", "--cwd", root, "--format", "json"])).toBe(0);
      const payload = JSON.parse(out.join("\n")) as { warnings?: string[] };
      expect(payload.warnings?.some((w) => w.includes("@requird"))).toBe(true);
      expect(payload.warnings?.some((w) => w.includes("isAbstrakt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a clean model prints no unknown-attribute warning", async () => {
    const root = setupRepo({ typos: false });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(err.join("\n")).not.toContain("ERR_UNKNOWN_ATTR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
