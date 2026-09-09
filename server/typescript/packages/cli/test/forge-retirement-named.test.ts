// The 1.0 migration promised `meta upgrade --apply` would strip the `@forge*` attributes.
// It did nothing: no entry existed in RETIRED_VOCABULARY, so the command reported
// "nothing to rewrite (1 file(s) checked)", exit 0, over a project carrying nine such
// nodes. A migration instruction that silently does nothing is worse than one that
// refuses — the adopter believes the migration finished.
//
// The fix is NOT an automated strip. That vocabulary still loads for a project that opts
// the provider back in (the chartered ADR-0023 path), so a rewrite would destroy valid
// metadata for exactly the adopters who chose it deliberately. So the entries carry no
// `rewrite`, which is the map's existing way of saying the fix is judgment: the command
// names every occurrence, prints the reason and both options, and exits non-zero.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const META = {
  "metadata.root": {
    package: "acme",
    children: [{
      "object.entity": {
        name: "Order", "@forgeConfidence": "high", "@forgeSource": "an interview",
        children: [
          { "source.rdb": { "@table": "orders" } },
          { "field.long": { name: "id", "@forgeRationale": "surrogate" } },
          { "identity.primary": { "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
};

async function upgrade(args: string[]): Promise<{ exit: number; err: string }> {
  const dir = await mkdtemp(join(tmpdir(), "forge-retire-"));
  dirs.push(dir);
  await mkdir(join(dir, "metaobjects"), { recursive: true });
  await writeFile(join(dir, "metaobjects", "meta.json"), JSON.stringify(META), "utf8");
  const lines: string[] = [];
  const oe = console.error, ol = console.log;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { exit: await run(["upgrade", "--cwd", dir, ...args]), err: lines.join("\n") }; }
  finally { console.error = oe; console.log = ol; }
}

describe("meta upgrade and the deregistered @forge* vocabulary", () => {
  test("names every occurrence and exits non-zero — not 'nothing to rewrite'", async () => {
    const { exit, err } = await upgrade([]);
    expect(exit).toBe(1);
    for (const attr of ["@forgeConfidence", "@forgeSource", "@forgeRationale"]) {
      expect(err).toContain(attr);
    }
    expect(err).not.toContain("nothing to rewrite (1 file(s) checked)");
  });

  test("--apply does not rewrite them — the strip would destroy valid metadata", async () => {
    const { exit, err } = await upgrade(["--apply"]);
    expect(exit).toBe(1);
    expect(err).toContain("needs a decision");
  });

  test("the message carries the reason AND both options, not just a guide link", async () => {
    // It used to print `Retired in <since>. See <guide>`, dropping `why` whenever a guide
    // existed — which is almost always — and dropping `replacedBy` unconditionally. For
    // this entry that removed the only actionable sentence there is.
    const { err } = await upgrade([]);
    expect(err).toContain("expected-registry.json");           // the why
    expect(err).toContain("forgeTypesProvider");                // keep them
    expect(err).toContain("or delete them");                    // or don't
    expect(err).toContain("0.x-to-1.0.md");                     // the guide
    // And it does not announce the retirement of something that still works elsewhere.
    expect(err).toContain("no longer accepted as of");
  });

  test("the retirement is scoped to EVERY type, because it was a common attr", async () => {
    // `@forgeConfidence` sits on an object here and `@forgeRationale` on a field. A
    // per-type entry list would cover whichever types someone thought of; the type
    // wildcard is what makes the row match the way the registration did.
    const { err } = await upgrade([]);
    expect(err).toContain("@forgeConfidence");   // on object.entity
    expect(err).toContain("@forgeRationale");    // on field.long
  });
});

// ── the wall ──────────────────────────────────────────────────────────────────
//
// An adopter estate hit this with 24 `@forge*` occurrences. Every one printed the same
// three lines — the `why`, the keep-them option, the delete-them option, the guide — so
// the output was ~96 lines saying one thing four times over, and the instruction was
// buried in its own repetition. That is exactly the failure `runGen`'s no-manifest
// refusal aggregates to avoid, in a command that had not learned it.
//
// Occurrences are per-line information and stay per line. The RATIONALE is per RULE, and
// prints once.
describe("many occurrences of one retirement", () => {
  const MANY = {
    "metadata.root": {
      package: "acme",
      children: ["A", "B", "C", "D"].map((n) => ({
        "object.entity": {
          name: n, "@forgeConfidence": "high", "@forgeSource": "an interview",
          children: [
            { "source.rdb": { "@table": n.toLowerCase() } },
            { "field.long": { name: "id" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      })),
    },
  };

  async function upgradeMany(): Promise<{ exit: number; err: string }> {
    const dir = await mkdtemp(join(tmpdir(), "forge-wall-"));
    dirs.push(dir);
    await mkdir(join(dir, "metaobjects"), { recursive: true });
    await writeFile(join(dir, "metaobjects", "meta.json"), JSON.stringify(MANY), "utf8");
    const lines: string[] = [];
    const oe = console.error, ol = console.log;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try { return { exit: await run(["upgrade", "--cwd", dir]), err: lines.join("\n") }; }
    finally { console.error = oe; console.log = ol; }
  }

  test("every occurrence is still named", async () => {
    const { exit, err } = await upgradeMany();
    expect(exit).toBe(1);
    // 4 entities × 2 attributes = 8 occurrence lines.
    expect(err.split("\n").filter((l) => l.includes("needs a decision"))).toHaveLength(8);
  });

  test("the reason and the options print ONCE, not once per occurrence", async () => {
    const { err } = await upgradeMany();
    const count = (needle: string): number => err.split("\n").filter((l) => l.includes(needle)).length;
    expect(count("expected-registry.json")).toBe(1);   // the why
    expect(count("forgeTypesProvider")).toBe(1);       // keep them
    expect(count("0.x-to-1.0.md")).toBe(1);            // the guide
  });

  test("the rationale names which attributes it is about", async () => {
    // Printed away from the occurrence lines, it has to say what it applies to — or the
    // reader has to guess which of the refusals the paragraph belongs to.
    const { err } = await upgradeMany();
    const idx = err.indexOf("expected-registry.json");
    const paragraph = err.slice(Math.max(0, idx - 400), idx);
    expect(paragraph).toContain("@forgeConfidence");
  });
});
