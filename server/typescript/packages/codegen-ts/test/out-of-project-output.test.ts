// Output written OUTSIDE the project root has no place in the project's gen-state.
//
// The manifest keys every generated file by its path relative to the project root, so a
// target whose outDir is outside the project (a scratch preview, a sibling checkout) was
// recorded as `../../<elsewhere>/X.ts` in the COMMITTED `.hashes.json` — 87 such keys on
// one adopter estate after a single preview run. Worse, the snapshot body is stored at
// `<gen-state>/<key>`, so the `../..` walked out of `.gen-state/` and wrote a second full
// copy of the output into the project tree itself.
//
// Such a file is now written untracked, exactly as a run with no project root writes it:
// no manifest key, no snapshot under the project, and one warning saying so.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/generators/entity-file.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let projectRoot: string;
let elsewhere: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "oop-project-"));
  elsewhere = mkdtempSync(join(tmpdir(), "oop-elsewhere-"));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

async function genInto(outDir: string) {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  return runGen({
    config: defineConfig({
      outDir,
      extStyle: "none",
      dbImport: "~/server/db",
      dialect: "sqlite",
      generators: [entityFile()],
    }),
    metadata: root,
    projectRoot,
  });
}

const hashesFile = (): string => join(projectRoot, ".metaobjects", ".gen-state", ".hashes.json");

describe("output outside the project root", () => {
  test("is written, but recorded nowhere in the project", async () => {
    const out = join(elsewhere, "preview");
    const result = await genInto(out);

    expect(readdirSync(out).length).toBeGreaterThan(0);
    const keys = existsSync(hashesFile()) ? Object.keys(JSON.parse(readFileSync(hashesFile(), "utf-8"))) : [];
    expect(keys.filter((k) => k.startsWith(".."))).toEqual([]);
    // Nothing but the (possibly absent) gen-state directory appeared in the project.
    expect(readdirSync(projectRoot).filter((e) => e !== ".metaobjects")).toEqual([]);
    expect(result.warnings.some((w) => w.includes("outside the project"))).toBe(true);
  });

  test("output inside the project is still tracked", async () => {
    await genInto(join(projectRoot, "generated"));
    const keys = Object.keys(JSON.parse(readFileSync(hashesFile(), "utf-8")));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("generated/"))).toBe(true);
  });

  // Untracked means NO record — so the second run found an existing file it had "no record
  // of generating" and REFUSED it, while the warning above promised the opposite ("a later
  // run overwrites them without checking for edits"). An adopter whose shared-types target
  // sits at `../shared/src/generated` could not regenerate at all without --baseline=fresh.
  test("a later run overwrites it, as the warning says, instead of refusing", async () => {
    const out = join(elsewhere, "shared");
    await genInto(out);
    const file = join(out, readdirSync(out).find((f) => f.endsWith(".ts"))!);
    writeFileSync(file, "// stale output from an older generator\n");
    const again = await genInto(out);
    expect(again.files.filter((f) => f.status === "refused")).toEqual([]);
    expect(readFileSync(file, "utf-8")).not.toContain("stale output");
  });
});

