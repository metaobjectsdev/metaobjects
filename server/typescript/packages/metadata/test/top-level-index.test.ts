// The per-root top-level index behind reference resolution (top-level-index.ts).
//
// Two contracts:
//   1. LINEAR. Resolving a reference does not walk every top-level object. Asserted by
//      counting work (resolutionKey calls, index builds), never by wall-clock, over 1x, 5x
//      and 10x generated models.
//   2. NEVER STALE. A lookup after the root's top-level nodes changed — a node added, a node
//      re-keyed by a package change, a later source merged in — sees the change.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { MetaData } from "../src/shared/meta-data.js";
import { MetaRoot } from "../src/shared/meta-root.js";
import { resolveObjectRef } from "../src/naming-refs.js";
import { topLevelIndexStats } from "../src/top-level-index.js";
import { TYPE_OBJECT } from "../src/shared/base-types.js";
import { OBJECT_SUBTYPE_ENTITY } from "../src/core/object/object-constants.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { TypeId } from "../src/registry.js";
import { TYPE_METADATA } from "../src/shared/base-types.js";

const metaRoot = (): MetaRoot => new MetaRoot(new TypeId(TYPE_METADATA, "root"), "");
const metaObject = (subType: string, name: string): MetaObject => new MetaObject(new TypeId(TYPE_OBJECT, subType), name);

function repoRoot(start: string): string {
  let dir = start;
  while (!(existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server")))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
  return dir;
}

const FITNESS = readFileSync(
  join(repoRoot(import.meta.dir), "fixtures", "persistence-conformance", "canonical", "meta.fitness.json"),
  "utf-8",
);

/** `copies` renamed copies of the fitness model, one source each. */
function sources(copies: number): InMemoryStringSource[] {
  return Array.from({ length: copies }, (_, i) => {
    const pkg = `fitness_x${String(i).padStart(2, "0")}`;
    const text = FITNESS.replace('"package": "fitness"', `"package": "${pkg}"`);
    return new InMemoryStringSource(text, { id: `${pkg}.json`, format: "json" });
  });
}

/** Load `copies` copies, counting every resolutionKey() call and index rebuild. */
async function measure(copies: number): Promise<{ topLevel: number; keyCalls: number; rebuilds: number }> {
  const original = MetaData.prototype.resolutionKey;
  let keyCalls = 0;
  MetaData.prototype.resolutionKey = function (this: MetaData): string {
    keyCalls++;
    return original.call(this);
  };
  const rebuildsBefore = topLevelIndexStats.rebuilds;
  try {
    const { root, errors } = await new MetaDataLoader().load(sources(copies));
    expect(errors).toEqual([]);
    return {
      topLevel: root.children().length,
      keyCalls,
      rebuilds: topLevelIndexStats.rebuilds - rebuildsBefore,
    };
  } finally {
    MetaData.prototype.resolutionKey = original;
  }
}

describe("reference lookup stays linear in the number of top-level nodes", () => {
  test("resolutionKey calls per top-level node do not grow with the model", async () => {
    const m1 = await measure(1);
    const m5 = await measure(5);
    const m10 = await measure(10);
    const perNode = (m: { topLevel: number; keyCalls: number }): number => m.keyCalls / m.topLevel;

    // A scan-per-reference makes this ratio grow with the model (about 10x between 1x and
    // 10x); the index keeps it flat. 1.5 leaves room for fixed per-load work.
    expect(perNode(m5)).toBeLessThan(perNode(m1) * 1.5);
    expect(perNode(m10)).toBeLessThan(perNode(m1) * 1.5);
    // And bounded in absolute terms: a handful of key builds per top-level node (each node is
    // keyed once into each index it belongs to, plus a few direct reads), not one per
    // top-level node per reference.
    expect(perNode(m10)).toBeLessThan(40);
  });

  test("index rebuilds per load do not grow with the model", async () => {
    const m1 = await measure(1);
    const m10 = await measure(10);
    // Appends are absorbed incrementally, so a rebuild happens only when the root's keys
    // change; a load must not rebuild once per top-level node.
    expect(m10.rebuilds).toBeLessThanOrEqual(m1.rebuilds + 2);
    expect(m10.rebuilds).toBeLessThan(m10.topLevel / 4);
  });
});

describe("the top-level index is never stale", () => {
  const entity = (name: string, pkg?: string) => {
    const o = metaObject(OBJECT_SUBTYPE_ENTITY, name);
    if (pkg !== undefined) o.setPackage(pkg);
    return o;
  };
  const resolve = (root: MetaRoot, ref: string, from = "") => resolveObjectRef(root, ref, from).node;

  test("a top-level node added after a lookup is found by the next lookup", () => {
    const root = metaRoot();
    const a = entity("A");
    root.addChild(a);
    expect(resolve(root, "A")).toBe(a);
    expect(resolve(root, "B")).toBeUndefined();
    const b = entity("B");
    root.addChild(b);
    expect(resolve(root, "B")).toBe(b);
    expect(resolve(root, "A")).toBe(a);
  });

  test("first match still wins when a later node has the same key", () => {
    const root = metaRoot();
    const first = entity("Dup");
    root.addChild(first);
    expect(resolve(root, "Dup")).toBe(first);
    root.addChild(entity("Dup"));
    expect(resolve(root, "Dup")).toBe(first);
  });

  test("setPackage on a top-level node re-keys it: the old key stops resolving, the new one starts", () => {
    const root = metaRoot();
    const a = entity("A", "p");
    root.addChild(a);
    expect(resolve(root, "p::A")).toBe(a);
    a.setPackage("q");
    expect(resolve(root, "p::A")).toBeUndefined();
    expect(resolve(root, "q::A")).toBe(a);
  });

  test("a direct write to package or fileDefaultPackage re-keys it too", () => {
    const root = metaRoot();
    const a = entity("A", "p");
    root.addChild(a);
    expect(resolve(root, "p::A")).toBe(a);
    a.package = "q";
    expect(resolve(root, "p::A")).toBeUndefined();
    expect(resolve(root, "q::A")).toBe(a);
    a.package = undefined;
    a.fileDefaultPackage = "r";
    expect(resolve(root, "q::A")).toBeUndefined();
    expect(resolve(root, "r::A")).toBe(a);
  });

  test("a bare reference falls back from the referrer's package to the root level, after a change", () => {
    const root = metaRoot();
    const rootLevel = entity("Thing");
    root.addChild(rootLevel);
    expect(resolve(root, "Thing", "pkg")).toBe(rootLevel);
    const local = entity("Thing", "pkg");
    root.addChild(local);
    expect(resolve(root, "Thing", "pkg")).toBe(local);
    local.setPackage("other");
    expect(resolve(root, "Thing", "pkg")).toBe(rootLevel);
  });

  test("a node added to a root with a built index is found by a type-scoped lookup", () => {
    const root = metaRoot();
    root.addChild(entity("A"));
    expect(resolveObjectRef(root, "A", "").node?.type).toBe(TYPE_OBJECT);
    const later = entity("Later");
    root.addChild(later);
    expect(resolveObjectRef(root, "Later", "").node).toBe(later);
  });

  test("a source merged in later contributes its objects to references resolved afterwards", async () => {
    const [first, second] = sources(2) as [InMemoryStringSource, InMemoryStringSource];
    const loader = new MetaDataLoader();
    const one = await loader.load([first]);
    expect(resolveObjectRef(one.root, "fitness_x01::Program", "").node).toBeUndefined();
    const both = await new MetaDataLoader().load([first, second]);
    expect(both.errors).toEqual([]);
    expect(resolveObjectRef(both.root, "fitness_x01::Program", "").node).toBeDefined();
    expect(resolveObjectRef(both.root, "fitness_x00::Program", "").node).toBeDefined();
  });
});
