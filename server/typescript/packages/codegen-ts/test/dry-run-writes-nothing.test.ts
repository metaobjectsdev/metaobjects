// `meta gen --dry-run` must touch nothing on disk.
//
// The flag existed in the CLI's *display* object and was never passed to `runGen`, so a
// "preview" run wrote every file exactly like a real one — while the website, `meta init`'s
// next-steps and the CLI help all described it as "preview without writing". A fresh
// adopter found it the obvious way: deleted a generated file, ran `--dry-run`, and watched
// it come back.
//
// These assert on the FILESYSTEM, not on the returned report — the report was always
// plausible; the disk was the thing that disagreed with it.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/reference/entity.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Post",
          children: [
            { "source.rdb": { "@table": "posts" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "title", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "meta-dryrun-"));
  dirs.push(d);
  return d;
}

async function gen(root: string, dryRun: boolean) {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(loaded.errors).toEqual([]);
  return runGen({
    config: defineConfig({
      outDir: join(root, "generated"),
      dialect: "postgres",
      dbImport: "../db",
      extStyle: "js",
      generators: [entityFile()],
    }),
    metadata: loaded.root,
    projectRoot: root,
    dryRun,
  });
}

describe("meta gen --dry-run", () => {
  test("writes NO output files and creates no .gen-state, but still reports them", async () => {
    const root = scratch();
    const result = await gen(root, true);

    // It must still tell you what it would do — a silent preview is useless.
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.some((f) => f.path.endsWith("Post.ts"))).toBe(true);

    // …and nothing may exist on disk.
    expect(existsSync(join(root, "generated"))).toBe(false);
    expect(existsSync(join(root, ".metaobjects", ".gen-state"))).toBe(false);
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });

  test("a dry run does not resurrect a deleted generated file (the reported symptom)", async () => {
    const root = scratch();
    await gen(root, false); // real run — creates it
    const postPath = join(root, "generated", "Post.ts");
    expect(existsSync(postPath)).toBe(true);

    rmSync(postPath);
    await gen(root, true); // preview — must NOT bring it back
    expect(existsSync(postPath)).toBe(false);
  });

  test("a dry run never modifies an existing generated file", async () => {
    const root = scratch();
    await gen(root, false);
    const postPath = join(root, "generated", "Post.ts");

    const sentinel = "// hand-edited sentinel\n";
    writeFileSync(postPath, sentinel);
    await gen(root, true);
    expect(readFileSync(postPath, "utf8")).toBe(sentinel);
  });

  test("the default (no dryRun) still writes — the fix must not disable real runs", async () => {
    const root = scratch();
    await gen(root, false);
    expect(existsSync(join(root, "generated", "Post.ts"))).toBe(true);
    expect(existsSync(join(root, ".metaobjects", ".gen-state"))).toBe(true);
  });
});
