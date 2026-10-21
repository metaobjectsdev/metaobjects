/**
 * `verify --codegen` may only convict files MetaObjects actually wrote.
 *
 * The gate's orphan branch ("committed but regen would not emit it") used to fire
 * on EVERY file in `outDir` a fresh regen does not produce — including files
 * MetaObjects has never written. The documented TypeScript quickstart creates
 * exactly those: it tells you to typecheck with `npx tsc`, and a stock
 * `tsc --init` config has no `outDir`, so the compiler drops `.js` / `.d.ts` /
 * `.map` siblings next to the generated sources. Following the quickstart to the
 * letter therefore ended in `verify --codegen` exiting 1 on a project with no
 * drift of any kind, naming sixteen files it does not own.
 *
 * The rule is JURISDICTION, not staleness: `.gen-state/.hashes.json` records what
 * the generator WROTE, and `meta gen`'s own orphan sweep already scopes itself to
 * those paths (`listGeneratedPaths`) before it will delete anything. The gate now
 * asks the same question of the same evidence, so the two doors agree.
 *
 * What this does NOT give up: a file MetaObjects wrote and a regen no longer
 * emits (an entity deleted or renamed) is still recorded in the manifest, so it
 * is still drift. And with NO manifest at all there is no evidence to tell ours
 * from a stranger's, so the old, conservative verdict stands — the same
 * fail-closed default the content branch uses.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

const OUT = "generated";
const MANIFEST = join(".metaobjects", ".gen-state", ".hashes.json");

function setupRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-verify-foreign-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, OUT))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
`,
  );
  return root;
}

/** What `npx tsc` leaves beside the generated sources with a stock tsconfig. */
function compileInPlace(root: string): void {
  for (const base of ["User", "Post", "Tag"]) {
    writeFileSync(join(root, OUT, `${base}.js`), "export const compiled = 1;\n");
    writeFileSync(join(root, OUT, `${base}.d.ts`), "export declare const compiled: number;\n");
    writeFileSync(join(root, OUT, `${base}.js.map`), "{}\n");
    writeFileSync(join(root, OUT, `${base}.d.ts.map`), "{}\n");
  }
}

/** Drop an entity so a regen stops emitting the file it already wrote. */
function deleteTagEntity(root: string): void {
  const metaPath = join(root, "metaobjects", "myapp.json");
  const doc = JSON.parse(readFileSync(metaPath, "utf8")) as {
    "metadata.root": { children: Record<string, { name?: string }>[] };
  };
  doc["metadata.root"].children = doc["metadata.root"].children.filter(
    (child) => child["object.entity"]?.name !== "Tag",
  );
  writeFileSync(metaPath, JSON.stringify(doc, null, 2));
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

describe("meta verify --codegen — files MetaObjects never wrote", () => {
  test("compiler output beside the generated sources is not drift", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      compileInPlace(root);

      out = []; err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      for (const emitted of ["User.js", "User.d.ts", "Post.js.map", "Tag.d.ts.map"]) {
        expect(all()).not.toContain(emitted);
      }
      expect(exit).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hand-written file in outDir is not the gate's business", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      writeFileSync(join(root, OUT, "Stray.ts"), "export const stray = 1;\n");

      out = []; err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      expect(all()).not.toContain("Stray.ts");
      expect(exit).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a file we DID write that a regen no longer emits is still drift", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(existsSync(join(root, OUT, "Tag.ts"))).toBe(true);
      deleteTagEntity(root);

      out = []; err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      expect(all()).toContain("Tag.ts");
      expect(exit).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the remedy works: meta gen deletes the untouched orphan and the gate goes green", async () => {
    // The loop this closes: the gate convicted `Tag.ts` and said "run 'meta gen'", and
    // gen never deleted anything, so the gate failed identically after every run.
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      deleteTagEntity(root);

      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);
      expect(all()).toContain("'meta gen' deletes it");

      out = []; err = [];
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(existsSync(join(root, OUT, "Tag.ts"))).toBe(false);
      expect(readFileSync(join(root, MANIFEST), "utf8")).not.toContain("Tag.ts");

      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hand-edited orphan is refused by gen, and the gate says to delete it", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      writeFileSync(join(root, OUT, "Tag.ts"), `${readFileSync(join(root, OUT, "Tag.ts"), "utf8")}// mine\n`);
      deleteTagEntity(root);

      out = []; err = [];
      await run(["gen", "--cwd", root]);
      expect(existsSync(join(root, OUT, "Tag.ts"))).toBe(true);
      expect(all()).toContain("NOT deleted");

      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);
      expect(all()).toContain("edited by hand: delete it");
      expect(all()).toContain("'meta gen' will NOT delete them");
      expect(all()).not.toContain("Run 'meta gen' to regenerate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("handEdits: overwrite — the gate calls an edit drift that gen fixes, and gen fixes it", async () => {
    const root = setupRepo();
    try {
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
  generators: [{ ...entityFile(), handEdits: "overwrite" }],
});
`,
      );
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const tag = join(root, OUT, "Tag.ts");
      writeFileSync(tag, `${readFileSync(tag, "utf8")}// mine\n`);

      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);
      expect(all()).toContain(`handEdits: "overwrite"`);
      expect(all()).toContain("Run 'meta gen' to regenerate");

      out = []; err = [];
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(all()).toContain("overwrote hand-edited");
      expect(readFileSync(tag, "utf8")).not.toContain("// mine");

      // An edited orphan of an overwriting generator is deleted, not refused.
      writeFileSync(tag, `${readFileSync(tag, "utf8")}// mine\n`);
      deleteTagEntity(root);
      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);
      expect(all()).toContain("so 'meta gen' deletes it");
      expect(all()).not.toContain("will NOT delete");
      out = []; err = [];
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(existsSync(tag)).toBe(false);
      expect(all()).toContain("deleted hand-edited");

      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("with no manifest at all, the old conservative verdict stands", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      writeFileSync(join(root, OUT, "Stray.ts"), "export const stray = 1;\n");

      // No records ⇒ nothing distinguishes our stale output from a stranger's
      // file, so the gate keeps convicting rather than going quiet.
      expect(existsSync(join(root, MANIFEST))).toBe(true);
      rmSync(join(root, MANIFEST));

      out = []; err = [];
      const exit = await run(["verify", "--cwd", root, "--codegen"]);
      expect(all()).toContain("Stray.ts");
      expect(exit).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
