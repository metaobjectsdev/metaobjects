/**
 * Task 12b, requirement 3 / design §7 open question 3: `verify --codegen` must
 * regenerate under the SAME `collection.scope` `meta gen` used to produce the
 * committed output — otherwise every out-of-scope entity reads as drift (regen
 * would try to emit it; it was never committed because `meta gen` never emitted
 * it either).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

function genOutDir(root: string): string {
  return join(root, "generated", "db");
}

/** trainer-website-meta declares User/Post/Tag, all in package "trainerWebsite". */
function setupRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-verify-codegen-scope-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(genOutDir(root))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
  );
  return root;
}

function declareScope(repo: string, include: string[]): void {
  mkdirSync(join(repo, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(repo, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, scope: { include } }),
    "utf8",
  );
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

describe("meta verify --codegen — collection scope", () => {
  test("reports no drift for out-of-scope entities the scoped gen never committed", async () => {
    const root = setupRepo();
    try {
      declareScope(root, ["trainerWebsite::Post"]);

      // `meta gen` under the scope commits ONLY Post.ts.
      expect(await run(["gen", "--cwd", root])).toBe(0);

      // `verify --codegen` must regenerate under the identical scope — if it
      // regenerated unscoped, User.ts/Tag.ts would appear in the fresh tree
      // but not the committed one, reading as drift on entities this scope
      // deliberately excludes.
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      const all = [...out, ...err].join("\n");
      expect(exit).toBe(0);
      expect(all).not.toContain("User.ts");
      expect(all).not.toContain("Tag.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
