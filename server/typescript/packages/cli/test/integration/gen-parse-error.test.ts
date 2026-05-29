// Fix 3: `meta gen` must NOT mask a real ParseError as the "no metaobjects/
// found" scaffold hint. A ParseError message can legitimately contain "no such"
// (e.g. `origin.@via "X.y" ...: no such relationship "y" on X`) — the old
// catch-all matched on that substring and reported the scaffold hint instead,
// costing real debug time. The scaffold hint must fire ONLY when the
// metaobjects/ directory genuinely does not exist.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

function setupRepoWithParseError(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-parseerr-"));
  const metaDir = join(root, "metaobjects");
  mkdirSync(metaDir, { recursive: true });

  // A projection whose origin.@via points at a relationship that does not
  // exist on the base entity → loader emits a ParseError whose message
  // contains the substring "no such".
  const badMeta = {
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Program",
            children: [
              { "source.rdb": { "@table": "programs" } },
              { "field.int": { name: "id" } },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "ProgramSummary",
            extends: "Program",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
              {
                "field.int": {
                  name: "weekCount",
                  children: [
                    { "origin.aggregate": { "@agg": "count", "@of": "Program.id", "@via": "Program.doesNotExist" } },
                  ],
                },
              },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
      ],
    },
  };
  writeFileSync(join(metaDir, "acme.json"), JSON.stringify(badMeta, null, 2));

  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated", "db"))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
  );
  return root;
}

describe("meta gen — does not mask ParseErrors", () => {
  test("surfaces the real ParseError message, not the scaffold hint", async () => {
    const root = setupRepoWithParseError();
    const stderr: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { stderr.push(String(args[0])); };
    try {
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(2);
      const joined = stderr.join("\n");
      // The real ParseError must surface…
      expect(joined).toContain("no such relationship");
      expect(joined).toContain("doesNotExist");
      // …and the scaffold hint must NOT (metaobjects/ exists here).
      expect(joined).not.toContain("run 'meta init' to scaffold");
    } finally {
      console.error = origError;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
