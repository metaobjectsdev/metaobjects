// The `requirements` docs surface — the generator that emits both artifacts.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md §5, §6
//
// THE EMPTY-LEDGER CASE IS THE LOAD-BEARING TEST HERE, not an edge case. Task 6 turns
// this surface ON BY DEFAULT, and that is only safe because a project declaring no
// `requirement.*` node gets NO file — not an empty page. If this test ever goes green
// while emitting a headed-but-empty document, every existing project's `meta docs` grows
// a file it did not ask for.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaRoot, MetaObject } from "@metaobjectsdev/metadata";
import { requirementsFile } from "../src/generators/requirements-file.js";
import type { GenContext } from "../src/generator.js";

const WITH_LEDGER = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "source.rdb": { "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "requirement.functional": {
          name: "checkout",
          "@level": 2,
          "@status": "live",
          "@statement": "A shopper can pay for a basket.",
          "@violation": "A basket that cannot be paid for.",
          children: [
            {
              "requirement.functional": {
                name: "capture",
                "@level": 4,
                "@status": "live",
                "@statement": "An order records what was captured.",
                "@violation": "An order that cannot say what was charged.",
                "@implementedBy": ["acme::shop::Order"],
              },
            },
          ],
        },
      },
    ],
  },
};

const NO_LEDGER = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "source.rdb": { "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

async function loadRoot(model: unknown): Promise<MetaRoot> {
  const r = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model)),
  ]);
  if (r.errors.length > 0) {
    throw new Error(`Loader errors:\n${r.errors.map((e) => e.message).join("\n")}`);
  }
  return r.root as MetaRoot;
}

/** A minimal GenContext. `meta docs` is contractually metadata-alone, so this generator
 *  must work from `loadedRoot` and nothing else — a context carrying no config at all is
 *  the honest harness for that, and it would fail loudly if a config read crept in. */
async function ctxFor(model: unknown): Promise<GenContext> {
  const loadedRoot = await loadRoot(model);
  return {
    entities: [] as MetaObject[],
    loadedRoot,
    matches: () => true,
  } as unknown as GenContext;
}

describe("requirementsFile()", () => {
  test("emits BOTH artifacts for a project with a ledger", async () => {
    const files = await requirementsFile().generate(await ctxFor(WITH_LEDGER));
    expect(files.map((f) => f.path).sort()).toEqual([
      "requirements.md",
      "requirements.toon",
    ]);
  });

  test("the markdown carries the ledger's nesting", async () => {
    const files = await requirementsFile().generate(await ctxFor(WITH_LEDGER));
    const md = files.find((f) => f.path === "requirements.md")?.content ?? "";
    expect(md).toContain("## checkout");
    expect(md).toContain("### checkout.capture");
  });

  test("the TOON declares the row count", async () => {
    const files = await requirementsFile().generate(await ctxFor(WITH_LEDGER));
    const toon = files.find((f) => f.path === "requirements.toon")?.content ?? "";
    expect(toon).toContain("requirements[2]");
  });

  // §6 rule 2. This is what makes the default-on decision in task 6 a no-op for every
  // project without requirements — not an empty page, NO page.
  test("emits NOTHING — zero files — when the project declares no requirements", async () => {
    const files = await requirementsFile().generate(await ctxFor(NO_LEDGER));
    expect(files).toEqual([]);
  });

  test("honours an outDir prefix without changing the filenames", async () => {
    const files = await requirementsFile({ outDir: "ledger" }).generate(await ctxFor(WITH_LEDGER));
    expect(files.map((f) => f.path).sort()).toEqual([
      "ledger/requirements.md",
      "ledger/requirements.toon",
    ]);
  });
});
