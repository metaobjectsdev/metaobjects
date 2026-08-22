// `meta upgrade` end-to-end, against real files on disk.
//
// The unit tests prove the rewriter transforms text. These prove the COMMAND does the right
// thing to a project: previews without writing, writes only under --apply, and — the one
// that matters for CI — exits NON-ZERO while any refusal stands, so a partial upgrade
// cannot be recorded as a finished one.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeCommand } from "../src/commands/upgrade.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function project(meta: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-upgrade-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), meta, "utf8");
  return root;
}

const WITH_RETIRED = `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "orderRecord",
          "@level": 4,
          "@status": "live",
          "@statement": "An order records what was bought",
          "@counterexample": "An order that cannot say what was bought",
          "@verifiedBy": ["OrderServiceTest"]
      }}
    ]
  }
}`;

const NEEDS_DECISION = `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "oldThing",
          "@level": 4,
          "@status": "abandoned",
          "@statement": "Something we stopped doing",
          "@counterexample": "n/a"
      }}
    ]
  }
}`;

const CLEAN = `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "orderRecord",
          "@level": 4,
          "@status": "live",
          "@statement": "An order records what was bought",
          "@counterexample": "An order that cannot say what was bought"
      }}
    ]
  }
}`;

describe("meta upgrade", () => {
  test("PREVIEWS without writing by default", async () => {
    const root = await project(WITH_RETIRED);
    const code = await upgradeCommand([root], root);
    expect(code).toBe(0);
    // Untouched on disk — the default must never edit committed files.
    expect(await readFile(join(root, "metaobjects", "meta.json"), "utf8")).toBe(WITH_RETIRED);
  });

  test("--apply rewrites the file", async () => {
    const root = await project(WITH_RETIRED);
    expect(await upgradeCommand([root, "--apply"], root)).toBe(0);
    const after = await readFile(join(root, "metaobjects", "meta.json"), "utf8");
    expect(after).not.toContain("@verifiedBy");
    // Everything else survives, byte-for-byte in the untouched regions.
    expect(after).toContain('"@statement": "An order records what was bought"');
    expect(after).toContain('"name": "orderRecord"');
  });

  test("a project with nothing retired exits 0 and is untouched", async () => {
    const root = await project(CLEAN);
    expect(await upgradeCommand([root, "--apply"], root)).toBe(0);
    expect(await readFile(join(root, "metaobjects", "meta.json"), "utf8")).toBe(CLEAN);
  });

  // The CI-facing contract. A refusal means the metadata still will not load, so exiting 0
  // would let a pipeline record the migration as complete while the build is broken.
  test("EXITS NON-ZERO when a decision is still required", async () => {
    const root = await project(NEEDS_DECISION);
    expect(await upgradeCommand([root, "--apply"], root)).toBe(1);
    // And leaves the judgment case alone rather than guessing.
    expect(await readFile(join(root, "metaobjects", "meta.json"), "utf8")).toContain('"abandoned"');
  });

  test("--to bounds which retirements apply", async () => {
    const root = await project(WITH_RETIRED);
    // @verifiedBy retired in 0.24.0, so a 0.23.0 ceiling must leave it alone.
    expect(await upgradeCommand([root, "--to", "0.23.0", "--apply"], root)).toBe(0);
    expect(await readFile(join(root, "metaobjects", "meta.json"), "utf8")).toContain("@verifiedBy");
  });

  test("rejects an unknown flag with exit 2", async () => {
    const root = await project(CLEAN);
    expect(await upgradeCommand([root, "--nope"], root)).toBe(2);
  });
});
