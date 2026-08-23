/**
 * #340 — a sub-project GENERATES from its own sources, not from the union of every
 * tree an ancestor `.metaobjects/config.json` declares.
 *
 * The gen-side remainder of #326/#327. Once source resolution learned to walk upward,
 * a package whose `metaobjects.config.ts` sits below the collection root began loading
 * the ancestor's entire source set: one adopter's web app went from 376 generated
 * files to 831, the surplus being another module's server-side prompt payload DTOs
 * that the app will never construct. It fails OPEN — `tsc` passes, tests pass — so the
 * only symptom is a directory that quietly doubled, which is why it needs a gate
 * rather than a reader.
 *
 * The rule under test: an ancestor collection is the DEFAULT for a package that
 * declares no sources, never an ADDITION to one that does. Both arms matter — the
 * second is what keeps a package that legitimately lives off an ancestor tree working.
 */
import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
// Temp dirs live inside the monorepo so jiti can resolve @metaobjectsdev/* when it
// loads metaobjects.config.ts (same rationale as gen-nested-gen-config.test.ts).
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

function genConfigBody(outDir: string): string {
  return `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(outDir)},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`;
}

/** An entity that exists ONLY in the unrelated tree, so its output is unambiguous. */
const OTHER_TREE_ENTITY = JSON.stringify({
  "metadata.root": {
    package: "other",
    children: [
      {
        "object.entity": {
          name: "AbilityGenerationPayload",
          children: [
            { "source.rdb": { "@table": "ability_generation_payloads" } },
            { "field.uuid": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id", "@generation": "uuid" } },
          ],
        },
      },
    ],
  },
});

describe("meta gen — a sub-project's own sources govern its output (#340)", () => {
  test("does NOT absorb an unrelated tree the ancestor collection also declares", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-subscope-"));
    try {
      // The app: its own metadata AND its own TS config.
      const app = join(root, "app");
      mkdirSync(app, { recursive: true });
      cpSync(join(FIXTURES, "trainer-website-meta"), app, { recursive: true });
      const outDir = join(app, "generated", "db");
      writeFileSync(join(app, "metaobjects.config.ts"), genConfigBody(outDir));

      // A sibling module's tree, which has no business in the app's output.
      mkdirSync(join(root, "other", "metaobjects"), { recursive: true });
      writeFileSync(join(root, "other", "metaobjects", "meta.other.json"), OTHER_TREE_ENTITY, "utf8");

      // The repo root declares BOTH — the port-neutral "where does metadata live"
      // answer for a polyglot monorepo, which is exactly what it is for.
      mkdirSync(join(root, ".metaobjects"), { recursive: true });
      writeFileSync(
        join(root, ".metaobjects", "config.json"),
        JSON.stringify({
          schema_version: 1,
          sources: [{ path: "app/metaobjects" }, { path: "other/metaobjects" }],
        }),
        "utf8",
      );

      const exit = await run(["gen", "--cwd", app]);
      expect(exit).toBe(0);
      // The app's own entity is generated, as always.
      expect(existsSync(join(outDir, "User.ts"))).toBe(true);
      // ...and the sibling module's is not. Before the fix this file was emitted
      // into the app's generated tree.
      expect(existsSync(join(outDir, "AbilityGenerationPayload.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The counter-arm. Narrowing must never strand a package that has no sources of its
  // own — for that one, the ancestor collection is still the answer, and #326's shape
  // (a TS config below a collection root) is precisely that package.
  test("a sub-project with NO sources of its own still inherits the ancestor's", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "forge-gen-subscope-inherit-"));
    try {
      // All metadata lives at the root, in a tree the app does not contain.
      cpSync(join(FIXTURES, "trainer-website-meta"), join(root, "shared"), { recursive: true });
      mkdirSync(join(root, ".metaobjects"), { recursive: true });
      writeFileSync(
        join(root, ".metaobjects", "config.json"),
        JSON.stringify({ schema_version: 1, sources: [{ path: "shared/metaobjects" }] }),
        "utf8",
      );

      // The app carries a TS config and nothing else.
      const app = join(root, "app");
      mkdirSync(app, { recursive: true });
      const outDir = join(app, "generated", "db");
      writeFileSync(join(app, "metaobjects.config.ts"), genConfigBody(outDir));

      const exit = await run(["gen", "--cwd", app]);
      expect(exit).toBe(0);
      expect(existsSync(join(outDir, "User.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
