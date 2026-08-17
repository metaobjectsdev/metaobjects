// The scenario this whole mechanism exists for, driven end to end through runGen.
//
// A teammate clones the repo. The generated output is committed; the `.gen-state`
// snapshot BODIES are gitignored so they are absent; `.gen-state/.hashes.json` is
// committed so it is present. One generated file carries a hand edit — the
// `leadingWildcard: true` change the docs explicitly tell adopters to make inside a
// generated allowlist. They run `meta gen`.
//
// Before this change, that run silently replaced the edit and reported the file as
// NEW. The unit tests cover the decision; this covers the wiring, because a correct
// decision that runGen never reaches is worth nothing — which is exactly how the
// orphan mechanism shipped inert earlier in this branch.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/generators/index.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), "fresh-clone-")); });
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

const genStateDir = (): string => join(projectRoot, ".metaobjects", ".gen-state");

async function gen(opts: { baselineFresh?: boolean } = {}) {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  return runGen({
    config: defineConfig({
      outDir: join(projectRoot, "generated"),
      extStyle: "none",
      dbImport: "~/server/db",
      dialect: "sqlite",
      generators: [entityFile()],
    }),
    metadata: root,
    projectRoot,
    ...(opts.baselineFresh === true && { baseline: "fresh" as const }),
  });
}

/** Delete every snapshot body but keep `.hashes.json` — what a clone actually has,
 *  given the gitignore `meta init` now scaffolds. */
function simulateFreshClone(): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); rmSync(full, { recursive: true, force: true }); }
      else if (entry !== ".hashes.json" && entry !== ".engine.json") rmSync(full, { force: true });
    }
  };
  walk(genStateDir());
  expect(existsSync(join(genStateDir(), ".hashes.json"))).toBe(true);
}

describe("regen on a fresh clone: hashes committed, bodies absent", () => {
  test("an untouched generated file still regenerates, and is not reported as NEW", async () => {
    await gen();
    const target = join(projectRoot, "generated", "Post.ts");
    const original = readFileSync(target, "utf-8");
    simulateFreshClone();

    // Make the file diverge the way a formatter or engine bump would: still exactly
    // what we recorded writing, but not what a fresh render produces now.
    writeFileSync(target, original);
    const result = await gen();

    const post = result.files.find((f) => f.path.endsWith("Post.ts"));
    expect(post).toBeDefined();
    // The common case must NOT refuse, or a clean checkout stalls on every file.
    expect(["unchanged", "overwrite"]).toContain(post!.status);
  });

  test("a HAND-EDITED generated file is refused, and the edit survives", async () => {
    await gen();
    const target = join(projectRoot, "generated", "Post.ts");
    simulateFreshClone();

    // The edit the docs tell adopters to make inside a generated file.
    const edited = readFileSync(target, "utf-8") + "\n// leadingWildcard: true\n";
    writeFileSync(target, edited);

    const result = await gen();
    const post = result.files.find((f) => f.path.endsWith("Post.ts"));

    expect(post?.status).toBe("refused");
    expect(readFileSync(target, "utf-8")).toBe(edited);
    // Named, with an actionable reason — an unexplained refusal gets the file
    // deleted by hand, which is what refusing exists to prevent.
    const warning = result.warnings.find((w) => w.includes("Post.ts"));
    expect(warning).toBeDefined();
    expect(warning).toContain("--baseline=fresh");
  });

  test("--baseline=fresh is the documented way through, and it works", async () => {
    await gen();
    const target = join(projectRoot, "generated", "Post.ts");
    simulateFreshClone();
    writeFileSync(target, "// my edit\n");

    const result = await gen({ baselineFresh: true });
    const post = result.files.find((f) => f.path.endsWith("Post.ts"));

    expect(post?.status).toBe("overwrite");
    expect(readFileSync(target, "utf-8")).not.toContain("my edit");
  });

  test("with no manifest at all it still fails closed, for a different reason", async () => {
    // The state every project whose .gitignore still reads `.gen-state/` is in. Here
    // there is no hash to compare against, so "is this ours?" is unanswerable rather
    // than answered no — and unanswerable must also mean refuse, or the migration
    // window would be a window in which edits get eaten.
    await gen();
    const target = join(projectRoot, "generated", "Post.ts");
    simulateFreshClone();
    rmSync(join(genStateDir(), ".hashes.json"), { force: true });
    writeFileSync(target, "// my edit\n");

    const result = await gen();
    const post = result.files.find((f) => f.path.endsWith("Post.ts"));

    // Refused rather than silently overwritten — we fail closed with no record at
    // all — so the edit survives either way, but for a different reason.
    expect(post?.status).toBe("refused");
    expect(readFileSync(target, "utf-8")).toBe("// my edit\n");
  });
});
