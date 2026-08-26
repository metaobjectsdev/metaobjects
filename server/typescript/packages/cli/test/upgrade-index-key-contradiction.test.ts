// `meta upgrade` closing the loop on #342: an index declaring BOTH `@fields` and `@expr`.
//
// The unit tests prove each rewriter arm edits the right span. THIS proves the thing an
// adopter actually needs, which neither of those can: metadata that DOES NOT LOAD before
// the run LOADS after it. That is the whole contract of `meta upgrade`, and the reason the
// pair is worth automating rather than refusing — a refusal would leave every estate on the
// 0.24.1 line hand-editing files the tool can fix.
//
// Both arms get the round trip. The estate that surfaced the gap was YAML, and the JSON arm
// and the YAML arm share no code below `attr-contradictions.ts` — a fix in one proves
// nothing about the other.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import { upgradeCommand } from "../src/commands/upgrade.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function project(filename: string, body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-upgrade-idx-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", filename), body, "utf8");
  return root;
}

/** The loader's verdict, as a plain message list — "" entries mean it loaded. */
async function loadErrors(root: string): Promise<string[]> {
  try {
    await loadMemory(root, { strict: true });
    return [];
  } catch (err) {
    return [(err as Error).message];
  }
}

// One entity, two keyed children: the contradicting expression index, and a plain
// column index whose `@fields` must survive. A fixer that took both would swap a load
// error for a different one ("declares no key") and look like it had worked.
const JSON_ESTATE = `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": {
          "name": "Account",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "email" } },
            { "field.string": { "name": "region" } },
            { "source.rdb": { "@table": "accounts" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            { "index.lookup": {
                "name": "byEmailLower",
                "@fields": ["email"],
                "@expr": "lower(email)"
            }},
            { "index.lookup": { "name": "byRegion", "@fields": ["region"] } }
          ]
      }}
    ]
  }
}`;

const YAML_ESTATE = `metadata.root:
  package: acme::shop
  children:
    - object.entity:
        name: Account
        children:
          - field.long:
              name: id
          - field.string:
              name: email
          - field.string:
              name: region
          - source.rdb:
              table: accounts
          - identity.primary:
              name: pk
              fields:
                - id
          - index.lookup:
              name: byEmailLower
              fields:
                - email
              expr: lower(email)
          - index.lookup:
              name: byRegion
              fields:
                - region
`;

describe("the estate does not load until it is upgraded", () => {
  test("JSON: refused before, loads after --apply, and keeps the sibling's key", async () => {
    const root = await project("meta.json", JSON_ESTATE);

    const before = await loadErrors(root);
    expect(before).toHaveLength(1);
    expect(before[0]).toContain("declares BOTH");
    // The error must carry its own way out — an adopter who is only told the metadata is
    // invalid concludes the tool is broken (#337).
    expect(before[0]).toContain("meta upgrade --apply");

    expect(await upgradeCommand([root, "--apply"], root)).toBe(0);

    expect(await loadErrors(root)).toHaveLength(0);
    const loaded = await loadMemory(root, { strict: true });
    const account = loaded.children().find((c) => c.name === "Account");
    const kids = account?.children() ?? [];
    const byEmail = kids.find((c) => c.name === "byEmailLower");
    const byRegion = kids.find((c) => c.name === "byRegion");
    expect(byEmail?.attr("expr")).toBe("lower(email)");
    expect(byEmail?.attr("fields")).toBeUndefined();
    // The sibling was never in contradiction; taking its key would have been a new bug
    // wearing the old one's clothes.
    expect(byRegion?.attr("fields")).toEqual(["region"]);
  });

  test("YAML: refused before, loads after --apply, and keeps the sibling's key", async () => {
    const root = await project("meta.yaml", YAML_ESTATE);

    const before = await loadErrors(root);
    expect(before).toHaveLength(1);
    expect(before[0]).toContain("declares BOTH");

    expect(await upgradeCommand([root, "--apply"], root)).toBe(0);

    expect(await loadErrors(root)).toHaveLength(0);
    const loaded = await loadMemory(root, { strict: true });
    const kids = loaded.children().find((c) => c.name === "Account")?.children() ?? [];
    expect(kids.find((c) => c.name === "byEmailLower")?.attr("expr")).toBe("lower(email)");
    expect(kids.find((c) => c.name === "byEmailLower")?.attr("fields")).toBeUndefined();
    expect(kids.find((c) => c.name === "byRegion")?.attr("fields")).toEqual(["region"]);
  });

  test("PREVIEWS by default — the estate still does not load until --apply", async () => {
    const root = await project("meta.json", JSON_ESTATE);
    expect(await upgradeCommand([root], root)).toBe(0);
    expect(await loadErrors(root)).toHaveLength(1);
  });
});
