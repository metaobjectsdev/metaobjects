// The `@violation` → `@counterexample` rename, end to end through `meta upgrade`.
//
// This is the rename's own migration path, so it has to work on the ONE input that matters:
// a ledger written against the previous release, which the current loader now refuses. If
// this breaks, every adopter's migration is a hand sweep.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { upgradeCommand } from "../src/commands/upgrade.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// A 0.24-era ledger: nesting, several entries, comments an adopter would have written.
const OLD_LEDGER = `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "Storefront",
          "@level": 1,
          "@status": "live",
          "@statement": "The storefront solution",
          "@violation": "Nothing can be sold",
          "children": [
            { "requirement.functional": {
                "name": "OrderRecord",
                "@level": 4,
                "@status": "live",
                "@statement": "An order records what was bought",
                "@violation": "An order that cannot say what was bought"
            }}
          ]
      }}
    ]
  }
}`;

describe("@violation → @counterexample", () => {
  test("the old ledger does NOT load — the retirement is real", async () => {
    const r = await new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(OLD_LEDGER),
    ]);
    expect(r.errors.length).toBeGreaterThan(0);
    const msg = r.errors.map((e) => e.message).join("\n");
    expect(msg).toContain("@violation");
    // The error carries the rename and the guide, so an adopter is never left guessing.
    expect(msg).toContain("@counterexample");
    expect(msg).toContain("violation-to-counterexample");
  });

  test("`meta upgrade --apply` migrates it, and the result LOADS", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-rename-"));
    dirs.push(root);
    await mkdir(join(root, "metaobjects"), { recursive: true });
    const file = join(root, "metaobjects", "meta.json");
    await writeFile(file, OLD_LEDGER, "utf8");

    expect(await upgradeCommand([root, "--apply"], root)).toBe(0);

    const after = await readFile(file, "utf8");
    expect(after).not.toContain("@violation");
    expect(after).toContain('"@counterexample": "Nothing can be sold"');
    expect(after).toContain('"@counterexample": "An order that cannot say what was bought"');

    // The assertion that matters: the migrated document loads clean. A rewrite that
    // produced plausible-looking text which still failed would be worse than no tool.
    const r = await new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(after),
    ]);
    expect(r.errors.map((e) => e.message).join("\n")).toBe("");
  });
});
