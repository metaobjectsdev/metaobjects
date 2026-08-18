import { describe, test, expect, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { genCommand } from "../src/commands/gen.js";
import { run } from "../src/index.js";

// Place temp dirs inside the monorepo so metaobjects.config.ts's
// `@metaobjectsdev/*` imports resolve the same way the existing
// integration/gen-sqlite.test.ts fixtures do.
const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures/__tmp__");

function genOutDir(root: string): string {
  return join(root, "generated", "db");
}

describe("gen routes metadata discovery through resolveCollection", () => {
  test("generates from a sources-declared tree with no metaobjects/ present anywhere", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "collection-routing-"));
    try {
      mkdirSync(join(root, ".git"));

      // Metadata lives OUTSIDE the app directory entirely — under `model/`,
      // not `metaobjects/` — and nowhere under `apps/ui`.
      mkdirSync(join(root, "model"), { recursive: true });
      writeFileSync(
        join(root, "model", "meta.a.json"),
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              {
                "object.entity": {
                  name: "Order",
                  children: [
                    { "source.rdb": { "@table": "orders" } },
                    { "field.long": { name: "id", "@column": "id" } },
                    {
                      "identity.primary": {
                        name: "pk",
                        "@fields": ["id"],
                        "@generation": "increment",
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      );

      // The app's config declares its own metadata source — a relative path
      // outside the app dir — instead of relying on a `metaobjects/` default.
      mkdirSync(join(root, "apps", "ui", ".metaobjects"), { recursive: true });
      writeFileSync(
        join(root, "apps", "ui", ".metaobjects", "config.json"),
        JSON.stringify({
          schema_version: 1,
          sources: [{ path: "../../model" }],
        }),
      );

      const appRoot = join(root, "apps", "ui");
      writeFileSync(
        join(appRoot, "metaobjects.config.ts"),
        `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(genOutDir(appRoot))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
      );

      const code = await genCommand([], appRoot);
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The probe in `run()` answers "is this a MetaObjects project?" through
// `resolveCollection`. What it PRINTS has to agree: a project whose config
// points `sources` at a sibling module has no directory of the default name at
// all, so "metaobjects/ found" is simply false — and a directory that resolves
// nothing may be failing on a declared source rather than on a missing default.
// Naming a directory in either message re-asserts the assumption the routing
// removed.
describe("the no-args project probe says what resolved, never a directory name", () => {
  /** Run the CLI with no command and return everything it wrote to stdout. */
  async function statusOf(dir: string): Promise<string> {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      expect(await run(["--cwd", dir])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  test("a project whose sources point elsewhere is not told a directory was found", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "probe-declared-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "model"), { recursive: true });
      writeFileSync(
        join(root, "model", "meta.a.json"),
        JSON.stringify({
          "metadata.root": { package: "acme", children: [{ "object.entity": { name: "Order" } }] },
        }),
      );
      mkdirSync(join(root, "apps", "ui", ".metaobjects"), { recursive: true });
      writeFileSync(
        join(root, "apps", "ui", ".metaobjects", "config.json"),
        JSON.stringify({ schema_version: 1, sources: [{ path: "../../model" }] }),
      );

      const out = await statusOf(join(root, "apps", "ui"));
      expect(out).toContain("metadata found");
      expect(out).not.toContain("metaobjects/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory with no project names no directory either", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "probe-empty-"));
    try {
      mkdirSync(join(root, ".git"));
      const out = await statusOf(root);
      expect(out).toContain("no MetaObjects project here");
      // Including the next-step line: `meta init` scaffolds a project, and the
      // layout it writes is its own business to describe, not this probe's.
      expect(out).not.toContain("metaobjects/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
