// rc.19 (R57; fix round M4) — `naming.collections` in `.metaobjects/config.json` selects the
// pluralizer, through the same reader every project load goes through: an unknown name is
// refused when the file is read, a built-in or an application's own is carried onto the
// loaded root, and the collection names and REST segments follow it. Nothing configured, the
// segment is rc.18's.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectionNameOf, collectionSegment, registerPluralizer, resetNamingStrategiesForTesting, type MetaRoot,
} from "@metaobjectsdev/metadata";
import { loadMemory } from "../src/memory.js";
import { DEFAULT_METADATA_DIR } from "../src/metadata-files.js";

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "mo-collections-"));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  resetNamingStrategiesForTesting();
});

function write(naming: Record<string, unknown> | undefined): void {
  mkdirSync(join(project, ".metaobjects"), { recursive: true });
  writeFileSync(join(project, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, ...(naming !== undefined ? { naming } : {}) }));
  mkdirSync(join(project, DEFAULT_METADATA_DIR), { recursive: true });
  writeFileSync(join(project, DEFAULT_METADATA_DIR, "meta.acme.json"), JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "FAQ", children: [
      { "source.rdb": { "@table": "faqs" } },
      { "field.long": { name: "id" } },
      { "identity.primary": { "@fields": "id" } },
    ] } },
  ] } }));
}

const faq = (root: MetaRoot) => root.objects().find((o) => o.name === "FAQ")!;

describe("naming.collections, read from .metaobjects/config.json", () => {
  test("nothing configured: the standard collection name, and rc.18's segment", async () => {
    write(undefined);
    const root = await loadMemory(project);
    expect(collectionNameOf(faq(root))).toBe("FAQs");
    expect(collectionSegment(faq(root))).toBe("faqs");
  });

  test("a built-in is carried onto the loaded root", async () => {
    write({ collections: "none" });
    const root = await loadMemory(project);
    expect(root.physicalNaming.collections).toBe("none");
    expect(collectionNameOf(faq(root))).toBe("FAQ");
    expect(collectionSegment(faq(root))).toBe("faq");
  });

  test("an application's own pluralizer, registered before the load", async () => {
    registerPluralizer("listing", (n) => n + "List");
    write({ collections: "listing" });
    const root = await loadMemory(project);
    expect(collectionNameOf(faq(root))).toBe("FAQList");
    expect(collectionSegment(faq(root))).toBe("faq_list");
  });

  test("an unknown name is refused when the file is read, naming the built-ins", async () => {
    write({ collections: "klingon" });
    const err = await loadMemory(project).then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/"naming.collections" names "klingon".*built in: standard, none/);
  });
});
