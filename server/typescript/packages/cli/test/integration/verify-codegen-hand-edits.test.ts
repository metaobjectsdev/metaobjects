/**
 * `verify --codegen` must not convict a hand edit the product told you to make.
 *
 * Design: spec/design-docs/2026-08-27-codegen-drift-hand-edits-design.md
 *
 * `meta gen` preserves hand edits through a three-way merge and reports "merged" —
 * the documented contract. Before this, `verify --codegen` byte-compared committed
 * output against a fresh regen, so the same edit read as drift, and the remedy it
 * printed ("Run 'meta gen' to regenerate") could not work: gen merges and preserves
 * the edit again, so the next verify failed identically. An unbreakable loop for
 * anyone doing the sanctioned thing.
 *
 * The discriminator is `.gen-state/.hashes.json`, which records what the GENERATOR
 * WROTE (not what the file became) and is committed while the snapshot bodies are
 * not — the split exists so this question is answerable on a machine that did not
 * generate the output.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

const OUT = "generated";
const USER_TS = join(OUT, "User.ts");

function setupRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-verify-hand-edits-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, OUT))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
  );
  return root;
}

/** The sanctioned move: hand-edit inside a generated file. */
function handEdit(root: string): void {
  appendFileSync(
    join(root, USER_TS),
    "\n// hand-written, preserved by three-way merge\nexport const HAND_EDIT = 1;\n",
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

const all = (): string => [...out, ...err].join("\n");

describe("meta verify --codegen — hand-edited generated output", () => {
  test("a preserved hand edit is not drift", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      handEdit(root);

      // gen keeps it — the contract this test exists to stop verify contradicting.
      out = []; err = [];
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(all()).toContain("merged");
      expect(readFileSync(join(root, USER_TS), "utf8")).toContain("HAND_EDIT");

      out = []; err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      expect(all()).not.toContain("User.ts");
      expect(exit).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hand edit does not mask real drift in the same file", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      handEdit(root);
      expect(await run(["gen", "--cwd", root])).toBe(0);

      // Change the metadata and do NOT re-run gen: the generated contribution is
      // now stale, which is drift regardless of the hand edit sitting beside it.
      const metaPath = join(root, "metaobjects", "myapp.json");
      writeFileSync(
        metaPath,
        readFileSync(metaPath, "utf8").replace('"@maxLength": 255', '"@maxLength": 128'),
      );

      out = []; err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      expect(all()).toContain("User.ts");
      expect(exit).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the printed remedy terminates instead of looping", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      handEdit(root);
      expect(await run(["gen", "--cwd", root])).toBe(0);

      const metaPath = join(root, "metaobjects", "myapp.json");
      writeFileSync(
        metaPath,
        readFileSync(metaPath, "utf8").replace('"@maxLength": 255', '"@maxLength": 128'),
      );
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);

      // "Run 'meta gen' to regenerate, then commit the result" — and it must stick.
      expect(await run(["gen", "--cwd", root])).toBe(0);
      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(0);
      // The edit survived the remedy; that is why the loop existed.
      expect(readFileSync(join(root, USER_TS), "utf8")).toContain("HAND_EDIT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when there is no recorded hash to judge by", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      handEdit(root);
      expect(await run(["gen", "--cwd", root])).toBe(0);

      // No manifest ⇒ nothing is proven ⇒ the old, conservative verdict stands.
      const manifest = join(root, ".metaobjects", ".gen-state", ".hashes.json");
      expect(existsSync(manifest)).toBe(true);
      rmSync(manifest);

      out = []; err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      expect(all()).toContain("User.ts");
      expect(exit).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an extra committed file is still drift — only the content branch changed", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      writeFileSync(join(root, OUT, "Stray.ts"), "export const stray = 1;\n");

      out = []; err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      expect(all()).toContain("Stray.ts");
      expect(exit).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
